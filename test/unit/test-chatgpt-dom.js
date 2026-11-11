/**
ChatGPT 消息读取单测（providers/chatgpt.js）

2026 版 ChatGPT 换成虚拟列表后，旧选择器 [data-message-author-role] 和 .markdown 全部失效，
表现为"发出去了、也答了，但 agent 一直等不到回复，最后 10 分钟超时"。
这里用假 document 把三条契约钉住，不启动浏览器：

1. 条数与正文都按"新选择器优先、旧选择器兜底"读取；
2. 正文只取消息体（MarkdownRoot/.markdown），不能把 "ChatGPT 说：" 这类隐藏标签读进来；
3. "正在思考"阶段正文为空串，且能被停止按钮识别成"仍在生成"。

运行：node test/unit/test-chatgpt-dom.js
*/

const assert = require("assert");

const {
    ChatGPTProvider,
    countAssistantMessages,
    readAssistantMessages,
    detectGenerating,
    ASSISTANT_MESSAGE_SELECTORS,
    GENERATING_SELECTORS,
} = require("../../providers/chatgpt");

const NEW_SELECTOR = '[data-chatgpt-search-unit-key$=":assistant"]';
const LEGACY_SELECTOR = '[data-message-author-role="assistant"]';
const BODY_SELECTOR = '[class*="MarkdownRoot"], .markdown';

let pass = 0;
let total = 0;

function check(name, fn) {
    total += 1;

    try {
        fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

/** 消息节点替身：带角色标签的整条消息 + 可选的正文容器 */
function makeMessage(labelText, bodyText) {
    return {
        innerText: labelText,
        querySelector(selector) {
            if (selector !== BODY_SELECTOR || bodyText === undefined) {
                return null;
            }

            return { innerText: bodyText };
        },
    };
}

function makeDocument(map) {
    return {
        querySelectorAll(selector) {
            return map[selector] || [];
        },
        querySelector(selector) {
            const list = map[selector] || [];

            return list.length ? list[0] : null;
        },
    };
}

// 1. 选择器顺序：新版在前，旧版兜底
check("新选择器排在旧选择器之前", () => {
    assert.strictEqual(ASSISTANT_MESSAGE_SELECTORS[0], NEW_SELECTOR);
    assert.ok(ASSISTANT_MESSAGE_SELECTORS.includes(LEGACY_SELECTOR));
});

// 2. 优先用新版选择器统计条数（两套 DOM 同时存在时不能相加）
check("新版 DOM 优先计数，不与旧版叠加", () => {
    const doc = makeDocument({
        [NEW_SELECTOR]: [makeMessage(""), makeMessage("")],
        [LEGACY_SELECTOR]: [makeMessage(""), makeMessage(""), makeMessage("")],
    });

    assert.strictEqual(countAssistantMessages(ASSISTANT_MESSAGE_SELECTORS, doc), 2);
});

// 3. 新版取不到时回退旧版
check("新版取不到消息时回退旧选择器", () => {
    const doc = makeDocument({
        [NEW_SELECTOR]: [],
        [LEGACY_SELECTOR]: [makeMessage(""), makeMessage(""), makeMessage("")],
    });

    assert.strictEqual(countAssistantMessages(ASSISTANT_MESSAGE_SELECTORS, doc), 3);
});

// 4. 两套都没有就是 0（新会话）
check("空会话计数为 0", () => {
    assert.strictEqual(countAssistantMessages(ASSISTANT_MESSAGE_SELECTORS, makeDocument({})), 0);
});

// 5. 正文只取消息体，不把 "ChatGPT 说：" 读进来
check("正文只取消息体，不含角色标题", () => {
    const doc = makeDocument({
        [NEW_SELECTOR]: [makeMessage("ChatGPT 说：你好", "你好")],
    });

    assert.deepStrictEqual(readAssistantMessages(ASSISTANT_MESSAGE_SELECTORS, doc), ["你好"]);
});

// 6. 旧版 DOM 没有 MarkdownRoot，回退到整条消息
check("旧版 DOM 回退到整条消息文本", () => {
    const doc = makeDocument({
        [LEGACY_SELECTOR]: [makeMessage("answer text")],
    });

    assert.deepStrictEqual(readAssistantMessages(ASSISTANT_MESSAGE_SELECTORS, doc), [
        "answer text",
    ]);
});

// 7. 思考中：消息存在但正文容器是空的
check("思考中返回空串而不是占位文案", () => {
    const doc = makeDocument({
        [NEW_SELECTOR]: [makeMessage("ChatGPT 说：ChatGPT", "")],
    });

    assert.deepStrictEqual(readAssistantMessages(ASSISTANT_MESSAGE_SELECTORS, doc), [""]);
});

// 8. 多条消息按 DOM 顺序返回，末尾是最新回复
check("多条回复按顺序返回，末尾为最新", () => {
    const doc = makeDocument({
        [NEW_SELECTOR]: [
            makeMessage("ChatGPT 说：第一条", "第一条"),
            makeMessage("ChatGPT 说：第二条", " 第二条 "),
        ],
    });

    assert.deepStrictEqual(readAssistantMessages(ASSISTANT_MESSAGE_SELECTORS, doc), [
        "第一条",
        "第二条",
    ]);
});

// 9. 只使用第一个有结果的选择器，避免新旧 DOM 混读
check("正文读取不混用两套选择器", () => {
    const doc = makeDocument({
        [NEW_SELECTOR]: [makeMessage("", "新")],
        [LEGACY_SELECTOR]: [makeMessage("", "旧1"), makeMessage("", "旧2")],
    });

    assert.deepStrictEqual(readAssistantMessages(ASSISTANT_MESSAGE_SELECTORS, doc), ["新"]);
});

// 10. 停止按钮存在即认为还在生成
check("命中停止按钮即视为生成中", () => {
    const doc = makeDocument({ [GENERATING_SELECTORS[0]]: [{}] });

    assert.strictEqual(detectGenerating(GENERATING_SELECTORS, doc), true);
});

// 11. 生成结束后停止按钮消失
check("停止按钮消失即视为生成结束", () => {
    assert.strictEqual(detectGenerating(GENERATING_SELECTORS, makeDocument({})), false);
});

// 12. 中文 aria-label 也认（旧版/本地化界面）
check("本地化的停止按钮也算生成中", () => {
    assert.ok(GENERATING_SELECTORS.some((selector) => selector.includes("停止")));

    const doc = makeDocument({ 'button[aria-label="停止"]': [{}] });

    assert.strictEqual(detectGenerating(GENERATING_SELECTORS, doc), true);
});

// ------------------------------------------------------------
// 输入阶段：必须走真实键盘输入
// ------------------------------------------------------------

/**
假输入框。evaluate 一旦被调用就说明代码又回去直接改 DOM 了 ——
那条路在 ProseMirror 上只更新显示、不更新编辑器状态，长提示词会被提交成空消息。
*/
function makeFakeInput() {
    return {
        isVisible: async () => true,
        click: async () => {},
        focus: async () => {},
        evaluate: async () => {
            throw new Error("insertMessage 不应直接改写编辑器 DOM");
        },
    };
}

/**
造一个只有 page.keyboard 的 provider：
keyboard.insertText 模拟真实输入，press 记录清空动作。
initialValue 用来模拟"输入框里还留着上一次的半截文本"。
*/
function makeProvider(options) {
    const opts = options || {};
    const provider = new ChatGPTProvider({ autoStart: false });
    const calls = { insertText: [], press: [] };
    let value = opts.initialValue || "";

    provider.findVisibleInput = async () => makeFakeInput();
    provider.getInputValue = async () => value;
    provider.page = {
        keyboard: {
            async insertText(text) {
                calls.insertText.push(text);
                value = opts.truncate ? text.slice(0, 10) : text;
            },
            async press(key) {
                calls.press.push(key);

                if (key === "Backspace") {
                    value = "";
                }
            },
        },
    };

    return { provider, calls };
}

async function checkAsync(name, fn) {
    total += 1;

    try {
        await fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

const LONG_MESSAGE = "读取 package.json 的 version 字段，用一句话回答版本号。\n".repeat(40);

(async () => {
    await checkAsync("长提示词走键盘输入而不是改 DOM", async () => {
        const { provider, calls } = makeProvider();

        await provider.insertMessage(LONG_MESSAGE);

        assert.deepStrictEqual(calls.insertText, [LONG_MESSAGE]);
        assert.ok(LONG_MESSAGE.length > 1000, "用例本身要够长才覆盖得到旧 bug");
    });

    await checkAsync("输入框已有内容时先清空再输入", async () => {
        const { provider, calls } = makeProvider({ initialValue: "残留文本" });

        await provider.insertMessage("新的动作");

        assert.deepStrictEqual(calls.press, ["ControlOrMeta+A", "Backspace"]);
        assert.deepStrictEqual(calls.insertText, ["新的动作"]);
    });

    await checkAsync("输入被截断时报错并重试三次", async () => {
        const { provider, calls } = makeProvider({ truncate: true });

        await assert.rejects(() => provider.insertMessage(LONG_MESSAGE), /mismatch/);
        assert.strictEqual(calls.insertText.length, 3);
    });

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exit(1);
    }
})();
