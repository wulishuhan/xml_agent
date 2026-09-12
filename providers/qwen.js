const { BrowserAgent } = require("./browser-agent");

const QWEN_CONVERSATION_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");
const TRAILING_SLASH_PATTERN = new RegExp("/+$");

class QwenProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
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

    // 判断当前页面是不是 Qwen
    async matchPage(page) {
        try {
            const url = page.url();
            return url.includes("chat.qwen.ai");
        } catch (error) {
            return false;
        }
    }

    /**

Qwen 会话 URL 形如：

https://chat.qwen.ai/c/<uuid>

从 URL 中提取会话 id。
*/
    getConversationIdFromUrl(url) {
        if (!url || typeof url !== "string") {
            return null;
        }

        const match = url.match(QWEN_CONVERSATION_PATTERN);

        if (!match) {
            return null;
        }

        return match[1];
    }

    /**

构造目标 URL：

无 conversationId：进入新会话入口 https://chat.qwen.ai

有 conversationId：直接进入已有会话 https://chat.qwen.ai/c/<id>
*/
    buildTargetUrl() {
        const base = this.targetUrl || "https://chat.qwen.ai";

        if (!this.conversationId) {
            return base;
        }

        const trimmed = base.replace(TRAILING_SLASH_PATTERN, "");
        return trimmed + "/c/" + this.conversationId;
    }

    /**

获取所有 assistant 消息数量
*/
    async getAssistantCount() {
        if (!this.isPageAlive()) {
            return 0;
        }

        try {
            return await this.page.locator(".response-message-content").count();
        } catch (error) {
            return 0;
        }
    }

    /**

获取最后一条 assistant 回复

修复：移除 markdown 代码块中的行号（margin 元素）
*/
    async getLastResponse() {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            let messages = this.page.locator(".response-message-content");
            let count = await messages.count();

            // 如果第一种 DOM 不存在，尝试备用 selector
            if (!count) {
                messages = this.page.locator(".qwen-markdown-html");
                count = await messages.count();
            }

            if (!count) {
                return "";
            }

            const last = messages.nth(count - 1);
            const visible = await last.isVisible().catch(() => false);

            if (!visible) {
                return "";
            }

            // 去除markdown的代码块的头部和行号
            await last.evaluate((element) => {
                // 查找qwen-markdown-code-header，然后去除
                const headers = element.querySelectorAll(".qwen-markdown-code-header");
                headers.forEach((header) => {
                    header.remove();
                });
                // 查找所有 .qwen-markdown-code-body 内的 .margin-view-overlays
                const codeBlocks = element.querySelectorAll(".qwen-markdown-code-body");
                codeBlocks.forEach((codeBlock) => {
                    const marginElements = codeBlock.querySelectorAll(".margin-view-overlays");
                    marginElements.forEach((margin) => {
                        margin.remove();
                    });
                });
            });

            const text = await last.innerText().catch(() => "");
            return (text || "").trim();
        } catch (error) {
            return "";
        }
    }

    /**

获取当前 Qwen 回复状态
*/
    async getResponseState() {
        return {
            count: await this.getAssistantCount(),
            text: await this.getLastResponse(),
        };
    }

    /**

等待 Qwen 开始产生新的回复
*/
    async waitForResponseStart(oldCount, oldResponse) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        let lastText = oldResponse || "";

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error("Qwen page was closed while waiting for response");
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

        throw new Error("Qwen did not start a response within " + timeout + "ms");
    }

    /**

发送消息
*/
    async send(message) {
        if (!message || !message.trim()) {
            throw new Error("Qwen message cannot be empty");
        }

        if (!this.isPageAlive()) {
            throw new Error("Qwen page is not available");
        }

        const oldAssistantCount = await this.getAssistantCount();
        const oldResponse = await this.getLastResponse();

        await this.insertMessage(message);

        try {
            const input = await this.getInput();

            if (!input) {
                throw new Error("Qwen input not found before pressing Enter");
            }

            await input.press("Enter");
        } catch (error) {
            throw new Error("Qwen failed to send message: " + error.message);
        }

        const inputCleared = await this.waitForInputClear();

        if (!inputCleared) {
            console.warn("[Qwen] Input did not clear within timeout, continuing...");
        }

        // 发送后，页面 URL 通常会从 / 变为 /c/<id>，
        // 这里主动刷新并同步 conversationId，让上层可感知会话 ID 变化。
        this.refreshConversationId();

        await this.waitForResponseStart(oldAssistantCount, oldResponse);

        const response = await this.waitForStableResponse(() => this.getLastResponse(), {
            timeout: this.responseTimeout,
            stableTime: this.responseStableTime,
            pollInterval: this.responsePollInterval,
        });

        if (!response || !response.trim()) {
            throw new Error("Qwen returned an empty response");
        }

        // 响应完成后再次同步会话 ID
        this.refreshConversationId();

        return response;
    }
}

module.exports = {
    QwenProvider,
};
