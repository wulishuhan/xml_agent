const { BrowserChatProvider } = require("./browser-chat");

const CHATGPT_CONVERSATION_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");

// 可见输入框候选。ChatGPT 会把可见的 role=textbox 与隐藏的 fallback textarea 来回切换，
// 所以每次写入前都按这个顺序重新找"真的能看见、有尺寸"的那个。
const INPUT_SELECTORS = [
    "div[role='textbox']",
    ".ProseMirror",
    "[contenteditable='true']",
    "#prompt-textarea",
    "textarea[name='prompt-textarea']",
    "textarea",
];

// 发送按钮候选：新版用 data-testid，旧版可能只留 aria-label 或图标。
const SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]',
    'button:has(svg[data-icon="send"])',
    'button:has(svg[data-icon="paper-plane"])',
];

const PROFILE = {
    targetUrl: "https://chatgpt.com",
    conversationPathPrefix: "/c/",
    conversationIdPattern: CHATGPT_CONVERSATION_PATTERN,
    pageUrlIncludes: "chatgpt.com",
};

class ChatGPTProvider extends BrowserChatProvider {
    constructor(options = {}) {
        super({
            ...options,
            profile: PROFILE,
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

    /**
    ChatGPT 新版输入区域会在消息发送、页面 hydration、虚拟键盘切换过程中替换 DOM，
    因此整个写入过程允许重新获取输入框。
    */
    async insertMessage(message) {
        console.log("[ChatGPT] Inserting message: " + JSON.stringify(message));

        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            const input = await this.findVisibleInput(INPUT_SELECTORS);

            if (!input) {
                await this.sleep(300);
                continue;
            }

            try {
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
                    // 不直接对可能已经被隐藏的 textarea 调用 fill。
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

    /**
    三级降级提交：键盘回车 → 发送按钮 → 输入元素自身回车。
    Enter 优先是因为新版的发送按钮有时在动画中途不可点。
    */
    async deliverMessage() {
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
            for (const selector of SEND_BUTTON_SELECTORS) {
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
        }

        if (!sent) {
            try {
                const input = await this.findVisibleInput(INPUT_SELECTORS);

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
    }
}

module.exports = {
    ChatGPTProvider,
    // provider 元数据：注册表据此创建实例、解析访问地址与会话 id。
    meta: {
        id: "chatgpt",
        label: "ChatGPT",
        defaultTargetUrl: "https://chatgpt.com",
        conversationIdPattern: CHATGPT_CONVERSATION_PATTERN,
        supportsImages: true,
        create: (options) => new ChatGPTProvider(options),
    },
};
