const assert = require("assert");
const { SYSTEM_PROMPT } = require("../../prompts/system-prompt");
const { getRuntimeOkPrompt, getRuntimeErrorPrompt } = require("../../prompts/runtime-prompt");
const { extractAction } = require("../../parse/json-action");
const { findJsonObjects } = require("../../parse/json-candidate");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
        console.log("PASS - " + name);
        return;
    }
    console.log("FAIL - " + name + (detail ? "  [" + detail + "]" : ""));
}

function parseSafely(snippet) {
    try {
        return { action: extractAction(snippet), error: null };
    } catch (error) {
        return { action: null, error: error.message };
    }
}

const DOCUMENTED = [
    {
        name: "read 目录",
        snippet: '{"action":"read","params":{"path":"."}}',
        action: "read",
        params: { path: "." },
    },
    {
        name: "write",
        snippet:
            '{"action":"write","params":{"path":"src/a.js","content":"console.log(\\"hello\\");\\n"}}',
        action: "write",
        params: { path: "src/a.js", content: 'console.log("hello");\n' },
    },
    {
        name: "edit",
        snippet:
            '{"action":"edit","params":{"path":"src/a.js","changes":[{"old":"const port = 3000;","new":"const port = 3001;"}]}}',
        action: "edit",
        params: {
            path: "src/a.js",
            changes: [{ old: "const port = 3000;", new: "const port = 3001;" }],
            all: false,
        },
    },
    {
        name: "exec",
        snippet: '{"action":"exec","params":{"command":"npm test"}}',
        action: "exec",
        params: { command: "npm test" },
    },
    {
        name: "screenshot",
        snippet:
            '{"action":"screenshot","params":{"targets":[{"source":"screen","path":"screenshots/desktop.png"}]}}',
        action: "screenshot",
        params: {
            targets: [{ source: "screen", path: "screenshots/desktop.png", fullPage: false }],
        },
    },
    {
        name: "answer",
        snippet: '{"action":"answer","params":{"content":"最终答案"}}',
        action: "answer",
        params: { content: "最终答案" },
    },
    {
        name: "done",
        snippet: '{"action":"done","params":{}}',
        action: "done",
        params: {},
    },
];

function actionObjects(text) {
    const actions = [];
    for (const candidate of findJsonObjects(text)) {
        try {
            const value = JSON.parse(candidate);
            if (
                value &&
                typeof value.action === "string" &&
                value.params &&
                typeof value.params === "object"
            ) {
                actions.push(value);
            }
        } catch (error) {
            // 非 JSON 示例由对应的拒绝用例覆盖。
        }
    }
    return actions;
}

function main() {
    console.log("=== 1. 文档化示例：逐条能被解析 ===");
    for (const item of DOCUMENTED) {
        check("示例出现在提示词里：" + item.name, SYSTEM_PROMPT.indexOf(item.snippet) !== -1);
        const { action, error } = parseSafely(item.snippet);
        if (!action) {
            check("可解析：" + item.name, false, error);
            continue;
        }
        check("动作名正确：" + item.name, action.action === item.action, String(action.action));
        check(
            "参数正确：" + item.name,
            JSON.stringify(action.params) === JSON.stringify(item.params),
            JSON.stringify(action.params)
        );
    }

    console.log("\n=== 2. 提示词里的单行示例全部可解析 ===");
    const singleLine = SYSTEM_PROMPT.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{"action":') && line.endsWith("}"));
    check(
        "确实找到单行示例",
        singleLine.length === DOCUMENTED.length,
        "count=" + singleLine.length
    );
    for (const line of singleLine) {
        const expected = JSON.parse(line).action;
        const { action, error } = parseSafely(line);
        check(
            "单行示例可解析：" + expected,
            Boolean(action) && action.action === expected,
            error || (action ? action.action : "null")
        );
    }

    console.log("\n=== 3. 每轮提示词里的动作同样可解析 ===");
    const runtimePrompts = [
        getRuntimeOkPrompt({ ok: true, action: "read", path: "a.js", content: "x" }),
        getRuntimeErrorPrompt({ ok: false, action: "exec", error: "boom" }),
    ];
    for (const prompt of runtimePrompts) {
        const snippets = actionObjects(prompt);
        check("每轮提示词至少给出一个动作示例", snippets.length >= 1, "count=" + snippets.length);
        for (const snippet of snippets) {
            const { action, error } = parseSafely(JSON.stringify(snippet));
            check("每轮提示词的动作可解析：" + snippet.action, Boolean(action), error || "null");
        }
    }

    console.log("\n=== 4. Schema 错误会被拒绝 ===");
    {
        const { action, error } = parseSafely('{"action":"read","params":{"file":"package.json"}}');
        check("缺 path 的 read 被拒", !action, error || "竟然通过了");
    }
    {
        const { action, error } = parseSafely('{"action":"exec","params":{}}');
        check("缺 command 的 exec 被拒", !action, error || "竟然通过了");
    }
    {
        const { action, error } = parseSafely('{"action":"exec","params":{"command":123}}');
        check("错误类型被拒", !action, error || "竟然通过了");
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);
    if (pass !== total) {
        assert.fail("prompt examples test failed");
    }
}

main();
