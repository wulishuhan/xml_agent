const { BrowserChatProvider } = require("./browser-chat");
const { containsActionTag } = require("./action-tag");
const { balanceMarkdownFences, extractXmlFromCandidate } = require("./markdown-fence-utils");
const { collectChildFiberCandidate } = require("./dom/fiber");

const QWEN_CONVERSATION_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");

const RESPONSE_SELECTOR = ".response-message-content";
const FALLBACK_RESPONSE_SELECTOR = ".qwen-markdown-html";

// 点按式提交的兜底按钮。回车不生效时用它把消息送出去。
const SEND_BUTTON_SELECTORS = [
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[class*="send"]',
    'button[type="submit"]',
];

const PROFILE = {
    targetUrl: "https://chat.qwen.ai",
    conversationPathPrefix: "/c/",
    conversationIdPattern: QWEN_CONVERSATION_PATTERN,
    pageUrlIncludes: "chat.qwen.ai",
};

class QwenProvider extends BrowserChatProvider {
    constructor(options = {}) {
        super({
            ...options,
            profile: PROFILE,
            inputSelectors: [
                ".message-input-textarea",
                'div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"]',
                '[contenteditable="true"]',
                "[role='textbox']",
                "#prompt-textarea",
                "textarea",
            ],
        });
    }

    get name() {
        return "Qwen";
    }

    async getAssistantCount() {
        if (!this.isPageAlive()) return 0;
        try {
            return await this.page.locator(RESPONSE_SELECTOR).count();
        } catch (error) {
            return 0;
        }
    }

    /**
    Qwen 用"发送按钮 vs 停止按钮"的可见性表达生成状态，
    这比"文本是否变化"更早、也更准地反映"开始了/结束了"。
    */
    async getGenerationState() {
        if (!this.isPageAlive()) {
            return { generating: false, sendVisible: false, stopVisible: false };
        }

        try {
            return await this.page.evaluate(() => {
                const sendBtn = document.querySelector("[aria-label='发送']");
                const stopBtn =
                    document.querySelector("[aria-label='停止']") ||
                    document.querySelector("[aria-label='Stop']");

                function isVisible(el) {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (style.display === "none" || style.visibility === "hidden") return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                }

                return {
                    sendExists: !!sendBtn,
                    stopExists: !!stopBtn,
                    sendVisible: isVisible(sendBtn),
                    stopVisible: isVisible(stopBtn),
                    generating: isVisible(stopBtn) && !isVisible(sendBtn),
                };
            });
        } catch (error) {
            return { generating: false, sendVisible: false, stopVisible: false };
        }
    }

    /**
    等待生成结束：先用按钮状态判定"已开始/已结束"，按钮状态拿不到时退回文本稳定判定。
    */
    async waitForGenerationComplete(getResponse, options) {
        options = options || {};

        const startTimeout = options.startTimeout || 60000;
        const finishTimeout = options.finishTimeout || this.responseTimeout;
        const pollInterval = options.pollInterval || this.responsePollInterval;
        const stableTime = options.stableTime || this.responseStableTime;

        const stableFallback = () =>
            this.waitForStableResponse(getResponse, {
                timeout: finishTimeout,
                stableTime,
                pollInterval,
            });

        const start = Date.now();
        let started = false;
        let lastPollError = null;

        while (Date.now() - start < startTimeout) {
            if (!this.isPageAlive()) {
                throw new Error("[Qwen] page was closed while waiting for generation start");
            }

            const state = await this.getGenerationState();

            if (state.stopVisible) {
                started = true;
                break;
            }

            try {
                const text = await getResponse();
                if (text && text.trim()) {
                    started = true;
                    break;
                }
            } catch (error) {
                // 轮询期间读不到是常态（页面还没挂出回复气泡）；
                // 记下来，超时走兜底时至少能说明"是一直报错还是一直为空"。
                lastPollError = error;
            }

            await this.sleep(pollInterval);
        }

        if (!started) {
            if (lastPollError) {
                console.warn(
                    "[Qwen] no generation start signal, polling errors: " + lastPollError.message
                );
            }
            return await stableFallback();
        }

        const finishStart = Date.now();
        let sawStopVisible = true;
        let lastState = null;

        while (Date.now() - finishStart < finishTimeout) {
            if (!this.isPageAlive()) {
                throw new Error("[Qwen] page was closed while waiting for generation finish");
            }

            const state = await this.getGenerationState();
            lastState = state;

            if (state.stopVisible) sawStopVisible = true;

            if (sawStopVisible && !state.stopVisible && state.sendVisible) break;

            await this.sleep(pollInterval);
        }

        if (!lastState || lastState.stopVisible) {
            return await stableFallback();
        }

        return await stableFallback();
    }

    async buildFromDom(lastLocator) {
        return await lastLocator.evaluate((element) => {
            const clone = element.cloneNode(true);

            clone
                .querySelectorAll(".qwen-markdown-code-header-wrapper, .qwen-markdown-code-header")
                .forEach((el) => el.remove());

            clone.querySelectorAll(".margin-view-overlays").forEach((el) => el.remove());

            function rebuild(node) {
                if (!node) return "";
                if (node.nodeType === 3) return node.textContent || "";
                if (node.nodeType !== 1) return "";

                const tag = (node.tagName || "").toLowerCase();

                if (tag === "pre") {
                    const fence = String.fromCharCode(96, 96, 96);
                    const viewLines = node.querySelectorAll(".view-line");
                    let codeText = "";
                    if (viewLines.length > 0) {
                        const arr = [];
                        viewLines.forEach((l) => arr.push(l.textContent || ""));
                        codeText = arr.join("\n");
                    } else {
                        codeText = node.textContent || "";
                    }
                    return "\n" + fence + "\n" + codeText + "\n" + fence + "\n";
                }

                if (tag === "h1") return "\n# " + (node.textContent || "") + "\n";
                if (tag === "h2") return "\n## " + (node.textContent || "") + "\n";
                if (tag === "h3") return "\n### " + (node.textContent || "") + "\n";
                if (tag === "strong" || tag === "b") {
                    const star = String.fromCharCode(42, 42);
                    return star + (node.textContent || "") + star;
                }
                if (tag === "em" || tag === "i") {
                    const star = String.fromCharCode(42);
                    return star + (node.textContent || "") + star;
                }
                if (tag === "code") {
                    if (node.closest && node.closest("pre")) return node.textContent || "";
                    const tick = String.fromCharCode(96);
                    return tick + (node.textContent || "") + tick;
                }
                if (tag === "br") return "\n";

                let out = "";
                for (let i = 0; i < node.childNodes.length; i++) {
                    out += rebuild(node.childNodes[i]);
                }
                return out;
            }

            let out = "";
            for (let i = 0; i < clone.childNodes.length; i++) {
                out += rebuild(clone.childNodes[i]);
            }
            return out;
        });
    }

    /**
    取第 index 条回复：DOM 重建优先，fiber 兜底。
    fiber 用的是"只向下"的窄遍历 —— 三向遍历会爬到上一条消息甚至用户 prompt 上。
    */
    async extractOne(index, totalCount) {
        const messages = this.page.locator(RESPONSE_SELECTOR);
        const target = messages.nth(index);

        const visible = await target.isVisible().catch(() => false);
        if (!visible) {
            return { text: "", fromFiber: false, hasAction: false };
        }

        let fiberResult = null;
        try {
            fiberResult = await target.evaluate(collectChildFiberCandidate);
        } catch (error) {
            console.warn("[Qwen] fiber extraction failed:", error.message);
        }

        if (fiberResult && fiberResult.top && fiberResult.top.value) {
            const actionCandidate = fiberResult.candidates.find((c) => c.isAction);

            if (actionCandidate) {
                const xmlPart = extractXmlFromCandidate(actionCandidate.value);
                if (xmlPart) {
                    return {
                        text: balanceMarkdownFences(xmlPart),
                        fromFiber: true,
                        hasAction: true,
                    };
                }
            }

            const fallbackCandidate = fiberResult.top;
            return {
                text: String(fallbackCandidate.value || "").trim(),
                fromFiber: true,
                hasAction: false,
            };
        }

        const rebuilt = await this.buildFromDom(target);
        const normalized = (rebuilt || "")
            .replace(/\u00A0/g, " ")
            .replace(/\n{4,}/g, "\n\n\n")
            .trim();

        return {
            text: balanceMarkdownFences(normalized),
            fromFiber: false,
            hasAction: containsActionTag(normalized),
        };
    }

    /**
    获取最后一条 assistant 回复。

    最后一条能提取到 Action 就直接返回；否则回溯最近几条合并
    —— 长输出被拆成多条消息时，单个节点里看不到完整 XML。
    */
    async getLastResponse() {
        if (!this.isPageAlive()) return "";

        try {
            let messages = this.page.locator(RESPONSE_SELECTOR);
            let count = await messages.count();

            if (!count) {
                messages = this.page.locator(FALLBACK_RESPONSE_SELECTOR);
                count = await messages.count();
            }

            if (!count) return "";

            const lastIndex = count - 1;
            const last = await this.extractOne(lastIndex, count);

            if (last.hasAction) {
                return last.text;
            }

            const backLimit = Math.min(count, 4);
            const parts = [];
            // 合并相邻消息是为了拼回被切碎的代码块；某一段读失败会直接
            // 让合并结果缺一块（XML 闭合标签可能正好缺在那里），必须留痕。
            const failed = [];

            for (let i = count - backLimit; i < count; i++) {
                if (i === lastIndex) {
                    if (last.text) parts.push(last.text);
                    continue;
                }

                try {
                    const item = await this.extractOne(i, count);
                    if (item.text) parts.push(item.text);
                } catch (error) {
                    failed.push(i + ": " + error.message);
                }
            }

            if (failed.length) {
                console.warn(
                    "[Qwen] merged response is incomplete, failed segments: " + failed.join("; ")
                );
            }

            const merged = parts.join("\n").trim();

            if (containsActionTag(merged)) {
                const xmlPart = extractXmlFromCandidate(merged);
                if (xmlPart) {
                    return balanceMarkdownFences(xmlPart);
                }
            }

            return last.text || "";
        } catch (error) {
            console.warn("[Qwen] getLastResponse failed:", error.message);
            return "";
        }
    }

    /** Qwen 只有输入元素回车这一条提交路径。 */
    async deliverMessage() {
        // Qwen 的输入区需要一次真实鼠标点击才会接管键盘：仅 focus() 后按 Enter
        // 在当前版本不会触发发送（输入框内容会原样保留）。所以这里显式点击再回车。
        const input = await this.findVisibleInput(this.inputSelectors, 3);
        if (!input) {
            throw new Error("Qwen failed to send message: input not found before pressing Enter");
        }
        try {
            await input.click();
            await input.press("Enter");
        } catch (error) {
            throw new Error("Qwen failed to send message: " + error.message);
        }
        // 回车仍无效时退回点击发送按钮，避免整个任务卡在"输入框未清空"。
        if (await this.waitForInputClear(3000)) {
            return;
        }
        if (!(await this.clickSendButton())) {
            throw new Error(
                "Qwen failed to send message: Enter did not submit and no send button matched"
            );
        }
    }

    /**
    点击发送按钮。返回是否成功点中，便于调用方决定是否报错。
    */
    async clickSendButton() {
        for (const selector of SEND_BUTTON_SELECTORS) {
            try {
                const button = this.page.locator(selector).first();
                if ((await button.count()) > 0 && (await button.isVisible())) {
                    await button.click();
                    return true;
                }
            } catch (error) {
                // 选择器没命中或按钮被遮挡，换下一个
            }
        }
        return false;
    }

    /** 输入框未清空只记日志：Qwen 有时保留输入内容但已经发出去了。 */
    async afterDelivered() {
        const cleared = await this.waitForInputClear();
        if (!cleared) {
            console.warn("[Qwen] Input did not clear within timeout, continuing...");
        }
    }

    /** 先确认响应开始，再用按钮状态等待生成结束。 */
    async collectResponse(before) {
        await this.waitForResponseStart(before.count, before.text);

        return this.waitForGenerationComplete(() => this.getLastResponse(), {
            startTimeout: 60000,
            finishTimeout: this.responseTimeout,
            pollInterval: this.responsePollInterval,
            stableTime: this.responseStableTime,
        });
    }
}

module.exports = {
    QwenProvider,
    balanceMarkdownFences,
    extractXmlFromCandidate,
    // provider 元数据：注册表据此创建实例、解析访问地址与会话 id。
    meta: {
        id: "qwen",
        label: "Qwen",
        defaultTargetUrl: "https://chat.qwen.ai",
        conversationIdPattern: QWEN_CONVERSATION_PATTERN,
        supportsImages: true,
        create: (options) => new QwenProvider(options),
    },
};
