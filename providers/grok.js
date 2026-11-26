/**
 * Grok（xAI）网页版 provider：https://grok.com
 *
 * 与其它网页聊天 provider 一样基于 BrowserChatProvider：
 * 基类负责会话 URL/ id、发送时序、响应轮询的通用骨架；本文件只声明
 * Grok 的平台差异 —— 访问地址、会话 id 正则、输入框/回复选择器、提交方式。
 *
 * 关于选择器：Grok 是 React SPA，class 名随版本变化，因此回复/输入框都用
 * 多重选择器兜底，并配合 fiber 提取（抓 React 内部完整文本）与 DOM 重建。
 * 这样即使某一两个 class 改了，仍能靠语义选择器 / data-testid 工作。
 *
 * 会话 URL：https://grok.com/c/<uuid>（也兼容旧 /chat/<id>、/share/c/<id>）。
 */

const { BrowserChatProvider } = require("./browser-chat");
const { renderGlmMessage } = require("./dom/glm-message");
const { collectChildFiberCandidate } = require("./dom/fiber");
const { hasActionEnvelope } = require("./action-tag");
const { balanceMarkdownFences, extractJsonActionCandidate } = require("./markdown-fence-utils");

/**
 * 会话 id 正则。
 * 主路径是 /c/<uuid>；Grok 历史上用过 /chat/<id> 与 /share/c/<id>，
 * 一并兼容，避免用户贴不同形状的链接时解析不到 id。
 * UUID 用宽松的 [0-9a-zA-Z-]+，既能吃标准 uuid 也能吃旧式短 id。
 */
const GROK_CONVERSATION_PATTERN = new RegExp(
    "/(?:c|chat|share/c)/([0-9a-zA-Z-]{6,})"
);

/**
 * 助手回复容器候选，按"越具体越靠前"排列。
 *
 * 真机（2026-11）实测：外层 `assistant-message` 容器含发送者名字"Grok"标题，
 * 正文在内部的 `.response-content-markdown` 里。若优先命中外层容器，会把
 * "## Grok" 一起提取进回复文本。因此把正文容器放到最前；extractOne 里还有
 * 一层下钻兜底，防止某些版本里 select 到的仍是外层容器。
 */
const RESPONSE_SELECTORS = [
    '[class*="response-content-markdown"]',
    '[data-testid*="assistant"]',
    '[data-testid*="response"]',
    '[data-message-role="assistant"]',
    ".message-assistant",
    ".assistant-message",
    ".grok-response",
];

/** 正文节点下钻候选：命中外层容器时，优先取里面的 markdown 正文。 */
const CONTENT_CHILD_SELECTORS = [
    '[class*="response-content-markdown"]',
    '[class*="markdown"]',
];

/** 回复容器兜底（更宽泛，最后用）。 */
const FALLBACK_RESPONSE_SELECTORS = [
    '[class*="assistant"]',
    '[class*="response"]',
];

/** 输入框候选。 */
const INPUT_SELECTORS = [
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Message"]',
    "textarea#input",
    "textarea",
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    "[contenteditable='true']",
    "[role='textbox']",
];

/** 发送按钮候选（回车未生效时兜底点击）。 */
const SEND_BUTTON_SELECTORS = [
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[data-testid*="send"]',
    'button[class*="send"]',
    'button[type="submit"]',
];

/**
 * 限额/风控文案：只收平台自己吐出的**强特征完整短语**，绝不收通用技术词。
 *
 * 踩过的坑：早期把 "rate limit" / "quota" / "usage limit" / "upgrade to"
 * 这类词做裸 includes，而检测范围是整页 innerText（含历史对话与回复正文）。
 * 用户讨论限流、配额、API 升级这些技术话题时，回复里必然出现这些词，于是：
 *   - deliverMessage 发送前检查命中 → 该会话此后永久无法发送消息；
 *   - collectResponse 哨兵命中 → 正常等待被抢占成"平台限额"错误。
 * 所以这里只保留几乎不可能出现在正常技术对话里的平台原文案。
 */
const QUOTA_PATTERNS = [
    "限额已达上限",
    "免费版限额",
    "免费额度已用完",
    "已达到使用上限",
    "daily limit reached",
    "daily quota exceeded",
    "you have reached your limit",
    "free plan limit",
];

const PROFILE = {
    targetUrl: "https://grok.com",
    conversationPathPrefix: "/c/",
    conversationIdPattern: GROK_CONVERSATION_PATTERN,
    pageUrlIncludes: "grok.com",
};

class GrokProvider extends BrowserChatProvider {
    constructor(options = {}) {
        super({
            ...options,
            profile: PROFILE,
            inputSelectors: INPUT_SELECTORS,
        });
    }

    get name() {
        return "Grok";
    }

    // ------------------------------------------------------------
    // 助手回复定位
    // ------------------------------------------------------------

    /** 取所有助手消息容器：先试精确选择器，再退到宽泛选择器。 */
    async getAssistantLocator() {
        if (!this.isPageAlive()) {
            return null;
        }
        for (const selector of RESPONSE_SELECTORS) {
            try {
                const locator = this.page.locator(selector);
                if ((await locator.count()) > 0) {
                    return locator;
                }
            } catch (error) {
                // 选择器不合法或页面抖动，换下一个
            }
        }
        for (const selector of FALLBACK_RESPONSE_SELECTORS) {
            try {
                const locator = this.page.locator(selector);
                if ((await locator.count()) > 0) {
                    return locator;
                }
            } catch (error) {
                // 同上
            }
        }
        return null;
    }

    async getAssistantCount() {
        const locator = await this.getAssistantLocator();
        if (!locator) {
            return 0;
        }
        try {
            return await locator.count();
        } catch (error) {
            return 0;
        }
    }

    /**
     * 从一条回复节点取文本：fiber（React 内部完整文本）优先，DOM 重建兜底。
     * 动作 envelope 用统一的 json-candidate 提取，和别的 provider 同一口径。
     */
    async extractOne(locator, index) {
        let target = locator.nth(index);
        const visible = await target.isVisible().catch(() => false);
        if (!visible) {
            return { text: "", hasAction: false };
        }

        // 若命中的是外层容器（含"Grok"发送者标题），下钻到 markdown 正文节点，
        // 避免把标题当成回复内容。下钻失败则保持原容器。
        for (const selector of CONTENT_CHILD_SELECTORS) {
            try {
                const child = target.locator(selector).first();
                if ((await child.count()) > 0 && (await child.isVisible())) {
                    const childText = (await child.innerText()).trim();
                    // 正文节点确实有内容才切换，避免切到空占位节点
                    if (childText) {
                        target = child;
                        break;
                    }
                }
            } catch (error) {
                // 下钻失败（节点非元素/选择器失效），保持原容器
            }
        }

        let fiberResult = null;
        try {
            fiberResult = await target.evaluate(collectChildFiberCandidate);
        } catch (error) {
            // fiber 失效是常态（页面重构 / 节点为非 React 元素），走 DOM 兜底
        }

        if (fiberResult && fiberResult.top && fiberResult.top.value) {
            const actionCandidate = fiberResult.candidates.find((c) => c.isAction);
            if (actionCandidate) {
                const jsonPart = extractJsonActionCandidate(actionCandidate.value);
                if (jsonPart) {
                    return { text: balanceMarkdownFences(jsonPart), hasAction: true };
                }
            }
            const fallback = String(fiberResult.top.value || "").trim();
            if (fallback && hasActionEnvelope(fallback)) {
                return { text: balanceMarkdownFences(fallback), hasAction: true };
            }
        }

        let rebuilt = "";
        try {
            rebuilt = await target.evaluate(renderGlmMessage);
        } catch (error) {
            // DOM 重建失败就返回空，交给合并逻辑处理
        }

        const normalized = (rebuilt || "")
            .replace(/\u00A0/g, " ")
            .replace(/\n{4,}/g, "\n\n\n")
            .trim();

        return {
            text: balanceMarkdownFences(normalized),
            hasAction: hasActionEnvelope(normalized),
        };
    }

    /** 取最后一条回复；最后一条没有动作时回溯合并最近几条，拼回被切碎的 envelope。 */
    async getLastResponse() {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            const locator = await this.getAssistantLocator();
            if (!locator) {
                return "";
            }
            const count = await locator.count();
            if (!count) {
                return "";
            }

            const lastIndex = count - 1;
            const last = await this.extractOne(locator, lastIndex);
            if (last.hasAction) {
                return last.text;
            }

            const backLimit = Math.min(count, 4);
            const parts = [];
            for (let i = count - backLimit; i < count; i++) {
                const item = await this.extractOne(locator, i);
                if (item.text && parts.indexOf(item.text) === -1) {
                    parts.push(item.text);
                }
            }
            const merged = parts.join("\n").trim();
            const jsonPart = extractJsonActionCandidate(merged);
            if (jsonPart) {
                return balanceMarkdownFences(jsonPart);
            }
            return last.text || "";
        } catch (error) {
            console.warn("[Grok] getLastResponse failed:", error.message);
            return "";
        }
    }

    // ------------------------------------------------------------
    // 提交
    // ------------------------------------------------------------

    async clickSendButton() {
        for (const selector of SEND_BUTTON_SELECTORS) {
            try {
                const button = this.page.locator(selector).first();
                if ((await button.count()) > 0 && (await button.isVisible())) {
                    await button.click({ timeout: 10000 });
                    return true;
                }
            } catch (error) {
                // 换下一个候选
            }
        }
        return false;
    }

    /**
     * 提交消息：输入框回车 → 发送按钮 → 再回车，每一步以"输入框清空"验收。
     * 三级都失败才抛错，避免"按钮点到但事件没接管"的假成功。
     */
    async deliverMessage() {
        // 注意：不在这里做限额检查。此前发送前调 assertNotRateLimited 的做法会误判——
        // 只要历史对话里出现过 "rate limit / quota" 这类词，会话就被永久锁死、无法再发送。
        // 限额的识别放在 collectResponse 的哨兵里（只针对本轮新出现的提示），更安全。

        const input = await this.findVisibleInput(this.inputSelectors, 3);
        if (!input) {
            throw new Error("Grok failed to send message: input not found");
        }

        try {
            await input.click({ timeout: 10000 });
            await input.press("Enter");
        } catch (error) {
            throw new Error("Grok failed to send message: " + error.message);
        }

        if (await this.waitForInputClear(4000)) {
            return;
        }

        if (await this.clickSendButton()) {
            if (await this.waitForInputClear(4000)) {
                return;
            }
        }

        try {
            await input.press("Enter");
        } catch (error) {
            // 落到统一报错
        }

        if (await this.waitForInputClear(4000)) {
            return;
        }

        throw new Error(
            "Grok failed to send message: composer still holds text after Enter and send-button attempts"
        );
    }

    /** 输入框未清空只记日志，不阻断等待（有些版本清空晚）。 */
    async afterDelivered() {
        const cleared = await this.waitForInputClear();
        if (!cleared) {
            console.warn("[Grok] Input did not clear within timeout, continuing...");
        }
    }

    /**
     * 检测页面是否出现限额/风控提示。命中时抛错，让上层立即停止等待并
     * 给用户一个明确原因，而不是把"额度用完了"误报成"没收到回复"。
     *
     * 匹配只针对 QUOTA_PATTERNS 里的平台强特征原文，且优先读专用提示区
     * （role=alert / 含 limit、quota 的横幅），避免历史对话正文干扰。
     */
    async assertNotRateLimited() {
        if (!this.isPageAlive()) {
            return;
        }
        let text = "";
        try {
            text = await this.page.evaluate(() => {
                // 优先取平台自己的限额提示条；这些元素与对话正文分离。
                const selectors = [
                    '[role="alert"]',
                    '[data-testid*="limit"]',
                    '[data-testid*="quota"]',
                    '[class*="limit-reached"]',
                    '[class*="quota-notice"]',
                ];
                const parts = [];
                for (const selector of selectors) {
                    for (const el of document.querySelectorAll(selector)) {
                        const inner = el.innerText || el.textContent || "";
                        if (inner && inner.length < 500) {
                            parts.push(inner);
                        }
                    }
                }
                // 没有专用提示区时回退到整页；强特征短语本身不会误判正常技术对话。
                return parts.join("\n") || (document.body ? document.body.innerText || "" : "");
            });
        } catch (error) {
            return; // 页面抖动，交给正常等待逻辑
        }
        const lower = String(text || "").toLowerCase();
        for (const pattern of QUOTA_PATTERNS) {
            if (lower.includes(pattern.toLowerCase())) {
                throw new Error(
                    "[Grok] 平台限额/风控已触发（页面提示：" +
                        pattern +
                        "）。消息已发出但平台不再生成回复；请等待额度重置或升级账号，" +
                        "并降低会话频率后重试。"
                );
            }
        }
    }

    /**
     * 等回复开始后，用文本稳定判定收尾。
     * 额外叠一层限流监听：一旦页面出现限额提示，立即中断等待并报错。
     */
    async collectResponse(before) {
        const waitPromise = (async () => {
            await this.waitForResponseStart(before.count, before.text);
            return this.waitForFinalResponse(() => this.getLastResponse());
        })();

        // 限流哨兵：每 2 秒查一次页面文案，命中则抢占式抛错。
        // 正常回复到达时清理定时器，避免哨兵在后续步骤误触发。
        let timer = null;
        const quotaPromise = new Promise((_, reject) => {
            timer = setInterval(async () => {
                try {
                    await this.assertNotRateLimited();
                } catch (error) {
                    reject(error);
                }
            }, 2000);
        });

        try {
            return await Promise.race([waitPromise, quotaPromise]);
        } finally {
            if (timer) {
                clearInterval(timer);
            }
        }
    }
}

module.exports = {
    GrokProvider,
    GROK_CONVERSATION_PATTERN,
    meta: {
        id: "grok",
        label: "Grok",
        defaultTargetUrl: "https://grok.com",
        conversationIdPattern: GROK_CONVERSATION_PATTERN,
        supportsImages: true,
        create: (options) => new GrokProvider(options),
    },
};
