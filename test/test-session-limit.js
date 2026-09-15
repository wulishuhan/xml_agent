/**
会话上限与磁盘占用测试。

用一个临时目录替换真实存储根目录，避免污染用户数据：
通过设置环境变量无法改变 STORE_ROOT（它是模块加载时计算的），
因此这里直接 monkey-patch session-store 的 STORE_ROOT 相关函数行为，
改用内存桩件来验证 SessionManager 的容量判定逻辑。
*/

const assert = require("assert");
const path = require("path");
const Module = require("module");

// 拦截 session-store，用一个内存桩件替代真实文件存储
const storePath = require.resolve("../webui/session/session-store.js");
const realStore = require(storePath);

const fakeStore = {
    STORE_ROOT: "<memory>",
    _count: 0,
    _bytes: 0,
    saveSession() {
        return "<memory>";
    },
    deleteSession() {
        return true;
    },
    listSavedSessions() {
        return [];
    },
    loadSession() {
        return null;
    },
    getStoreStats() {
        return {
            root: "<memory>",
            count: this._count,
            bytes: this._bytes,
            largest: null,
            orphanTmpBytes: 0,
        };
    },
    cleanOrphanTmpFiles() {
        return 0;
    },
};

require.cache[storePath].exports = fakeStore;

// 强制重新加载 session-manager，使其拿到桩件
const managerPath = require.resolve("../webui/session/session-manager.js");
delete require.cache[managerPath];
const { SessionManager, formatBytes } = require(managerPath);

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log("PASS " + name);
    } catch (error) {
        failed += 1;
        console.log("FAIL " + name);
        console.log(" " + error.message);
    }
}

// 用极小上限构造 manager
function makeManager(overrides = {}) {
    const manager = new SessionManager();
    manager.maxSessions = overrides.maxSessions ?? 3;
    manager.maxDiskBytes = overrides.maxDiskBytes ?? 1000;
    manager.warnThreshold = overrides.warnThreshold ?? 0.8;
    return manager;
}

const workspace = path.join(__dirname, "..");

check("未达上限时可以创建会话", () => {
    fakeStore._count = 0;
    fakeStore._bytes = 0;
    const manager = makeManager();
    const session = manager.create({ workspace, task: "t1", provider: "chatgpt" });
    assert.ok(session && session.id, "session 应被创建");
    assert.strictEqual(manager.list().length, 1);
});

check("达到会话数量上限时拒绝创建，code=MAX_SESSIONS", () => {
    fakeStore._count = 0;
    fakeStore._bytes = 0;
    const manager = makeManager({ maxSessions: 2 });
    manager.create({ workspace, task: "a", provider: "chatgpt" });
    manager.create({ workspace, task: "b", provider: "chatgpt" });

    let error = null;
    try {
        manager.create({ workspace, task: "c", provider: "chatgpt" });
    } catch (e) {
        error = e;
    }

    assert.ok(error, "第 3 个会话应被拒绝");
    assert.strictEqual(error.code, "MAX_SESSIONS");
    assert.strictEqual(manager.list().length, 2, "仍应只有 2 个会话");
});

check("磁盘占用超限时拒绝创建，code=MAX_DISK", () => {
    fakeStore._count = 0;
    fakeStore._bytes = 2000; // 超过 maxDiskBytes=1000
    const manager = makeManager({ maxSessions: 100, maxDiskBytes: 1000 });

    let error = null;
    try {
        manager.create({ workspace, task: "x", provider: "chatgpt" });
    } catch (e) {
        error = e;
    }

    assert.ok(error, "磁盘超限应拒绝创建");
    assert.strictEqual(error.code, "MAX_DISK");
});

check("删除会话后释放名额，可以再次创建", () => {
    fakeStore._count = 0;
    fakeStore._bytes = 0;
    const manager = makeManager({ maxSessions: 1 });
    const first = manager.create({ workspace, task: "first", provider: "chatgpt" });

    // 满了
    assert.throws(() => manager.create({ workspace, task: "second", provider: "chatgpt" }));

    // 删除第一个后又能创建
    manager.remove(first.id);
    assert.strictEqual(manager.list().length, 0);
    const second = manager.create({ workspace, task: "second", provider: "chatgpt" });
    assert.ok(second && second.id);
    assert.strictEqual(manager.list().length, 1);
});

check("getStorageStats 反映数量/体积/告警比例", () => {
    fakeStore._count = 4;
    fakeStore._bytes = 800;
    const manager = makeManager({ maxSessions: 10, maxDiskBytes: 1000, warnThreshold: 0.8 });
    // 手动塞 8 个会话以满足数量比 = 0.8
    for (let i = 0; i < 8; i++) {
        manager.create({ workspace, task: "t" + i, provider: "chatgpt" });
    }

    const stats = manager.getStorageStats();
    assert.strictEqual(stats.sessions, 8);
    assert.strictEqual(stats.maxSessions, 10);
    assert.strictEqual(stats.bytes, 800);
    assert.strictEqual(stats.maxDiskBytes, 1000);
    // diskRatio = 0.8, sessionRatio = 0.8 => ratio 0.8 => warn true
    assert.ok(stats.warn, "应触发告警");
    assert.ok(!stats.overLimit, "未达到 1 不应标记超限");
});

check("formatBytes 正常格式化", () => {
    assert.strictEqual(formatBytes(0), "0 B");
    assert.strictEqual(formatBytes(512), "512 B");
    assert.strictEqual(formatBytes(1024), "1.0 KB");
    assert.strictEqual(formatBytes(1024 * 1024), "1.0 MB");
});

console.log("");
console.log("Session limit tests: " + passed + " passed, " + failed + " failed");

process.exitCode = failed > 0 ? 1 : 0;
