const { BrowserChatProvider } = require("./browser-chat");
const { renderGlmMessage } = require("./dom/glm-message");
const { collectChildFiberCandidate } = require("./dom/fiber");
const { hasActionEnvelope } = require("./action-tag");
const { balanceMarkdownFences, extractJsonActionCandidate } = require("./markdown-fence-utils");

const GLM_CONVERSATION_PATTERN = new RegExp("/(?:c|s)/([0-9a-zA-Z-]+)");

const RESPONSE_SELECTOR = ".chat-assistant";

/**
 * 识别被误挂到 React children 上的 Tailwind className 串。
 * 这些串是按钮/图标的样式类名，不是模型正文；典型特征是多个短横线类名
 * 加 hover:/focus: 变体，且不含中日韩文字。
 */
function isTailwindClassNoise(value) {
    if (/[\u3400-\u9fff]/.test(value)) {
        return false;
    }
    const tokens = value.trim().split(/\s+/);
    if (tokens.length < 5 || value.length < 40) {
        return false;
    }
    const utilitySignals = [
        /^(?:hover|focus|active|dark|sm|md|lg|xl):/,
        /^(?:bg|text|border|rounded|shadow|gap|px|py|pt|pb|mt|mb|min-h|min-w|h|w|flex|justify|items|opacity)-/,
        /^focus-ring$/,
    ];
    const hits = tokens.filter((token) =>
        utilitySignals.some((re) => re.test(token))
    ).length;
    return hits >= 3;
}

/**
 * 识别 z.ai 消息节点上挂载的 CSS / 样式噪声。
 *
 * 新版 z.ai 用内联 <style> 字符串驱动 thinking/loading 动画，这些字符串
 * 以 React children prop 的形式出现在消息子树里。特征很明确：
 * CSS 选择器/规则块（`.x{...}`、`@keyframes`、`--var:`）配 `px`/`animation:` 等声明，
 * 且不含任何 JSON Action envelope。命中就当噪声丢掉，避免污染正文提取。
 *
 * @param {string} value
 * @returns {boolean}
 */
function isStyleNoise(value) {
    if (typeof value !== "string") {
        return false;
    }
    // 真正的回复会带 Action envelope，带动作的一律不当噪声
    if (hasActionEnvelope(value)) {
        return false;
    }
    // z.ai 还会把按钮的 Tailwind className 作为 children prop 挂上来，
    // 例如 "focus-ring h-auto ... hover:text-text-secondary"。它不含 CSS 规则块，
    // 原 cssSignals 抓不到，但会被 fiber 候选当成正文返回。
    if (isTailwindClassNoise(value)) {
        return true;
    }
    const cssSignals = [
        /@keyframes\b/,
        /animation\s*:/,
        /--[\w-]+\s*:/, // CSS 自定义属性
        /\{\s*[\w-]+\s*:[^}]+\}/, // 规则块 .x { prop: value }
        /prefers-reduced-motion/,
        /transform-origin\s*:/,
    ];
    const hits = cssSignals.reduce((n, re) => n + (re.test(value) ? 1 : 0), 0);
    return hits >= 2;
}

const PROFILE = {
    targetUrl: "https://zchat.z.ai",
    // GLM 的会话地址同时存在 /c/<id> 与 /s/<id> 两种写法，新建会话统一用 /s/。
    conversationPathPrefix: "/s/",
    conversationIdPattern: GLM_CONVERSATION_PATTERN,
    pageUrlIncludes: "chat.z.ai",
};

class GlmProvider extends BrowserChatProvider {
    constructor(options = {}) {
        super({
            ...options,
            profile: PROFILE,
            inputSelectors: [
                "#chat-input",
                "textarea#chat-input",
                "div[contenteditable='true']",
                "[contenteditable='true']",
                "[role='textbox']",
                "textarea",
            ],
        });

        // 最近一次 DOM 重建结果（短缓存），避免轮询时反复滚动长代码块
        this._domTextCache = null;
    }

    get name() {
        return "GLM";
    }

    async getAssistantMessages() {
        if (!this.isPageAlive()) {
            return null;
        }

        try {
            return this.page.locator(RESPONSE_SELECTOR);
        } catch (error) {
            return null;
        }
    }

    async getAssistantCount() {
        const messages = await this.getAssistantMessages();

        if (!messages) {
            return 0;
        }

        try {
            return await messages.count();
        } catch (error) {
            return 0;
        }
    }

    /**
    GLM（Svelte）会复用 DOM 元素而不是新建节点，
    所以稳定键 = 下标 + 文本摘要，复用发生时键会跟着变。
    */
    async getAssistantMessageKeys() {
        if (!this.isPageAlive()) {
            return [];
        }

        try {
            const messages = this.page.locator(RESPONSE_SELECTOR);
            return await messages.evaluateAll((elements) =>
                elements.map((element, index) => {
                    const text = (element.textContent || "").trim();
                    const hash = text.length + ":" + text.substring(0, 100);
                    return "glm:" + index + ":" + hash;
                })
            );
        } catch (error) {
            return [];
        }
    }

    async getAssistantIndexByKey(key) {
        if (!key || !key.startsWith("glm:")) {
            return -1;
        }

        try {
            const parts = key.split(":");
            const index = parseInt(parts[1], 10);

            if (isNaN(index) || index < 0) {
                return -1;
            }

            const messages = this.page.locator(RESPONSE_SELECTOR);
            const count = await messages.count();

            if (index >= count) {
                return -1;
            }

            return index;
        } catch (error) {
            // -1 的语义是"定位不到这条回复"，上层会退化成读最后一条。
            // 但如果是选择器/页面本身出错，退化会读到别人的回复，所以必须留痕。
            console.warn("[GLM] failed to locate assistant message by key: " + error.message);
        }

        return -1;
    }

    async buildFromDom(index) {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            const messages = this.page.locator(RESPONSE_SELECTOR);
            const count = await messages.count();

            if (index < 0 || index >= count) {
                return "";
            }

            // 一次 DOM 重建要遍历整条消息（长代码可达几百行），成本不低。
            // 轮询间隔通常 1 秒，这里做 1.5 秒的短缓存：
            // 既避免每轮都重建，又不会让"内容未变"的窗口盖过稳定判定（4 秒）。
            const now = Date.now();
            const cached = this._domTextCache;

            if (cached && cached.index === index && now - cached.at < 1500) {
                return cached.text;
            }

            // 重建逻辑放在 dom/glm-message.js：一是自包含、可序列化进页面，
            // 二是能脱浏览器做单测（GLM 的代码块是 CodeMirror，不在 <pre> 里）。
            const text = await messages.nth(index).evaluate(renderGlmMessage);
            const result = balanceMarkdownFences(text || "");

            this._domTextCache = { index, at: now, text: result };

            return result;
        } catch (error) {
            return "";
        }
    }

    /**
    GLM 深度思考时，正文一直是空的（内容还在折叠块里）。
    这里把折叠块与工具轨迹的文本当作"活动签名"：内容在增长就说明模型还在工作，
    空回复计时会随之重置，避免把正常的长思考误判成失败。
    */
    async getPendingSignature(key) {
        if (!this.isPageAlive()) {
            return "";
        }

        const index = await this.getAssistantIndexByKey(key);

        if (index < 0) {
            return "";
        }

        try {
            const message = this.page.locator(RESPONSE_SELECTOR).nth(index);

            return await message.evaluate((element) => {
                const parts = [];

                [".thinking-chain-container", ".toolCallTrace"].forEach((selector) => {
                    const node = element.querySelector(selector);

                    if (node) {
                        parts.push((node.textContent || "").replace(/\s+/g, ""));
                    }
                });

                const text = parts.join("|");

                return text.length + ":" + text.slice(-40);
            });
        } catch (error) {
            return "";
        }
    }

    /**
     * 覆盖基类的三向 BFS 兜底。
     *
     * 基类 collectFiberCandidates 会沿 sibling / return 跨出当前回复节点，
     * 爬到相邻的用户消息上——z.ai 里用户 prompt 也带 Action 示例，
     * 于是"回复正文还没生成（DOM 重建为空）"时会把用户 prompt 当成本次回复抓回来，
     * 表现为解析层收到多个 envelope。
     * Qwen 早就因同样的问题收窄成只向下遍历，这里保持一致。
     */
    async extractFromReactFiber(elementHandle) {
        try {
            const result = await elementHandle.evaluate(collectChildFiberCandidate);
            if (!result || !Array.isArray(result.candidates)) {
                return [];
            }
            // z.ai 把 loading 动画的内联 CSS 作为 React 组件的 children prop
            // 挂在消息节点上。它长度动辄几百字符、又不含任何 Action envelope，
            // 会被 collectChildFiberCandidate 当成正文候选（key=children）。
            // 这种样式噪声一旦被 extractOne 返回，解析层就会拿到 CSS 报错。
            const candidates = result.candidates.filter((c) => !isStyleNoise(c && c.value));
            return candidates;
        } catch (error) {
            return [];
        }
    }

    async extractOne(index) {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            const messages = this.page.locator(RESPONSE_SELECTOR);
            const count = await messages.count();

            if (index < 0 || index >= count) {
                return "";
            }

            // 优先 DOM 重建：fiber 上可能还是上一次渲染的数据
            const domText = await this.buildFromDom(index);

            if (domText && domText.trim()) {
                const jsonFromDom = extractJsonActionCandidate(domText);

                if (jsonFromDom) {
                    return balanceMarkdownFences(jsonFromDom);
                }

                return balanceMarkdownFences(domText);
            }

            const message = messages.nth(index);
            const fiberCandidates = await this.extractFromReactFiber(message);

            for (const candidate of fiberCandidates) {
                const json = extractJsonActionCandidate(candidate.value);

                if (json) {
                    return balanceMarkdownFences(json);
                }
            }

            for (const candidate of fiberCandidates) {
                if (candidate.value && candidate.value.length >= 40) {
                    return balanceMarkdownFences(candidate.value);
                }
            }

            return "";
        } catch (error) {
            return "";
        }
    }

    async getLastResponse() {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            const messages = this.page.locator(RESPONSE_SELECTOR);
            const count = await messages.count();

            if (!count) {
                return "";
            }

            return this.extractOne(count - 1);
        } catch (error) {
            return "";
        }
    }

    /**
    元素复用检测：条数没变但最后一条的摘要变了，说明这条消息被原地改写。
    */
    async detectReusedResponseKey(oldKeys, currentKeys) {
        if (currentKeys.length !== oldKeys.length) {
            return null;
        }

        const lastOldKey = oldKeys[oldKeys.length - 1];
        const lastNewKey = currentKeys[currentKeys.length - 1];

        if (!lastOldKey || !lastNewKey || lastOldKey === lastNewKey) {
            return null;
        }

        const response = await this.getResponseByKey(lastNewKey);

        return response && response.trim() ? lastNewKey : null;
    }

    // ------------------------------------------------------------
    // 发送钩子
    // ------------------------------------------------------------

    async captureResponseSnapshot() {
        const keys = await this.getAssistantMessageKeys();
        return {
            keys,
            count: keys.length,
            text: await this.getLastResponse(),
        };
    }

    /** 三级降级提交：发送按钮 → 键盘回车 → 输入元素回车。 */
    async deliverMessage() {
        let sent = false;
        let sendError = null;

        try {
            const sendButton = this.page.locator("#send-message-button").first();

            if (
                (await sendButton.count()) > 0 &&
                (await sendButton.isVisible()) &&
                !(await sendButton.isDisabled().catch(() => false))
            ) {
                await sendButton.click();
                sent = true;
            }
        } catch (error) {
            sendError = error;
        }

        if (!sent) {
            try {
                await this.page.keyboard.press("Enter");
                sent = true;
            } catch (error) {
                sendError = error;
            }
        }

        if (!sent) {
            const input = await this.findVisibleInput(this.inputSelectors);

            if (input) {
                try {
                    await input.press("Enter");
                    sent = true;
                } catch (error) {
                    sendError = error;
                }
            }
        }

        if (!sent) {
            throw new Error(
                "GLM failed to send message: " + (sendError ? sendError.message : "unknown error")
            );
        }
    }

    /**
    先按稳定键定位新回复；键检测失败时退回"条数/文本变化"判定，
    再从键列表里找出与发送前不同的那一条。
    */
    async collectResponse(before) {
        const oldKeys = before.keys || [];
        let activeResponseKey = null;

        try {
            activeResponseKey = await this.waitForNewResponseKey(oldKeys);
        } catch (error) {
            // "回复挂出来了但一直是空的"不能降级：再等一轮只会白耗一个超时。
            if (this.isEmptyResponseError(error)) {
                throw error;
            }

            await this.waitForResponseStart(before.count, before.text);

            const keys = await this.getAssistantMessageKeys();

            for (let i = 0; i < keys.length; i++) {
                if (i >= oldKeys.length || keys[i] !== oldKeys[i]) {
                    activeResponseKey = keys[i];
                    break;
                }
            }

            if (!activeResponseKey && keys.length > 0) {
                activeResponseKey = keys[keys.length - 1];
            }
        }

        return this.waitForFinalResponse(() => {
            if (!activeResponseKey) {
                return this.getLastResponse();
            }

            return this.getResponseByKey(activeResponseKey);
        });
    }

    /**
    GLM 的输入框可能是 contenteditable 的 div，也可能是 textarea。
    textarea 必须走原生 value setter 再派发 input 事件，
    否则框架（Svelte）不会把值同步进状态，发送按钮会一直是禁用态。
    */
    async insertMessage(message) {
        if (!message || !message.trim()) {
            throw new Error("[GLM] message cannot be empty");
        }

        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            const input = await this.findVisibleInput(this.inputSelectors);

            if (!input) {
                await this.sleep(300);
                continue;
            }

            try {
                await input.click({ timeout: 3000 }).catch(() => input.focus({ timeout: 3000 }));

                const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
                const isContentEditable = await input.evaluate((el) => el.isContentEditable);

                if (isContentEditable || tagName === "div") {
                    await input.evaluate((el, msg) => {
                        el.focus();
                        el.textContent = msg;
                        el.dispatchEvent(
                            new InputEvent("input", {
                                bubbles: true,
                                inputType: "insertText",
                                data: msg,
                            })
                        );
                    }, message);
                } else {
                    await input.evaluate((el, msg) => {
                        const setter = Object.getOwnPropertyDescriptor(
                            HTMLTextAreaElement.prototype,
                            "value"
                        ).set;

                        setter.call(el, msg);
                        el.dispatchEvent(
                            new InputEvent("input", {
                                bubbles: true,
                                cancelable: true,
                                inputType: "insertText",
                                data: msg,
                            })
                        );
                    }, message);
                }

                await this.sleep(300);

                const actualValue = await this.getInputValue(input);

                if (actualValue && actualValue.trim()) {
                    return true;
                }

                lastError = new Error("[GLM] input value is empty after insertion");
            } catch (error) {
                lastError = error;
                this._cachedInput = null;
                await this.sleep(300);
            }
        }

        throw new Error(
            "[GLM] failed to insert message: " + (lastError ? lastError.message : "input not found")
        );
    }
}

module.exports = {
    GlmProvider,
    balanceMarkdownFences,
    extractJsonActionCandidate,
    isStyleNoise,
    // provider 元数据：注册表据此创建实例、解析访问地址与会话 id。
    // 注意 GLM 的会话 URL 同时存在 /c/<id> 与 /s/<id> 两种写法。
    meta: {
        id: "glm",
        label: "GLM",
        defaultTargetUrl: "https://zchat.z.ai",
        conversationIdPattern: GLM_CONVERSATION_PATTERN,
        supportsImages: true,
        create: (options) => new GlmProvider(options),
    },
};
