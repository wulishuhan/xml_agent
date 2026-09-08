const { BrowserAgent } = require("./browser-agent");

class DeepSeekProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
            inputSelectors: ['[contenteditable="true"]', "#prompt-textarea", "textarea"],
        });
    }

    get name() {
        return "DeepSeek";
    }

    async matchPage(page) {
        try {
            const url = page.url();
            return url.includes("chat.deepseek.com");
        } catch (error) {
            return false;
        }
    }

    async getAssistantCount() {
        if (!this.isPageAlive()) {
            return 0;
        }

        try {
            return await this.page.locator(".ds-assistant-message-main-content").count();
        } catch (error) {
            return 0;
        }
    }

    async getLastResponse() {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            let messages = this.page.locator(".ds-assistant-message-main-content");
            let count = await messages.count();

            if (!count) {
                return "";
            }

            const last = messages.nth(count - 1);
            const visible = await last.isVisible().catch(() => false);

            if (!visible) {
                return "";
            }

            await last.evaluate((element) => {
                const containers = element.querySelectorAll(".md-code-block.md-code-block-light");
                containers.forEach((container) => {
                    const children = Array.from(container.childNodes);
                    children.forEach((child) => {
                        if (child.tagName !== "PRE") {
                            container.removeChild(child);
                        }
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
                throw new Error("DeepSeek page was closed while waiting for response");
            }

            try {
                const state = await this.getResponseState();

                if (state.count > oldCount) {
                    return true;
                }

                if (state.text && state.text.trim()) {
                    if (!lastText) {
                        return true;
                    }

                    if (state.text !== lastText) {
                        return true;
                    }
                }

                lastText = state.text || lastText;
            } catch (error) {
                // DOM 临时异常，继续等待
            }

            await this.sleep(this.responsePollInterval);
        }

        throw new Error("DeepSeek did not start a response within " + timeout + "ms");
    }

    async send(message) {
        if (!message || !message.trim()) {
            throw new Error("DeepSeek message cannot be empty");
        }

        if (!this.isPageAlive()) {
            throw new Error("DeepSeek page is not available");
        }

        const oldAssistantCount = await this.getAssistantCount();
        const oldResponse = await this.getLastResponse();

        await this.insertMessage(message);

        try {
            const input = await this.getInput();
            if (!input) {
                throw new Error("DeepSeek input not found before pressing Enter");
            }
            await input.press("Enter");
        } catch (error) {
            throw new Error("DeepSeek failed to send message: " + error.message);
        }

        const inputCleared = await this.waitForInputClear();
        if (!inputCleared) {
            console.warn("[DeepSeek] Input did not clear within timeout, continuing...");
        }

        await this.waitForResponseStart(oldAssistantCount, oldResponse);

        const response = await this.waitForStableResponse(() => this.getLastResponse(), {
            timeout: this.responseTimeout,
            stableTime: this.responseStableTime,
            pollInterval: this.responsePollInterval,
        });

        if (!response || !response.trim()) {
            throw new Error("DeepSeek returned an empty response");
        }

        return response;
    }
}

module.exports = {
    DeepSeekProvider,
};
