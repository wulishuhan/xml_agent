const { BrowserChatProvider } = require("./browser-chat");
const { renderGlmMessage } = require("./dom/glm-message");
const { balanceMarkdownFences, extractXmlFromCandidate } = require("./markdown-fence-utils");

const GLM_CONVERSATION_PATTERN = new RegExp("/(?:c|s)/([0-9a-zA-Z-]+)");

const RESPONSE_SELECTOR = ".chat-assistant";

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
                const xmlFromDom = extractXmlFromCandidate(domText);

                if (xmlFromDom) {
                    return balanceMarkdownFences(xmlFromDom);
                }

                return balanceMarkdownFences(domText);
            }

            const message = messages.nth(index);
            const fiberCandidates = await this.extractFromReactFiber(message);

            for (const candidate of fiberCandidates) {
                const xml = extractXmlFromCandidate(candidate.value);

                if (xml) {
                    return balanceMarkdownFences(xml);
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
    extractXmlFromCandidate,
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
