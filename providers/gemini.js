const { BrowserChatProvider } = require("./browser-chat");
const { renderGeminiMessage } = require("./dom/gemini-message");
const { balanceMarkdownFences, extractXmlFromCandidate } = require("./markdown-fence-utils");

// 会话地址：https://gemini.google.com/app/<id>
// id 目前是 16 位十六进制，但官方改过一次格式，所以放宽到 8 位以上字母数字。
const GEMINI_CONVERSATION_PATTERN = new RegExp("/app/([0-9a-zA-Z_-]{8,})");

// 每条助手回复都渲染成一个 <model-response> 自定义元素
const RESPONSE_SELECTOR = "model-response";

const PROFILE = {
    // 只写到站点根：新会话由站点自己跳到 /app，
    // 续接会话时 buildTargetUrl 会拼成 base + /app/ + id。
    targetUrl: "https://gemini.google.com",
    conversationPathPrefix: "/app/",
    conversationIdPattern: GEMINI_CONVERSATION_PATTERN,
    pageUrlIncludes: "gemini.google.com",
};

class GeminiProvider extends BrowserChatProvider {
    constructor(options = {}) {
        super({
            ...options,
            profile: PROFILE,
            inputSelectors: [
                // Quill 的编辑区才是真正的输入框（rich-textarea 只是外层壳）。
                // 注意不能带 [contenteditable='true'] 约束：水合过程中该属性会短暂缺失。
                "rich-textarea .ql-editor",
                ".ql-editor[contenteditable='true']",
                ".ql-editor",
                "div[contenteditable='true'][role='textbox']",
                "div[contenteditable='true']",
                // 页面刚加载（Angular 还没水合完）时只有这个骨架 textarea
                "textarea",
            ],
        });

        // 最近一次 DOM 重建结果（短缓存），避免轮询时反复遍历同一条长回复
        this._domTextCache = null;

        // 发送按钮：Gemini 用 .send-button，文案随界面语言变化（发送 / Send）
        this.sendButtonSelectors = [
            "button.send-button",
            'button[aria-label*="Send"]',
            'button[aria-label*="发送"]',
            'button:has(mat-icon[fonticon="send"])',
        ];

        // 上传按钮：输入框左侧的 "+"
        this.uploadButtonSelectors = [
            'button[aria-label*="上传"]',
            'button[aria-label*="Upload"]',
            'button[aria-label*="添加文件"]',
            'button[aria-label*="Add files"]',
            'input[type="file"]',
        ];
    }

    get name() {
        return "Gemini";
    }

    /**
    Gemini 的聊天渲染器把裸 XML 当成富文本处理：`<answer>收到</answer>` 渲染后
    DOM 里只剩 `收到`，标签被 Angular 的 sanitizer 整块删掉（实测 innerHTML 只剩 <p><span>）。
    也就是说模型写了动作，Agent 却永远收不到 —— 这个平台上"裸 XML"是不可用的。

    唯一稳定的载体是代码块：`<pre><code>` 里的尖括号是文本节点，会原样保留，
    解析层的去围栏逻辑本来就会处理 ```xml 这种写法。

    所以这里声明一条平台级输出约束，由 prompts/first-prompt.js 拼进首轮提示词。
    */
    getActionMarkupHint() {
        return [
            "本平台会丢弃裸的 XML 标签：直接把 <answer>、<read/> 这类标签写在正文里，",
            "页面渲染后标签会消失，Agent 收不到你的动作。",
            "因此**每一个 XML Action 都必须放进代码块里输出**，例如：",
            "",
            "```xml",
            '<read path="package.json"/>',
            "```",
            "",
            "说明：",
            "- 代码块里的内容会原样保留；多个动作可以放在同一个代码块里。",
            "- 这条只约束 XML Action 的写法，<write> 的内容仍然按协议放在 CDATA 中。",
            "- 不要在代码块之外输出任何裸标签。",
        ].join("\n");
    }

    // ------------------------------------------------------------
    // 回复定位
    // ------------------------------------------------------------

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
    稳定键 = 下标 + 文本摘要。
    Gemini 的 Angular 视图会原地重建消息内容，键随文本变化，
    于是"条数没变但最后一条换了内容"也能被识别成新回复。
    */
    async getAssistantMessageKeys() {
        if (!this.isPageAlive()) {
            return [];
        }

        try {
            return await this.page.locator(RESPONSE_SELECTOR).evaluateAll((elements) =>
                elements.map((element, index) => {
                    const text = (element.textContent || "").trim();
                    const hash = text.length + ":" + text.substring(0, 100);
                    return "gemini:" + index + ":" + hash;
                })
            );
        } catch (error) {
            return [];
        }
    }

    async getAssistantIndexByKey(key) {
        if (!key || !key.startsWith("gemini:")) {
            return -1;
        }

        try {
            const index = parseInt(key.split(":")[1], 10);

            if (isNaN(index) || index < 0) {
                return -1;
            }

            const messages = this.page.locator(RESPONSE_SELECTOR);
            const count = await messages.count();

            return index >= count ? -1 : index;
        } catch (error) {
            // -1 会让上层退化到"读最后一条"；若因为选择器失效，
            // 拿到的是别人的回复，所以这里不能静默。
            console.warn("[Gemini] failed to locate assistant message by key: " + error.message);
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

            // 一条长回复的 DOM 遍历不便宜，而轮询通常是 1 秒一次。
            // 1.5 秒短缓存既省掉重复重建，又不会盖过 4 秒的稳定判定窗口。
            const now = Date.now();
            const cached = this._domTextCache;

            if (cached && cached.index === index && now - cached.at < 1500) {
                return cached.text;
            }

            const text = await messages.nth(index).evaluate(renderGeminiMessage);
            const result = balanceMarkdownFences(text || "");

            this._domTextCache = { index, at: now, text: result };

            return result;
        } catch (error) {
            return "";
        }
    }

    /**
    Gemini 3 会先展示思考过程（<model-thoughts>），正文一段时间是空的。
    把思考块文本当活动签名：内容在增长就说明模型还在工作，空回复计时重置，
    避免把正常的长思考误判成失败。
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
            return await this.page
                .locator(RESPONSE_SELECTOR)
                .nth(index)
                .evaluate((element) => {
                    const node =
                        element.querySelector("model-thoughts") ||
                        element.querySelector(".thoughts") ||
                        element.querySelector(".thinking");

                    if (!node) {
                        return "";
                    }

                    const text = (node.textContent || "").replace(/\s+/g, "");

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

    /** 元素复用检测：条数没变但最后一条的摘要变了，说明这条被原地改写。 */
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

    /** 两级降级提交：发送按钮 → 回车。输入框未清空中转时会自动换成停止按钮。 */
    async deliverMessage() {
        let sent = false;
        let lastError = null;

        try {
            sent = await this.clickSendButton();
        } catch (error) {
            lastError = error;
        }

        if (!sent) {
            try {
                await this.page.keyboard.press("Enter");
                sent = true;
            } catch (error) {
                lastError = error;
            }
        }

        if (!sent) {
            throw new Error(
                "Gemini failed to send message: " +
                    (lastError ? lastError.message : "send button not found")
            );
        }
    }

    /**
    Gemini 的输入框是 Quill（`.ql-editor`），由 Angular 控制状态。
    直接改 textContent 不会触发 Quill 的模型更新，发送按钮会一直是禁用态，
    所以走"聚焦 → 全选 → 真实输入事件"：
    `keyboard.insertText` 是单次 CDP 调用，长提示词也不会逐字符敲。

    另外两个坑：
    - 页面刚打开时 Angular 还没水合完，此刻只有骨架 textarea，
      所以先 `ensureComposer` 等到 `.ql-editor` 出现再写；
    - 写入后要重新查 DOM 校验值，不能复用旧 locator —— 水合会把节点整块替换掉，
      对旧句柄调 `inputValue()` 会一直等到超时（这是之前的卡死原因）。
    */
    async insertMessage(message) {
        if (!message || !message.trim()) {
            throw new Error("[Gemini] message cannot be empty");
        }

        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const input = await this.ensureComposer(attempt === 0 ? 30000 : 8000);

                if (!input) {
                    lastError = new Error("composer not found");
                    await this.sleep(300);
                    continue;
                }

                await input.click({ timeout: 5000 }).catch(() => input.focus({ timeout: 5000 }));
                await this.sleep(100);

                // 清掉草稿里可能残留的旧内容，避免两次任务拼在一起
                await this.page.keyboard.press("Control+A").catch(() => {});
                await this.page.keyboard.insertText(message);
                await this.sleep(300);

                let value = await this.readComposer();

                if (!value || !value.trim()) {
                    // Quill 偶尔不认 insertText（焦点丢失 / 选区异常），
                    // 退回 Playwright 的 fill：它会派发完整的事件序列。
                    await input.fill(message, { timeout: 5000 }).catch(() => {});
                    await this.sleep(300);
                    value = await this.readComposer();
                }

                if (value && value.trim()) {
                    return true;
                }

                lastError = new Error("[Gemini] composer is empty after insertion");
            } catch (error) {
                lastError = error;
                this._cachedInput = null;
            }

            await this.sleep(300);
        }

        throw new Error(
            "[Gemini] failed to insert message: " +
                (lastError ? lastError.message : "input not found")
        );
    }

    /**
    等到 Quill 编辑区就绪。水合完成前 `.ql-editor` 不存在，
    此时贸然写骨架 textarea 会被 Angular 覆盖掉，表现就是"输入框一直是空的"。
    */
    async ensureComposer(timeout = 30000) {
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
            if (!this.isPageAlive()) {
                return null;
            }

            const editor = this.page.locator(".ql-editor").first();
            const count = await editor.count().catch(() => 0);

            if (count > 0 && (await editor.isVisible().catch(() => false))) {
                return editor;
            }

            await this.sleep(300);
        }

        // 结构变化时退回通用选择器，至少不会直接失败
        return this.findVisibleInput(this.inputSelectors, 2);
    }

    /**
    当前输入框里的文本。每次都重新查 DOM：
    旧句柄在水合/发送后会失效，读它会一直阻塞到超时。
    */
    async readComposer() {
        if (!this.isPageAlive()) {
            return "";
        }

        const read = () =>
            this.page.evaluate(() => {
                const editor = document.querySelector(".ql-editor");

                if (editor) {
                    return editor.innerText || "";
                }

                const area = document.querySelector("textarea");

                if (area) {
                    return area.value || "";
                }

                const editable = document.querySelector("[contenteditable='true']");

                return editable ? editable.innerText || "" : "";
            });

        try {
            const value = await Promise.race([read(), this.sleep(10000).then(() => null)]);

            return typeof value === "string" ? value : "";
        } catch (error) {
            return "";
        }
    }

    /** 覆盖基类：基类会复用传入的 locator，而 Gemini 的节点会被 Angular 整块替换。 */
    async getInputValue() {
        return this.readComposer();
    }

    /** 覆盖基类：同样的原因，轮询"输入框是否清空"时也要重新查 DOM。 */
    async waitForInputClear(timeout = 10000) {
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
            const value = await this.readComposer();

            if (!value || !value.trim()) {
                return true;
            }

            await this.sleep(200);
        }

        return false;
    }

    /**
    发送按钮在输入为空 / 正在生成时是 disabled，
    所以只点"可见且未禁用"的那个；都点不到就交给回车兜底。
    */
    async clickSendButton() {
        if (!this.isPageAlive()) {
            return false;
        }

        for (const selector of this.sendButtonSelectors) {
            try {
                const locator = this.page.locator(selector);
                const count = await locator.count();

                for (let index = count - 1; index >= 0; index -= 1) {
                    const candidate = locator.nth(index);

                    if (!(await candidate.isVisible().catch(() => false))) {
                        continue;
                    }

                    const disabled = await candidate
                        .evaluate((element) => {
                            const aria = element.getAttribute("aria-disabled");

                            return (
                                aria === "true" ||
                                element.disabled === true ||
                                element.classList.contains("disabled")
                            );
                        })
                        .catch(() => false);

                    if (disabled) {
                        continue;
                    }

                    await candidate.click({ timeout: 5000 });

                    return true;
                }
            } catch (error) {
                // 换下一个选择器
            }
        }

        return false;
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
            // "回复挂出来了但一直是空的"不能降级：再等一轮只会白耗一个超时
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

    // ------------------------------------------------------------
    // 图片上传
    // ------------------------------------------------------------

    async uploadImages(imagePaths) {
        if (!this.isPageAlive()) {
            const recovered = await this.ensurePageAlive();

            if (!recovered || !this.isPageAlive()) {
                throw new Error("Gemini page is not available for upload");
            }
        }

        const result = await super.uploadImages(imagePaths, this.uploadButtonSelectors);

        if (!result.ok) {
            throw new Error("Gemini upload failed: " + (result.reason || "unknown"));
        }

        return result;
    }
}

module.exports = {
    GeminiProvider,
    GEMINI_CONVERSATION_PATTERN,
    renderGeminiMessage,
    // provider 元数据：注册表据此创建实例、解析访问地址与会话 id
    meta: {
        id: "gemini",
        label: "Gemini",
        defaultTargetUrl: "https://gemini.google.com",
        conversationIdPattern: GEMINI_CONVERSATION_PATTERN,
        supportsImages: true,
        create: (options) => new GeminiProvider(options),
    },
};
