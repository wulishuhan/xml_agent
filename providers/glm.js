const { BrowserAgent } = require("./browser-agent");
const GLM_CONVERSATION_PATTERN = new RegExp("/(?:c|s)/([0-9a-zA-Z-]+)");
const TRAILING_SLASH_PATTERN = new RegExp("/+$");
class GlmProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
            inputSelectors: [
                "#chat-input",
                "textarea#chat-input",
                "div[contenteditable='true']",
                "[contenteditable='true']",
                "[role='textbox']",
                "textarea",
            ],
        });
    }
    get name() {
        return "GLM";
    }

    async matchPage(page) {
        try {
            return page.url().includes("chat.z.ai");
        } catch (error) {
            return false;
        }
    }

    getConversationIdFromUrl(url) {
        if (!url || typeof url !== "string") {
            return null;
        }

        const match = url.match(GLM_CONVERSATION_PATTERN);
        return match ? match[1] : null;
    }

    buildTargetUrl() {
        const base = this.targetUrl || "https://chat.z.ai";

        if (!this.conversationId) {
            return base;
        }

        return base.replace(TRAILING_SLASH_PATTERN, "") + "/s/" + this.conversationId;
    }

    async getAssistantMessages() {
        if (!this.isPageAlive()) {
            return null;
        }

        try {
            return this.page.locator(".chat-assistant, [data-message-id].chat-assistant");
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

    async getLastResponse() {
        const messages = await this.getAssistantMessages();

        if (!messages) {
            return "";
        }

        try {
            const count = await messages.count();

            if (!count) {
                return "";
            }

            const last = messages.nth(count - 1);

            if (!(await last.isVisible().catch(() => false))) {
                return "";
            }

            const text = await last
                .evaluate((element) => {
                    const clone = element.cloneNode(true);

                    clone
                        .querySelectorAll(".thinking-chain-container, .thinking-block")
                        .forEach((node) => node.remove());

                    return clone.innerText || clone.textContent || "";
                })
                .catch(() => "");

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
                throw new Error("GLM page was closed while waiting for response");
            }

            try {
                const state = await this.getResponseState();

                if (state.count > oldCount) {
                    return true;
                }

                if (state.text && state.text !== lastText) {
                    return true;
                }

                lastText = state.text || lastText;
            } catch (error) {
                // DOM 临时变化，继续等待。
            }

            await this.sleep(this.responsePollInterval);
        }

        throw new Error("GLM did not start a response within " + timeout + "ms");
    }

    async getGLMInput() {
        if (!this.isPageAlive()) {
            throw new Error("[GLM] page is not available");
        }

        const selectors = [
            "#chat-input",
            "textarea#chat-input",
            "div[contenteditable='true']",
            "[contenteditable='true']",
            "[role='textbox']",
            "textarea",
        ];

        for (let attempt = 0; attempt < 3; attempt++) {
            for (const selector of selectors) {
                try {
                    const locator = this.page.locator(selector);
                    const count = await locator.count();

                    for (let index = 0; index < count; index++) {
                        const candidate = locator.nth(index);

                        if (!(await candidate.isVisible().catch(() => false))) {
                            continue;
                        }

                        if (await candidate.isDisabled().catch(() => false)) {
                            continue;
                        }

                        const box = await candidate.boundingBox().catch(() => null);

                        if (!box || box.width <= 0 || box.height <= 0) {
                            continue;
                        }

                        return candidate;
                    }
                } catch (error) {
                    // 页面 hydration 或 DOM 更新时继续寻找。
                }
            }

            await this.sleep(150);
        }

        return null;
    }

    async insertMessage(message) {
        if (!message || !message.trim()) {
            throw new Error("[GLM] message cannot be empty");
        }

        if (!this.isPageAlive()) {
            throw new Error("[GLM] page is not available");
        }

        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            const input = await this.getGLMInput();

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

    async send(message) {
        if (!message || !message.trim()) {
            throw new Error("GLM message cannot be empty");
        }

        if (!this.isPageAlive()) {
            const recovered = await this.ensurePageAlive();

            if (!recovered || !this.isPageAlive()) {
                throw new Error("GLM page is not available");
            }
        }

        const oldAssistantCount = await this.getAssistantCount();
        const oldResponse = await this.getLastResponse();

        await this.insertMessage(message);

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
            const input = await this.getGLMInput();

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

        const inputCleared = await this.waitForInputClear(5000);

        if (!inputCleared) {
            console.warn(
                "[GLM] Input did not clear within 5000ms; waiting for response without retrying send"
            );
        }

        this.refreshConversationId();

        await this.waitForResponseStart(oldAssistantCount, oldResponse);

        const response = await this.waitForStableResponse(() => this.getLastResponse(), {
            timeout: this.responseTimeout,
            stableTime: this.responseStableTime,
            pollInterval: this.responsePollInterval,
        });

        if (!response || !response.trim()) {
            throw new Error("GLM returned an empty response");
        }

        this.refreshConversationId();

        return response;
    }
}
module.exports = {
    GlmProvider,
};
