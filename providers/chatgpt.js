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

            // 只处理克隆节点，绝不修改 ChatGPT 页面中的真实 DOM。
            // 这样读取响应不会破坏页面结构，也不会影响后续消息交互。
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
                await input.evaluate((el, msg) => {
                    el.innerHTML = "";
                    el.textContent = msg;

                    const event = new Event("input", { bubbles: true });
                    el.dispatchEvent(event);

                    const changeEvent = new Event("change", { bubbles: true });
                    el.dispatchEvent(changeEvent);
                }, message);

                await this.sleep(300);

                const actualValue = await this.getInputValue(input);
                if (!actualValue || !actualValue.trim()) {
                    await input.fill(message);
                    await this.sleep(300);
                }
            } else {
                await input.fill(message);
                await this.sleep(300);
            }
        } catch (error) {
            console.warn("[ChatGPT] Evaluate fill failed: " + error.message);

            try {
                await input.fill(message);
                await this.sleep(300);
            } catch (e) {
                throw new Error("[ChatGPT] failed to insert message: " + error.message);
            }
        }

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
                    } catch (e) {
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
                const input = await this.getInput();

                if (input) {
                    await input.press("Enter");
                    console.log("[ChatGPT] Pressed Enter on input element");
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

        // 输入框清空只是辅助状态，不再因为没有及时清空而重复发送 Enter。
        // 重复发送是高风险操作：第一次发送可能已经成功，只是 UI 尚未完成更新。
        const inputCleared = await this.waitForInputClear(5000);

        if (inputCleared) {
            console.log("[ChatGPT] Input cleared successfully");
        } else {
            console.warn(
                "[ChatGPT] Input did not clear within 5000ms; waiting for response without retrying send"
            );
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

        console.log("[ChatGPT] Response received, length: " + response.length);

        return response;
    }
}

module.exports = {
    ChatGPTProvider,
};
