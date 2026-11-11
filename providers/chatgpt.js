const { BrowserChatProvider, EMPTY_RESPONSE_CODE } = require("./browser-chat");

const CHATGPT_CONVERSATION_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");

/**
助手消息选择器，按"新 → 旧"排列。

2026 版 ChatGPT 把消息区换成了虚拟列表（data-turn-key / data-talvt-turn-state），
旧版的 [data-message-author-role] 和 .markdown 整个消失。按旧选择器取条数永远是 0，
于是发送后既等不到"新回复出现"，也读不到正文 —— 现象就是干等到 10 分钟超时。
两个选择器并存是为了兼容 A/B 分流：哪套先取到消息就用哪套。
*/
const ASSISTANT_MESSAGE_SELECTORS = [
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-message-author-role="assistant"]',
];

// 生成中（"正在思考"）时出现的停止按钮。新版是 data-testid，旧版只有 aria-label。
const GENERATING_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop"]',
    'button[aria-label="停止"]',
];

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
    'button[aria-label="发送"]',
];

/**
在页面里统计助手消息条数。

doc 参数只为单测注入假 document；在浏览器里运行时走全局 document。
函数会被 playwright 序列化后注入页面，因此**不能引用模块级变量**。
*/
function countAssistantMessages(selectors, doc) {
    const target = doc || document;

    for (const selector of selectors) {
        const count = target.querySelectorAll(selector).length;

        if (count > 0) {
            return count;
        }
    }

    return 0;
}

/**
在页面里读取所有助手消息正文（按 DOM 顺序）。

只取正文容器，不取整条消息：新版把角色标题（"ChatGPT 说："）也放进了消息体内，
整条读会把这段看不见的标签当成正文；而"正在思考"阶段正文容器是空的，
正好让调用方知道"回复还没开始输出"。
*/
function readAssistantMessages(selectors, doc) {
    const target = doc || document;
    let nodes = [];

    for (const selector of selectors) {
        nodes = Array.from(target.querySelectorAll(selector));

        if (nodes.length) {
            break;
        }
    }

    return nodes.map(function (node) {
        const body = node.querySelector('[class*="MarkdownRoot"], .markdown') || node;

        return (body.innerText || "").trim();
    });
}

/**
在页面里判断"是否还在生成"。
新版正文为空时只有停止按钮能区分"思考中"和"这次真的没答"。
*/
function detectGenerating(selectors, doc) {
    const target = doc || document;

    return selectors.some(function (selector) {
        return target.querySelector(selector) !== null;
    });
}

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
            return await this.page.evaluate(countAssistantMessages, ASSISTANT_MESSAGE_SELECTORS);
        } catch (error) {
            return 0;
        }
    }

    async getLastResponse() {
        if (!this.isPageAlive()) return "";

        try {
            const messages = await this.page.evaluate(
                readAssistantMessages,
                ASSISTANT_MESSAGE_SELECTORS
            );

            if (!messages || !messages.length) {
                return "";
            }

            return messages[messages.length - 1] || "";
        } catch (error) {
            return "";
        }
    }

    /**
    是否正在生成回复。仅看正文空不空是不够的：ChatGPT 思考阶段会挂一条空消息，
    这段时间没有停止按钮就没法把它和"空回复"区分开。
    */
    async isGenerating() {
        if (!this.isPageAlive()) return false;

        try {
            return await this.page.evaluate(detectGenerating, GENERATING_SELECTORS);
        } catch (error) {
            return false;
        }
    }

    /**
    等这次的新回复，并等它写稳。

    不直接用基类的 waitForStableResponse：它把"取不到正文"当成还需要等（60s 上限），
    ChatGPT 会先挂空占位再思考，长任务很容易超过这个上限，被误判成没有回复。
    这里的判据改成"生成结束 + 正文连续稳定 responseStableTime"：
    - 还在生成（停止按钮在）：一直等，直到 responseTimeout；
    - 生成停了但正文一直为空：超过空回复容忍时间就抛 EMPTY_RESPONSE，交给上层重试。
    */
    async collectResponse(before) {
        await this.waitForResponseStart(before.count, before.text);

        const start = Date.now();
        const emptyGrace = Math.min(this.responseContentGrace, 15 * 1000);
        let lastText = "";
        let lastChange = 0;
        let emptySince = 0;

        while (Date.now() - start < this.responseTimeout) {
            if (!this.isPageAlive()) {
                throw new Error(this.name + " page was closed while waiting for response");
            }

            const text = await this.getLastResponse();
            const generating = await this.isGenerating();

            if (text) {
                emptySince = 0;

                if (text !== lastText) {
                    lastText = text;
                    lastChange = Date.now();
                } else if (!generating && Date.now() - lastChange >= this.responseStableTime) {
                    return text;
                }
            } else if (generating) {
                emptySince = 0;
            } else if (emptySince === 0) {
                emptySince = Date.now();
            } else if (Date.now() - emptySince >= emptyGrace) {
                const error = new Error(
                    this.name +
                        " produced an empty response: no readable content within " +
                        emptyGrace +
                        "ms"
                );

                error.code = EMPTY_RESPONSE_CODE;
                throw error;
            }

            await this.sleep(this.responsePollInterval);
        }

        throw new Error(this.name + " response timeout after " + this.responseTimeout + "ms");
    }

    /**
    ChatGPT 新版输入区域会在消息发送、页面 hydration、虚拟键盘切换过程中替换 DOM，
    因此整个写入过程允许重新获取输入框。

    写入方式必须是**真实键盘输入**（Input.insertText）。直接改 textContent + 派发合成 input 事件，
    短文本看着没问题，但编辑器的内部状态没有同步：长提示词（1k 字符以上）时，
    气泡里显示着全文，提交给服务端的却是空消息，ChatGPT 于是回一条空回复 ——
    界面显示"回答已完成"、正文一个字都没有，agent 只能判成空回复反复重试。
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

                // 上一轮失败可能留下半截文本，先清空再输入，避免拼出重复内容
                const existing = await this.getInputValue(input);

                if (existing && existing.trim()) {
                    await this.page.keyboard.press("ControlOrMeta+A");
                    await this.page.keyboard.press("Backspace");
                    await this.sleep(100);
                }

                await this.page.keyboard.insertText(message);
                await this.sleep(300);

                const actualValue = await this.getInputValue(input);
                const expected = message.trim().length;
                const actual = (actualValue || "").trim().length;

                // 只校验"非空"不够：真正出事的就是"看起来写进去了、实际只进去一截"。
                // innerText 会压缩空行，所以按 90% 兜底，不要求逐字相等。
                if (actual > 0 && actual >= expected * 0.9) {
                    console.log(
                        "[ChatGPT] Message inserted successfully, value length: " +
                            actualValue.length
                    );
                    return true;
                }

                lastError = new Error(
                    "ChatGPT input value mismatch after insertion: expected " +
                        expected +
                        " chars, got " +
                        actual
                );
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
    // 纯 DOM 读取函数，单测用假 document 直接调用。
    countAssistantMessages,
    readAssistantMessages,
    detectGenerating,
    ASSISTANT_MESSAGE_SELECTORS,
    GENERATING_SELECTORS,
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
