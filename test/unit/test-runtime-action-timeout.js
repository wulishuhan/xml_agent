/**
内置动作超时兜底的单元测试

覆盖两件事：
1. resolveActionTimeout 的换算（meta 静态值 / exec 跟随 maxExecTimeout）；
2. runBuiltinAction 的真实行为（超时能中止等待、正常结果不被干扰、
   动作自身的错误原样传出、超时之后才抛错不会变成 unhandledRejection）。

限制说明：同步动作（read / write 的 fs.*Sync）在事件循环被占住时定时器无法
触发，这部分没法在单测里"证明打不断"，因此只验异步动作。
*/

const assert = require("assert");
const os = require("os");
const path = require("path");

const { Runtime, resolveActionTimeout } = require("../../runtime");
const agentConfig = require("../../config/agent-config");

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------
// 1. 超时换算
// ---------------------------------------------------------------

check("meta 有效值直接采用", () => {
    assert.strictEqual(resolveActionTimeout("read", { timeoutMs: 15000 }), 15000);
    assert.strictEqual(resolveActionTimeout("answer", { timeoutMs: 5000 }), 5000);
});

check("meta 缺失或非法时视为不限时", () => {
    assert.strictEqual(resolveActionTimeout("read", null), 0);
    assert.strictEqual(resolveActionTimeout("read", {}), 0);
    assert.strictEqual(resolveActionTimeout("read", { timeoutMs: 0 }), 0);
    assert.strictEqual(resolveActionTimeout("read", { timeoutMs: -1 }), 0);
    assert.strictEqual(resolveActionTimeout("read", { timeoutMs: "abc" }), 0);
});

check("exec 默认配置下与 meta 对齐（300s + 30s）", () => {
    assert.strictEqual(agentConfig.runtime.maxExecTimeout, 300000);
    assert.strictEqual(resolveActionTimeout("exec", { timeoutMs: 330000 }), 330000);
});

check("exec 跟随 maxExecTimeout 放大（避免提前切断长命令）", () => {
    const original = agentConfig.runtime.maxExecTimeout;
    try {
        agentConfig.runtime.maxExecTimeout = 600000;
        // 关键回归点：meta 仍是 330000，但有效超时必须跟着配置涨到 630000
        assert.strictEqual(resolveActionTimeout("exec", { timeoutMs: 330000 }), 630000);
    } finally {
        agentConfig.runtime.maxExecTimeout = original;
    }
});

check("exec 配置变小时不回落到 meta 之下（取两者较大值）", () => {
    const original = agentConfig.runtime.maxExecTimeout;
    try {
        agentConfig.runtime.maxExecTimeout = 1000;
        assert.strictEqual(resolveActionTimeout("exec", { timeoutMs: 330000 }), 330000);
    } finally {
        agentConfig.runtime.maxExecTimeout = original;
    }
});

check("非 exec 动作不受 maxExecTimeout 影响", () => {
    const original = agentConfig.runtime.maxExecTimeout;
    try {
        agentConfig.runtime.maxExecTimeout = 900000;
        assert.strictEqual(resolveActionTimeout("write", { timeoutMs: 15000 }), 15000);
    } finally {
        agentConfig.runtime.maxExecTimeout = original;
    }
});

// ---------------------------------------------------------------
// 2. 执行行为
// ---------------------------------------------------------------

const workspace = os.tmpdir();
const runtime = new Runtime(workspace);

check("异步动作超时会中止等待并带 ACTION_TIMEOUT", async () => {
    const definition = {
        meta: { timeoutMs: 60 },
        run: async () => {
            await sleep(2000);
            return { ok: true, action: "slow" };
        },
    };
    const startedAt = Date.now();
    let caught = null;
    try {
        await runtime.runBuiltinAction("slow", definition, null);
    } catch (error) {
        caught = error;
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(caught, "应当抛错");
    assert.strictEqual(caught.code, "ACTION_TIMEOUT");
    assert.strictEqual(caught.action, "slow");
    assert.strictEqual(caught.timeoutMs, 60);
    assert.ok(elapsed < 1000, "应在超时后立刻返回，实际 " + elapsed + "ms");
    assert.ok(caught.message.includes("slow") && caught.message.includes("60ms"));
});

check("正常完成不受超时干扰", async () => {
    const definition = {
        meta: { timeoutMs: 5000 },
        run: async () => ({ ok: true, action: "fast", value: 42 }),
    };
    const result = await runtime.runBuiltinAction("fast", definition, null);
    assert.deepStrictEqual(result, { ok: true, action: "fast", value: 42 });
});

check("同步返回值也能正常透传", async () => {
    const definition = { meta: { timeoutMs: 5000 }, run: () => ({ ok: true, action: "sync" }) };
    const result = await runtime.runBuiltinAction("sync", definition, null);
    assert.strictEqual(result.action, "sync");
});

check("动作自身的错误原样传出（不被当成超时）", async () => {
    const definition = {
        meta: { timeoutMs: 5000 },
        run: async () => {
            throw new Error("Read failed: ENOENT");
        },
    };
    let caught = null;
    try {
        await runtime.runBuiltinAction("boom", definition, null);
    } catch (error) {
        caught = error;
    }
    assert.ok(caught);
    assert.strictEqual(caught.message, "Read failed: ENOENT");
    assert.notStrictEqual(caught.code, "ACTION_TIMEOUT");
});

check("超时之后动作才抛错不会变成 unhandledRejection", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        const definition = {
            meta: { timeoutMs: 40 },
            run: async () => {
                await sleep(120);
                throw new Error("late failure");
            },
        };
        await assert.rejects(
            () => runtime.runBuiltinAction("late", definition, null),
            (error) => error.code === "ACTION_TIMEOUT"
        );
        // 等过动作真正抛错的时刻
        await sleep(200);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
    assert.deepStrictEqual(unhandled, [], "不应有 unhandledRejection");
});

// ---------------------------------------------------------------

(async () => {
    let failed = 0;
    for (const { name, fn } of checks) {
        try {
            await fn();
            console.log("  PASS " + name);
        } catch (error) {
            failed++;
            console.log("  FAIL " + name);
            console.log("       " + (error && error.message));
        }
    }
    console.log("");
    if (failed) {
        console.log("test-runtime-action-timeout: " + failed + "/" + checks.length + " FAILED");
        process.exit(1);
    }
    console.log("test-runtime-action-timeout: " + checks.length + "/" + checks.length + " PASS");
})();
