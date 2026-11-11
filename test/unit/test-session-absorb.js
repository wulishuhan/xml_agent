/**
SessionManager.absorbRecord 的单元测试

这个方法是「记忆转移」把目标会话塞进管理器的唯一入口，之前只有假件覆盖：
假件按 payload.info.id 入表，而真实实现曾经按构造函数生成的随机 id 入表，
于是 sessions 的 key 与 session.id 对不上 —— 刚转移完就 GET /api/sessions/<to>
404，界面弹「会话不存在」。这个测试就是防止那个顺序再被改回去。

不写真实磁盘：把 sessionStore.saveSession 换成记录参数的假函数。
*/

const assert = require("assert");
const path = require("path");

const sessionStore = require("../../webui/session/session-store");
const { SessionManager } = require("../../webui/session/session-manager");

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

/** 临时把落盘换掉，返回收集到的写入调用。 */
function capturePersist() {
    const original = sessionStore.saveSession;
    const saved = [];
    sessionStore.saveSession = (session) => {
        saved.push({ id: session.id, task: session.task, output: session.getOutput() });
        return null;
    };
    return {
        saved,
        restore() {
            sessionStore.saveSession = original;
        },
    };
}

function targetInfo(overrides = {}) {
    return Object.assign(
        {
            id: "target-session-id",
            workspace: path.join(__dirname, "..", ".."),
            provider: "deepseek",
            task: "接手：把第 3 章写完",
            conversationId: null,
            execScope: "workspace",
            status: "completed",
            runCount: 1,
            createdAt: 1700000000000,
            startedAt: 1700000001000,
            finishedAt: 1700000002000,
        },
        overrides
    );
}

const OUTPUT = [
    { id: "o1", type: "system", content: "🚚 记忆已从会话 aaa 转移", timestamp: 1 },
    { id: "o2", type: "stdout", content: "第一步", timestamp: 2 },
];

// ---------------------------------------------------------------

check("新 id 入表后能用原 id 取到（不是构造函数的随机 id）", () => {
    const persist = capturePersist();
    try {
        const manager = new SessionManager();
        const session = manager.absorbRecord({ info: targetInfo(), output: OUTPUT });
        assert.strictEqual(session.id, "target-session-id");
        assert.strictEqual(manager.get("target-session-id"), session);
        assert.strictEqual(manager.sessions.size, 1);
        // key 与实例 id 必须一致：不一致就是 404 的根因
        assert.strictEqual(Array.from(manager.sessions.keys())[0], "target-session-id");
    } finally {
        persist.restore();
    }
});

check("恢复的内容完整：task、output、状态不是 running", () => {
    const persist = capturePersist();
    try {
        const manager = new SessionManager();
        const session = manager.absorbRecord({ info: targetInfo(), output: OUTPUT });
        assert.strictEqual(session.task, "接手：把第 3 章写完");
        assert.strictEqual(session.getOutput().length, 2);
        assert.strictEqual(session.getOutput()[1].content, "第一步");
        assert.strictEqual(session.isRunning(), false);
        assert.strictEqual(session.status, "completed");
    } finally {
        persist.restore();
    }
});

check("落盘用的文件名就是 info.id", () => {
    const persist = capturePersist();
    try {
        const manager = new SessionManager();
        manager.absorbRecord({ info: targetInfo(), output: OUTPUT });
        assert.strictEqual(persist.saved.length, 1);
        assert.strictEqual(persist.saved[0].id, "target-session-id");
    } finally {
        persist.restore();
    }
});

check("同一个 id 再 absorb 是覆盖，不会多出一个会话", () => {
    const persist = capturePersist();
    try {
        const manager = new SessionManager();
        const first = manager.absorbRecord({ info: targetInfo(), output: OUTPUT });
        const second = manager.absorbRecord({
            info: targetInfo({ task: "改了任务", status: "error" }),
            output: [OUTPUT[0]],
        });
        assert.strictEqual(first, second);
        assert.strictEqual(manager.sessions.size, 1);
        assert.strictEqual(second.task, "改了任务");
        assert.strictEqual(second.getOutput().length, 1);
    } finally {
        persist.restore();
    }
});

check("已存在的普通会话被 absorb 时保持原实例", () => {
    const persist = capturePersist();
    try {
        const manager = new SessionManager();
        const live = manager.create({
            workspace: path.join(__dirname, "..", ".."),
            provider: "deepseek",
            task: "原来的任务",
            conversationId: null,
        });
        const absorbed = manager.absorbRecord({
            info: targetInfo({ id: live.id }),
            output: OUTPUT,
        });
        assert.strictEqual(absorbed, live);
        assert.strictEqual(manager.sessions.size, 1);
        assert.strictEqual(absorbed.task, "接手：把第 3 章写完");
    } finally {
        persist.restore();
    }
});

check("没有 info.id 直接拒绝", () => {
    const manager = new SessionManager();
    assert.throws(() => manager.absorbRecord({ info: {} }), /requires info\.id/);
    assert.throws(() => manager.absorbRecord(null), /requires info\.id/);
});

// ---------------------------------------------------------------

let failed = 0;
for (const item of checks) {
    try {
        item.fn();
        console.log("PASS - " + item.name);
    } catch (error) {
        failed++;
        console.log("  FAIL " + item.name);
        console.log("       " + (error && error.message));
    }
}
console.log("");
if (failed) {
    console.log("test-session-absorb: " + failed + "/" + checks.length + " FAILED");
    process.exit(1);
}
console.log("test-session-absorb: " + checks.length + "/" + checks.length + " PASS");
