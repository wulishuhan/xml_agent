/**
插件钩子冒烟（audit-log 真的写盘了吗？）

历史：这个脚本原来只 console.log，不做任何断言，而且读的是
`<storeRoot>/plugins/audit-log/data`——插件的私有数据早已搬到
`<storeRoot>/plugin-data/audit-log/`（见 plugins/registry/storage.js）。
于是它永远打印 `audit lines: 0` 却 exit 0，审计链路实际上零覆盖。

现在按真实契约断言：
1. Agent 的事件会经 registry.emitHook 送到插件；
2. audit-log 把 runtime.result / agent.error 各写一行 JSONL；
3. 行内容里的 action、ok、error 摘要正确；
4. 任何一项不满足就 exit 1。

运行：node test/test-plugin-hooks-smoke.js
*/

const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-hook-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-hookws-"));

const { createRegistry, setRegistryForTests } = require("../plugins/registry");
const reg = createRegistry({
    storeRoot,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
});
reg.load();
setRegistryForTests(reg);

const { Agent } = require("../agent-core");
const agent = new Agent({ workspace: ws, task: "hook check" });

let events = 0;
agent.on("event", () => {
    events += 1;
});

agent.emitEvent("runtime.result", {
    step: 1,
    action: "fetch",
    result: { ok: true, action: "fetch", plugin: "fetch", durationMs: 5 },
});
agent.emitEvent("agent.error", { error: "boom" });

let failed = 0;

function check(name, fn) {
    try {
        fn();
        console.log("PASS - " + name);
    } catch (error) {
        failed += 1;
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

try {
    check("agent 挂上了插件注册表", () => {
        assert.ok(agent.plugins, "agent.plugins is missing");
        assert.strictEqual(agent.plugins, reg);
    });

    check("两个事件都派发出去了", () => {
        assert.strictEqual(events, 2);
    });

    // 插件的私有数据目录：<storeRoot>/plugin-data/<name>
    const auditDir = path.join(storeRoot, "plugin-data", "audit-log");
    const files = fs.existsSync(auditDir)
        ? fs.readdirSync(auditDir).filter((name) => /^audit-\d{8}\.jsonl$/.test(name))
        : [];

    check("audit-log 写出了当天的日志文件", () => {
        assert.strictEqual(files.length, 1, "expected exactly one audit file, got " + files.length);
    });

    const lines = files.length
        ? fs.readFileSync(path.join(auditDir, files[0]), "utf8").trim().split("\n").filter(Boolean)
        : [];

    check("两条事件各写一行", () => {
        assert.strictEqual(lines.length, 2, "expected 2 lines, got " + lines.length);
    });

    check("runtime.result 的摘要字段完整", () => {
        const entry = JSON.parse(lines[0]);

        assert.strictEqual(entry.event, "runtime.result");
        assert.strictEqual(entry.action, "fetch");
        assert.strictEqual(entry.ok, true);
        assert.strictEqual(entry.plugin, "fetch");
        assert.ok(entry.ts, "missing ts");
    });

    check("agent.error 的错误信息被记录", () => {
        const entry = JSON.parse(lines[1]);

        assert.strictEqual(entry.event, "agent.error");
        assert.strictEqual(entry.error, "boom");
    });
} finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
}

if (failed > 0) {
    process.exitCode = 1;
}
