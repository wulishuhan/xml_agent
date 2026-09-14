const { BrowserAgent } = require("./browser-agent");
const CHATGPT_CONVERSATION_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");
const TRAILING_SLASH_PATTERN = new RegExp("/+$/");
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

    getConversationIdFromUrl(url) {
        if (!url || typeof url !== "string") {
            return null;
        }

        const match = url.match(CHATGPT_CONVERSATION_PATTERN);

        if (!match) {
            return null;
        }

        return match[1];
    }

    buildTargetUrl() {
        const base = this.targetUrl || "https://chatgpt.com";

        if (!this.conversationId) {
            return base;
        }

        const trimmed = base.replace(TRAILING_SLASH_PATTERN, "");
        return trimmed + "/c/" + this.conversationId;
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

            const text = await last
                .evaluate((element) => {
                    const clone = element.cloneNode(true);

                    clone.querySelectorAll(".markdown .select-none").forEach((node) => {
                        node.remove();
                    });

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

    /**

ChatGPT 输入框会在页面更新时动态切换：

可见的 contenteditable / role=textbox

隐藏的 fallback textarea

因此不能只依赖 BrowserAgent 的缓存 Locator。

每次真正写入前重新寻找当前可见、可编辑的元素。
*/
    async getChatGPTInput() {
        if (!this.isPageAlive()) {
            throw new Error("[ChatGPT] page is not available");
        }

        const selectors = [
            "div[role='textbox']",
            ".ProseMirror",
            "[contenteditable='true']",
            "#prompt-textarea",
            "textarea[name='prompt-textarea']",
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
                    // ChatGPT 页面正在切换 DOM，继续寻找
                }
            }

            await this.sleep(150);
        }

        return null;
    }

    async insertMessage(message) {
        console.log("[ChatGPT] Inserting message: " + JSON.stringify(message));

        if (!this.isPageAlive()) {
            throw new Error("[ChatGPT] page is not available");
        }

        let lastError = null;

        // ChatGPT 新版输入区域可能在消息发送、页面 hydration、
        // 虚拟键盘切换过程中替换 DOM，因此整个插入过程允许重新获取输入框。
        for (let attempt = 0; attempt < 3; attempt++) {
            const input = await this.getChatGPTInput();

            if (!input) {
                await this.sleep(300);
                continue;
            }

            try {
                // 先确认当前 Locator 仍然是可见元素。
                if (!(await input.isVisible())) {
                    await this.sleep(200);
                    continue;
                }

                try {
                    await input.click({ timeout: 3000 });
                } catch (clickError) {
                    await input.focus({ timeout: 3000 });
                }

                await this.sleep(150);

                const tagName = await input.evaluate((el) => el.tagName.toLowerCase());

                const isContentEditable = await input.evaluate((el) => el.isContentEditable);

                if (isContentEditable || tagName === "div") {
                    await input.evaluate((el, msg) => {
                        el.focus();
                        el.innerHTML = "";
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
                    // 不直接对可能已经被 ChatGPT 隐藏的 textarea 调用 fill。
                    // fill 前再次确认元素仍然可见。
                    if (!(await input.isVisible())) {
                        throw new Error("ChatGPT input became hidden before fill");
                    }

                    await input.fill(message);
                }

                await this.sleep(300);

                const actualValue = await this.getInputValue(input);

                if (actualValue && actualValue.trim()) {
                    console.log(
                        "[ChatGPT] Message inserted successfully, value length: " +
                            actualValue.length
                    );
                    return true;
                }

                lastError = new Error("ChatGPT input value is empty after insertion");
            } catch (error) {
                lastError = error;
                console.warn(
                    "[ChatGPT] Insert attempt " + (attempt + 1) + "/3 failed: " + error.message
                );

                // 清除缓存，下一轮必须重新解析当前 DOM。
                this._cachedInput = null;

                await this.sleep(300);
            }
        }

        throw new Error(
            "[ChatGPT] failed to insert message: " +
                (lastError ? lastError.message : "input not found")
        );
    }

    async send(message) {
        if (!message || !message.trim()) {
            throw new Error("ChatGPT message cannot be empty");
        }

        if (!this.isPageAlive()) {
            // 页面丢失时先尝试自动恢复，避免 agent 连续重试直接失败。
            const recovered = await this.ensurePageAlive();

            if (!recovered || !this.isPageAlive()) {
                throw new Error("ChatGPT page is not available");
            }
        }

        const oldAssistantCount = await this.getAssistantCount();
        const oldResponse = await this.getLastResponse();

        console.log("[ChatGPT] Old assistant count: " + oldAssistantCount);

        await this.insertMessage(message);

        let sent = false;
        let sendError = null;

        try {
            await this.page.keyboard.press("Enter");
            console.log("[ChatGPT] Sent Enter via keyboard");
            sent = true;
        } catch (error) {
            console.warn("[ChatGPT] Keyboard Enter failed: " + error.message);
            sendError = error;
        }

        if (!sent) {
            try {
                const sendButtonSelectors = [
                    'button[data-testid="send-button"]',
                    'button[aria-label="Send message"]',
                    'button[aria-label="Send"]',
                    'button:has(svg[data-icon="send"])',
                    'button:has(svg[data-icon="paper-plane"])',
                ];

                for (const selector of sendButtonSelectors) {
                    try {
                        const button = this.page.locator(selector).first();

                        if ((await button.count()) > 0 && (await button.isVisible())) {
                            await button.click();
                            console.log("[ChatGPT] Clicked send button: " + selector);
                            sent = true;
                            break;
                        }
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                console.warn("[ChatGPT] Send button click failed: " + error.message);

                if (!sendError) {
                    sendError = error;
                }
            }
        }

        if (!sent) {
            try {
                const input = await this.getChatGPTInput();

                if (input) {
                    await input.press("Enter");
                    console.log("[ChatGPT] Pressed Enter on current input element");
                    sent = true;
                }
            } catch (error) {
                console.warn("[ChatGPT] Input Enter failed: " + error.message);

                if (!sendError) {
                    sendError = error;
                }
            }
        }

        if (!sent) {
            throw new Error(
                "ChatGPT failed to send message - all send methods failed. Last error: " +
                    (sendError ? sendError.message : "unknown")
            );
        }

        const inputCleared = await this.waitForInputClear(5000);

        if (inputCleared) {
            console.log("[ChatGPT] Input cleared successfully");
        } else {
            console.warn(
                "[ChatGPT] Input did not clear within 5000ms; waiting for response without retrying send"
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
            throw new Error("ChatGPT returned an empty response");
        }

        this.refreshConversationId();

        console.log("[ChatGPT] Response received, length: " + response.length);

        return response;
    }
}
module.exports = {
    ChatGPTProvider,
};
