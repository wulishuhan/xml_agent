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

    // 重写 insertMessage 方法，使用更可靠的方式填充 ChatGPT 输入框
    async insertMessage(message) {
        console.log("[ChatGPT] Inserting message: " + JSON.stringify(message));
        if (!this.isPageAlive()) {
            throw new Error("[ChatGPT] page is not available");
        }

        const input = await this.getInput();
        if (!input) {
            throw new Error("[ChatGPT] input not found");
        }

        // 先点击输入框获取焦点
        try {
            await input.click({ timeout: 3000 });
            await this.sleep(300);
        } catch (error) {
            console.warn("[ChatGPT] Click input failed: " + error.message);
            // 尝试使用 focus
            try {
                await input.focus();
                await this.sleep(300);
            } catch (e) {
                // ignore
            }
        }

        // 对于 contenteditable 元素，使用 evaluate 直接设置内容
        try {
            const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
            const isContentEditable = await input.evaluate((el) => el.isContentEditable);

            if (isContentEditable || tagName === "div") {
                // 使用 evaluate 设置 innerHTML，这是最可靠的方式
                await input.evaluate((el, msg) => {
                    el.innerHTML = "";
                    el.textContent = msg;
                    // 触发 input 事件
                    const event = new Event("input", { bubbles: true });
                    el.dispatchEvent(event);
                    // 触发 change 事件
                    const changeEvent = new Event("change", { bubbles: true });
                    el.dispatchEvent(changeEvent);
                }, message);
                await this.sleep(300);

                // 验证是否设置成功
                const actualValue = await this.getInputValue(input);
                if (!actualValue || !actualValue.trim()) {
                    // 如果 evaluate 方式失败，尝试使用 fill 作为备选
                    await input.fill(message);
                    await this.sleep(300);
                }
            } else {
                // 对于普通的 input/textarea，使用 fill
                await input.fill(message);
                await this.sleep(300);
            }
        } catch (error) {
            console.warn("[ChatGPT] Evaluate fill failed: " + error.message);
            // 备选方案：使用 fill
            try {
                await input.fill(message);
                await this.sleep(300);
            } catch (e) {
                throw new Error("[ChatGPT] failed to insert message: " + error.message);
            }
        }

        // 最终验证
        const finalValue = await this.getInputValue(input);
        if (!finalValue || !finalValue.trim()) {
            throw new Error("[ChatGPT] Input value is empty after fill");
        }

        console.log(
            "[ChatGPT] Message inserted successfully, value length: " + (finalValue || "").length
        );
        return true;
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

        console.log("[ChatGPT] Old assistant count: " + oldAssistantCount);

        // 填充消息（使用重写后的方法）
        await this.insertMessage(message);

        // 发送消息 - 多种方式
        let sent = false;
        let sendError = null;

        // 先尝试使用键盘 Enter（对于 contenteditable 最可靠）
        try {
            await this.page.keyboard.press("Enter");
            console.log("[ChatGPT] Sent Enter via keyboard");
            sent = true;
        } catch (error) {
            console.warn("[ChatGPT] Keyboard Enter failed: " + error.message);
            sendError = error;
        }

        // 如果 keyboard 失败，尝试点击发送按钮
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
                    } catch (e) {
                        continue;
                    }
                }
            } catch (error) {
                console.warn("[ChatGPT] Send button click failed: " + error.message);
                if (!sendError) sendError = error;
            }
        }

        // 如果键盘和按钮都失败，尝试通过 input 元素按 Enter
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
                if (!sendError) sendError = error;
            }
        }

        if (!sent) {
            throw new Error(
                "ChatGPT failed to send message - all send methods failed. Last error: " +
                    (sendError ? sendError.message : "unknown")
            );
        }

        // 等待输入框清空 - 增加重试机制
        let inputCleared = false;
        for (let retry = 0; retry < 3; retry++) {
            inputCleared = await this.waitForInputClear(5000);
            if (inputCleared) {
                console.log("[ChatGPT] Input cleared successfully");
                break;
            }
            console.warn("[ChatGPT] Input did not clear, retry " + (retry + 1) + "/3");
            // 尝试再次按 Enter 或点击发送
            try {
                await this.page.keyboard.press("Enter");
                await this.sleep(500);
            } catch (e) {
                // ignore
            }
        }

        if (!inputCleared) {
            console.warn("[ChatGPT] Input not cleared after retries, but continuing...");
            // 检查是否已经有新的 assistant 消息，如果有则继续
            const newCount = await this.getAssistantCount();
            if (newCount > oldAssistantCount) {
                console.log("[ChatGPT] New assistant message detected despite input not cleared");
            } else {
                // 尝试最后一次发送
                console.warn("[ChatGPT] Attempting final send via Enter...");
                try {
                    await this.page.keyboard.press("Enter");
                    await this.sleep(1000);
                } catch (e) {
                    // ignore
                }
            }
        }

        // 等待响应开始
        await this.waitForResponseStart(oldAssistantCount, oldResponse);

        // 获取稳定响应
        const response = await this.waitForStableResponse(() => this.getLastResponse(), {
            timeout: this.responseTimeout,
            stableTime: this.responseStableTime,
            pollInterval: this.responsePollInterval,
        });

        if (!response || !response.trim()) {
            throw new Error("ChatGPT returned an empty response");
        }

        console.log("[ChatGPT] Response received, length: " + response.length);
        return response;
    }
}

module.exports = {
    ChatGPTProvider,
};
