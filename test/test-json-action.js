/**
 * JSON Action 解析回归测试
 *
 * 新协议：模型回复 {"action":"read","params":{"path":"a.js"}}。
 * parse/json-action.js 只返回 {action, params, plugin?}，候选 JSON 的提取由
 * parse/json-candidate.js 负责，参数形状由 parse/action-schema.js 校验。
 *
 * 运行：node test/test-json-action.js
 */

const assert = require("assert");
const { extractAction } = require("../parse/json-action");
const { extractActionEnvelope, findJsonObjects } = require("../parse/json-candidate");
const { ACTION_SCHEMA, validateParams } = require("../parse/action-schema");

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

function actionJson(action, params) {
    return JSON.stringify({ action, params });
}

function captureError(response) {
    try {
        extractAction(response);
        return null;
    } catch (error) {
        return error.message;
    }
}

function expectError(name, response, pattern) {
    check(name, () => {
        const message = captureError(response);
        assert.ok(message, "expected extractAction to throw");
        assert.match(message, pattern);
    });
}

console.log("=== 1. 合法 envelope 与候选提取 ===");
check("裸 JSON 返回 action/params", () => {
    assert.deepStrictEqual(extractAction(actionJson("read", { path: "a.js" })), {
        action: "read",
        params: { path: "a.js" },
    });
});

check("json 代码块可解析", () => {
    const response = "```json\n" + actionJson("read", { path: "a.js" }) + "\n```";
    assert.deepStrictEqual(extractAction(response), {
        action: "read",
        params: { path: "a.js" },
    });
});

check("无语言标记的代码块可解析", () => {
    const response = "```\n" + actionJson("done", {}) + "\n```";
    assert.deepStrictEqual(extractAction(response), { action: "done", params: {} });
});

check("动作前后的说明文字可忽略", () => {
    const response =
        "我会先读取文件。\n" + actionJson("read", { path: "a.js" }) + "\n然后继续处理。";
    assert.strictEqual(extractAction(response).params.path, "a.js");
});

check("说明文字里的无效花括号不干扰合法动作", () => {
    const response = "说明 {不是 JSON}\n" + actionJson("read", { path: "a.js" }) + "\n结束";
    assert.strictEqual(extractAction(response).action, "read");
});

check("嵌套 targets 对象与数组可解析", () => {
    const params = {
        targets: [
            { source: "screen", path: "a.png" },
            { source: "screen", path: "b.png" },
        ],
    };
    const parsed = extractAction(actionJson("screenshot", params));
    assert.strictEqual(parsed.action, "screenshot");
    assert.strictEqual(parsed.params.targets.length, 2);
    assert.strictEqual(parsed.params.targets[1].path, "b.png");
    assert.strictEqual(parsed.plugin, "screenshot");
});

check("edit 的 all 默认值由 Schema 补为 false", () => {
    const parsed = extractAction(
        actionJson("edit", { path: "a.js", changes: [{ old: "a", new: "b" }] })
    );
    assert.strictEqual(parsed.params.all, false);
});

check("read 接受 offset/limit 续读参数", () => {
    assert.deepStrictEqual(
        extractAction(actionJson("read", { path: "a.js", offset: 4000, limit: 2000 })),
        {
            action: "read",
            params: { path: "a.js", offset: 4000, limit: 2000 },
        }
    );
});

check("首轮 Schema 允许插件动作，同时约束内置动作参数", () => {
    assert.strictEqual(
        validateParams(ACTION_SCHEMA, { action: "custom-plugin", params: { value: 1 } }).ok,
        true
    );
    assert.strictEqual(validateParams(ACTION_SCHEMA, { action: "read", params: {} }).ok, false);
});

console.log("\n=== 2. 字符串花括号与转义内容 ===");
check("content 中的嵌套 JSON 按字符串原样保留", () => {
    const content = 'prefix {"nested":{"items":[1,2,3]}} suffix';
    const parsed = extractAction(actionJson("write", { path: "data.txt", content }));
    assert.strictEqual(parsed.params.content, content);
});

check("content 中的动作示例不会被当成第二个动作", () => {
    const content = '示例：{"action":"done","params":{}}；还有 } 和 {';
    const parsed = extractAction(actionJson("write", { path: "readme.md", content }));
    assert.strictEqual(parsed.action, "write");
    assert.strictEqual(parsed.params.content, content);
});

check("params 内嵌套的动作形状对象不会被当成第二个动作", () => {
    const envelope = {
        action: "custom-plugin",
        params: { payload: { action: "done", params: {} } },
    };
    const text = JSON.stringify(envelope);
    assert.strictEqual(findJsonObjects(text).length, 1);
    assert.deepStrictEqual(extractActionEnvelope(text), envelope);
});

check("动作前未闭合的花括号不会挡住后续合法动作", () => {
    const response = "说明 {未闭合\n" + actionJson("read", { path: "a.js" });
    assert.deepStrictEqual(extractActionEnvelope(response), {
        action: "read",
        params: { path: "a.js" },
    });
});

check("answer 中的动作形状字符串不会触发多动作错误", () => {
    const content = '{"action":"done","params":{}}';
    const parsed = extractAction(actionJson("answer", { content }));
    assert.strictEqual(parsed.action, "answer");
    assert.strictEqual(parsed.params.content, content);
});

check("换行、CRLF、制表符、引号、反斜杠与 Unicode 均逐字还原", () => {
    const content = '\nfirst\r\n\t"quoted" \\path\\ {"x":1} 雪  \n';
    const parsed = extractAction(actionJson("write", { path: "escape.txt", content }));
    assert.strictEqual(parsed.params.content, content);
});

check("JSON Unicode 转义还原为对应字符", () => {
    const response = '{"action":"answer","params":{"content":"\\u96ea\\n\\\"quoted\\\""}}';
    assert.strictEqual(extractAction(response).params.content, '雪\n"quoted"');
});

console.log("\n=== 3. JSON 语法与 envelope 反例 ===");
expectError("空响应被拒绝", "", /empty response/);
expectError("纯说明文字被拒绝", "hello world", /JSON action must be an object/);
expectError("非字符串响应被拒绝", null, /empty response/);
expectError("缺少右花括号的 JSON 被拒绝", '{"action":"read","params":{"path":"a.js"}', /./);
expectError(
    "尾随逗号被拒绝",
    '{"action":"read","params":{"path":"a.js",},}',
    /Invalid JSON action/
);
expectError(
    "单引号 JSON 被拒绝",
    "{'action':'read','params':{'path':'a.js'}}",
    /Invalid JSON action/
);
expectError(
    "字符串中的非法 \\x 转义被拒绝",
    '{"action":"read","params":{"path":"a\\x41.js"}}',
    /Invalid JSON action/
);
expectError(
    "字符串中的非法 Unicode 转义被拒绝",
    '{"action":"read","params":{"path":"a\\u12ZZ.js"}}',
    /Invalid JSON action/
);
expectError(
    "字符串内未转义换行被拒绝",
    '{"action":"read","params":{"path":"a\nb.js"}}',
    /Invalid JSON action/
);
expectError(
    "两个独立动作 envelope 被拒绝",
    actionJson("read", { path: "a.js" }) + "\n" + actionJson("done", {}),
    /Exactly one JSON action is required, but received 2/
);
expectError(
    "代码块内外各一个动作也被拒绝",
    "```json\n" + actionJson("read", { path: "a.js" }) + "\n```\n" + actionJson("done", {}),
    /Exactly one JSON action is required, but received 2/
);

const invalidEnvelopes = [
    ["缺少 action", '{"params":{"path":"a.js"}}'],
    ["缺少 params", '{"action":"read"}'],
    ["action 不是字符串", '{"action":1,"params":{}}'],
    ["params 是数组", '{"action":"read","params":[]}'],
    ["params 是 null", '{"action":"read","params":null}'],
];
for (const [name, response] of invalidEnvelopes) {
    expectError(name + " 被拒绝", response, /JSON action must be an object/);
}

expectError(
    "envelope 额外字段被 Schema 拒绝",
    '{"action":"read","params":{"path":"a.js"},"extra":true}',
    /must NOT have additional propert(?:y 'extra'|ies)/
);

console.log("\n=== 4. 未知动作与 Schema 类型 ===");
check("未知动作报 Unknown action", () => {
    assert.strictEqual(
        captureError(actionJson("no-such-action", {})),
        "Unknown action: no-such-action"
    );
});

const schemaCases = [
    ["read.path 必须是字符串", "read", { path: 1 }, /\/path must be string/],
    ["read.offset 不能是负数", "read", { path: "a.js", offset: -1 }, /\/offset must be >= 0/],
    ["read.offset 必须是整数", "read", { path: "a.js", offset: 1.5 }, /\/offset must be integer/],
    ["read.limit 必须大于 0", "read", { path: "a.js", limit: 0 }, /\/limit must be >= 1/],
    ["read.limit 不能超过 4000", "read", { path: "a.js", limit: 4001 }, /\/limit must be <= 4000/],
    [
        "write.content 必须是字符串",
        "write",
        { path: "a.txt", content: 1 },
        /\/content must be string/,
    ],
    ["write 缺少 content", "write", { path: "a.txt" }, /required property 'content'/],
    ["edit.changes 必须是数组", "edit", { path: "a.txt", changes: {} }, /\/changes must be array/],
    ["edit.changes 不能为空", "edit", { path: "a.txt", changes: [] }, /fewer than 1 items/],
    [
        "edit.old 必须是字符串",
        "edit",
        { path: "a.txt", changes: [{ old: 1, new: "x" }] },
        /\/old must be string/,
    ],
    [
        "edit.new 必须是字符串",
        "edit",
        { path: "a.txt", changes: [{ old: "x", new: null }] },
        /\/new must be string/,
    ],
    [
        "edit.all 必须是布尔值",
        "edit",
        { path: "a.txt", changes: [{ old: "x", new: "y" }], all: "true" },
        /\/all must be boolean/,
    ],
    ["exec.command 必须是字符串", "exec", { command: false }, /\/command must be string/],
    ["answer.content 必须是字符串", "answer", { content: [] }, /\/content must be string/],
    [
        "done 不接受参数",
        "done",
        { unexpected: true },
        /additional properties|more than 0 properties/,
    ],
    [
        "edit 最多接受 20 个 change",
        "edit",
        { path: "a.txt", changes: Array.from({ length: 21 }, () => ({ old: "x", new: "y" })) },
        /must NOT have more than 20 items/,
    ],
];
for (const [name, action, params, pattern] of schemaCases) {
    expectError(name, actionJson(action, params), pattern);
}

expectError(
    "edit 参数额外字段被拒绝",
    actionJson("edit", { path: "a.txt", changes: [{ old: "x", new: "y" }], extra: true }),
    /must NOT have additional propert(?:y 'extra'|ies)/
);
expectError(
    "全空白 write 内容被语义校验拒绝",
    actionJson("write", { path: "a.txt", content: " \n\t " }),
    /write content cannot be empty/
);
expectError(
    "全空白 edit.old 被语义校验拒绝",
    actionJson("edit", { path: "a.txt", changes: [{ old: " \n", new: "y" }] }),
    /edit change requires non-empty old/
);
expectError(
    "全空白 answer 内容被语义校验拒绝",
    actionJson("answer", { content: " \n\t " }),
    /answer content cannot be empty/
);

console.log("\n=== 5. 后加载的插件动作可见 ===");
{
    const registryApi = require("../plugins/registry");
    const previousRegistry = registryApi.getRegistry();
    registryApi.setRegistryForTests({
        hasAction: (name) => name === "late-plugin",
        validateAction: (name, params) => ({ ok: true, value: params }),
        getActionPluginName: () => "late-plugin-fixture",
    });
    try {
        check("不会永久缓存第一次取得的注册表", () => {
            assert.deepStrictEqual(extractAction(actionJson("late-plugin", { value: 1 })), {
                action: "late-plugin",
                params: { value: 1 },
                plugin: "late-plugin-fixture",
            });
        });
    } finally {
        registryApi.setRegistryForTests(previousRegistry);
    }
}

console.log("");
console.log("Result: " + pass + "/" + total + " tests passed");
process.exit(pass === total ? 0 : 1);
