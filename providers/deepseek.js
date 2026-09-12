const { BrowserAgent } = require("./browser-agent");

const DEEPSEEK_CONVERSATION_PATTERN = new RegExp("/a/chat/s/([0-9a-fA-F-]+)");
const TRAILING_SLASH_PATTERN = new RegExp("/+$");

class DeepSeekProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
            // 基于现场 DOM 观察，DeepSeek 输入框通常出现在这些形态中，
            // 追加 role=textbox、.ds-textarea、[data-placeholder] 等常见变体。
            inputSelectors: [
                'div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"][data-placeholder]',
                'div[contenteditable="true"]',
                "[role='textbox']",
                "textarea",
                "#prompt-textarea",
                ".ds-textarea",
            ],
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

    /**

DeepSeek 会话 URL 形如：

https://chat.deepseek.com/a/chat/s/9efa4714-38db-4038-a971-226570f7155d

从 URL 中提取会话 id（UUID）。
*/
    getConversationIdFromUrl(url) {
        if (!url || typeof url !== "string") {
            return null;
        }

        const match = url.match(DEEPSEEK_CONVERSATION_PATTERN);

        if (!match) {
            return null;
        }

        return match[1];
    }

    /**

构造目标 URL：

无 conversationId：进入新会话入口 https://chat.deepseek.com

有 conversationId：直接进入已有会话 https://chat.deepseek.com/a/chat/s/<id>
*/
    buildTargetUrl() {
        const base = this.targetUrl || "https://chat.deepseek.com";

        if (!this.conversationId) {
            return base;
        }

        const trimmed = base.replace(TRAILING_SLASH_PATTERN, "");
        return trimmed + "/a/chat/s/" + this.conversationId;
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
            const messages = this.page.locator(".ds-assistant-message-main-content");
            const count = await messages.count();

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

        // 发送后，页面 URL 通常会从 /a/chat/ 变为 /a/chat/s/<id>，
        // 这里主动刷新并同步 conversationId，让上层可感知会话 ID 变化。
        this.refreshConversationId();

        await this.waitForResponseStart(oldAssistantCount, oldResponse);

        const response = await this.waitForStableResponse(() => this.getLastResponse(), {
            timeout: this.responseTimeout,
            stableTime: this.responseStableTime,
            pollInterval: this.responsePollInterval,
        });

        if (!response || !response.trim()) {
            throw new Error("DeepSeek returned an empty response");
        }

        // 响应完成后再次同步会话 ID，防止 URL 在响应过程中才最终稳定
        this.refreshConversationId();

        return response;
    }
}

module.exports = {
    DeepSeekProvider,
};
