
const { BrowserAgent } = require("./browser-agent");

class ChatGPTProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
            inputSelectors: [
                "div[role='textbox']",
                ".ProseMirror",
                "[contenteditable='true']",
                "#prompt-textarea",
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

        // 发送消息 - 多种方式
        let sent = false;

        // 方式1: 使用 page.keyboard 发送 Enter (最可靠)
        try {
            await this.page.keyboard.press("Enter");
            console.log("[ChatGPT] Sent Enter via keyboard");
            sent = true;
        } catch (error) {
            console.warn("[ChatGPT] Keyboard Enter failed: " + error.message);
        }

        // 如果 keyboard 失败，尝试点击发送按钮
        if (!sent) {
            try {
                const sendButtonSelectors = [
                    'button[data-testid="send-button"]',
                    'button[aria-label="Send message"]',
                    'button[aria-label="Send"]',
                    'button:has(svg[data-icon="send"])',
                    'button:has(svg[data-icon="paper-plane"])'
                ];

                for (const selector of sendButtonSelectors) {
                    try {
                        const button = this.page.locator(selector).first();
                        if (await button.count() > 0 && await button.isVisible()) {
                            await button.click();
                            console.log("[ChatGPT] Clicked send button: " + selector);
                            sent = true;
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            } catch (error) {
                console.warn("[ChatGPT] Send button click failed: " + error.message);
            }
        }

        // 方式3: 尝试通过 input 元素按 Enter
        if (!sent) {
            try {
                const input = await this.getInput();
                if (input) {
                    await input.press("Enter");
                    console.log("[ChatGPT] Pressed Enter on input element");
                    sent = true;
                }
            } catch (error) {
                console.warn("[ChatGPT] Input Enter failed: " + error.message);
            }
        }

        if (!sent) {
            throw new Error("ChatGPT failed to send message - all send methods failed");
        }

        // 等待输入框清空 (减少超时时间，避免卡太久)
        const inputCleared = await this.waitForInputClear(5000);
        if (!inputCleared) {
            console.warn("[ChatGPT] Input did not clear within 5s, but continuing...");
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
