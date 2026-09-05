
const { BrowserAgent } = require("./browser-agent");

class ChatGPTProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
            inputSelectors: [
                "div[role='textbox']", // 最可靠的选择器
                ".ProseMirror", // 备选
                "[contenteditable='true']", // 备选
                "#prompt-textarea", // 备选
                "textarea",
                ".wcDTda_fallbackTextarea",
            ],
        });
    }

    get name() {
        return "ChatGPT";
    }

    async matchPage(page) {
        try {
            const url = page.url();
            return url.includes("chatgpt.com");
        } catch (error) {
            return false;
        }
    }

    async getAssistantCount() {
        if (!this.isPageAlive()) return 0;
        try {
            return await this.page.locator('[data-message-author-role="assistant"]').count();
        } catch (error) {
            return 0;
        }
    }

    async getLastResponse() {
        if (!this.isPageAlive()) return "";

        try {
            const messages = this.page.locator('[data-message-author-role="assistant"]');
            const count = await messages.count();
            if (!count) return "";

            const last = messages.nth(count - 1);
            const visible = await last.isVisible().catch(() => false);
            if (!visible) return "";

            await last.evaluate((element) => {
                const markdownElements = element.querySelectorAll(".markdown");
                markdownElements.forEach((markdown) => {
                    const selectNoneElements = markdown.querySelectorAll(".select-none");
                    selectNoneElements.forEach((selectNone) => {
                        selectNone.remove();
                    });
                });
            });

            const text = await last.innerText().catch(() => "");
            return (text || "").trim();
        } catch (error) {
            return "";
        }
    }

    async getResponseState() {
        return {
            count: await this.getAssistantCount(),
            text: await this.getLastResponse(),
        };
    }

    async waitForResponseStart(oldCount, oldResponse) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        let lastText = oldResponse || "";

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error("ChatGPT page was closed while waiting for response");
            }

            try {
                const state = await this.getResponseState();

                if (state.count > oldCount) {
                    return true;
                }

                if (state.text && state.text.trim()) {
                    if (!lastText) return true;
                    if (state.text !== lastText) return true;
                }

                lastText = state.text || lastText;
            } catch (error) {
                // DOM 临时异常，继续等待
            }

            await this.sleep(this.responsePollInterval);
        }

        throw new Error("ChatGPT did not start a response within " + timeout + "ms");
    }

    async send(message) {
        if (!message || !message.trim()) {
            throw new Error("ChatGPT message cannot be empty");
        }

        if (!this.isPageAlive()) {
            throw new Error("ChatGPT page is not available");
        }

        const oldAssistantCount = await this.getAssistantCount();
        const oldResponse = await this.getLastResponse();

        // 填充消息
        await this.insertMessage(message);

        // 发送消息 - 优先使用 Enter
        try {
            const input = await this.getInput();
            if (!input) {
                throw new Error("ChatGPT input not found before pressing Enter");
            }

            await input.press("Enter");
        } catch (error) {
            throw new Error("ChatGPT failed to send message: " + error.message);
        }

        // 等待输入框清空
        const inputCleared = await this.waitForInputClear();
        if (!inputCleared) {
            // 如果输入框未清空，尝试 Ctrl+Enter（备选发送方式）
            console.warn("[ChatGPT] Input did not clear with Enter, trying Ctrl+Enter...");
            try {
                const input = await this.getInput();
                if (input) {
                    await input.press("Control+Enter");
                }
            } catch (error) {
                console.warn("[ChatGPT] Ctrl+Enter also failed: " + error.message);
            }
        }

        await this.waitForResponseStart(oldAssistantCount, oldResponse);

        const response = await this.waitForStableResponse(() => this.getLastResponse(), {
            timeout: this.responseTimeout,
            stableTime: this.responseStableTime,
            pollInterval: this.responsePollInterval,
        });

        if (!response || !response.trim()) {
            throw new Error("ChatGPT returned an empty response");
        }

        return response;
    }
}

module.exports = {
    ChatGPTProvider,
};
