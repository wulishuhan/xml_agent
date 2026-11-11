/**
会话记忆转移的单元测试

覆盖三层：
1. 核心 transfer（三种模式、目标新建/已存在、各种拒绝条件、截断、深拷贝）；
2. 插件能力门面 ctx.sessions（未授权时拒绝、授权后能搬）；
3. 插件本身（注册的动作、面板、接口，以及接口走的同一条实现）。

不发消息、不碰真实浏览器；会话存储用内存假件，管理器用假件，
因此不会污染 ~/.xml-agent/webui-sessions。
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const memoryTransfer = require("../../webui/session/memory-transfer");
const { createSessionMemory } = require("../../plugins/session-memory");

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

// ---------------------------------------------------------------
// 假件：会话存储与管理器
// ---------------------------------------------------------------

function makeStore(records = {}) {
    const files = new Map(Object.entries(records));
    return {
        files,
        loadSession(id) {
            return files.has(id) ? JSON.parse(JSON.stringify(files.get(id))) : null;
        },
        writeRecord(id, payload) {
            files.set(id, JSON.parse(JSON.stringify({ info: { id }, output: payload.output })));
            files.get(id).info = Object.assign({}, payload.info, { id });
            return id;
        },
        listSavedSessions() {
            return Array.from(files.values()).map((item) => JSON.parse(JSON.stringify(item)));
        },
    };
}

/** 假会话：只需要 transfer 用到的那几个方法。 */
function makeLiveSession(info, output = [], running = false) {
    return {
        running,
        info,
        output,
        getInfo() {
            return Object.assign({}, this.info);
        },
        getOutput() {
            return this.output;
        },
        isRunning() {
            return this.running;
        },
    };
}

function makeManager(sessions = [], capacity = { ok: true }) {
    const map = new Map(sessions.map((session) => [session.info.id, session]));
    return {
        map,
        absorbed: [],
        get(id) {
            return map.get(id) || null;
        },
        list() {
            return Array.from(map.values());
        },
        checkCapacity() {
            return capacity;
        },
        absorbRecord(payload) {
            this.absorbed.push(payload);
            const existing = map.get(payload.info.id);
            if (existing) {
                existing.info = Object.assign({}, payload.info);
                existing.output = payload.output;
                return existing;
            }
            const created = makeLiveSession(payload.info, payload.output, false);
            map.set(payload.info.id, created);
            return created;
        },
    };
}

const OUTPUT = [
    { id: "o1", type: "system", content: "🚀 Starting agent...", timestamp: 1 },
    { id: "o2", type: "stdout", content: "第一步", timestamp: 2 },
];

function sourceInfo(overrides = {}) {
    return Object.assign(
        {
            id: "aaa",
            conversationId: "conv-aaa",
            workspace: "D:\\ws",
            provider: "deepseek",
            task: "写完第 3 章",
            execScope: "workspace",
            status: "completed",
            runCount: 2,
            createdAt: 100,
            finishedAt: 200,
        },
        overrides
    );
}

function sourceRecord(overrides = {}) {
    return { info: sourceInfo(overrides), output: JSON.parse(JSON.stringify(OUTPUT)) };
}

// ---------------------------------------------------------------
// 1. 核心转移
// ---------------------------------------------------------------

check("full 模式：记录 + 任务 + 模型上下文一起搬到新会话", () => {
    const store = makeStore({ aaa: sourceRecord() });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "full", store });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.created, true);
    // copied.records 只数源会话搬过来多少条，不含两行系统说明
    assert.strictEqual(result.copied.records, 2, "源会话有 2 条记录");
    assert.strictEqual(result.copied.task, true);
    assert.strictEqual(result.copied.conversationId, true);
    assert.strictEqual(result.target.outputCount, 3, "2 条源记录 + 1 行来源说明");
    assert.strictEqual(result.target.hasConversation, true);

    const written = store.files.get("bbb");
    assert.strictEqual(written.info.id, "bbb");
    assert.strictEqual(written.info.task, "写完第 3 章");
    assert.strictEqual(written.info.conversationId, "conv-aaa");
    assert.strictEqual(written.info.workspace, "D:\\ws", "新建目标沿用源的 workspace");
    assert.strictEqual(written.info.running, false, "新建目标不能是运行态");
    assert.strictEqual(written.info.status, "completed");
    assert.ok(/记忆已从会话 aaa/.test(written.output[written.output.length - 1].content));
});

check("默认模式是 full（不传 mode 时两层都搬）", () => {
    const store = makeStore({ aaa: sourceRecord() });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", store });
    assert.strictEqual(result.mode, "full");
    assert.strictEqual(result.copied.conversationId, true);
});

check("records 模式：只搬记录，conversationId 不搬", () => {
    const store = makeStore({ aaa: sourceRecord() });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "records", store });
    assert.strictEqual(result.copied.records, 2);
    assert.strictEqual(result.copied.conversationId, false);
    assert.strictEqual(store.files.get("bbb").info.conversationId, null);
    assert.strictEqual(result.target.hasConversation, false);
});

check("link 模式：只接续模型上下文，记录留一行来源说明", () => {
    const store = makeStore({ aaa: sourceRecord() });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "link", store });
    assert.strictEqual(result.copied.conversationId, true);
    assert.strictEqual(result.copied.records, 0);
    const written = store.files.get("bbb");
    assert.strictEqual(written.output.length, 1, "只有来源说明这一行");
    assert.ok(/接续模型上下文/.test(written.output[0].content));
    assert.strictEqual(written.info.conversationId, "conv-aaa");
    // link 也要带 task：task 为空的新会话连 start() 都过不了
    assert.strictEqual(written.info.task, "写完第 3 章");
});

check("目标已存在：保留它自己的 workspace 与 createdAt，只覆盖记忆字段", () => {
    const store = makeStore({
        aaa: sourceRecord(),
        bbb: {
            info: {
                id: "bbb",
                workspace: "D:\\other",
                provider: "deepseek",
                task: "旧任务",
                createdAt: 999,
                status: "completed",
            },
            output: [{ id: "x", type: "system", content: "旧记录", timestamp: 5 }],
        },
    });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "records", store });
    assert.strictEqual(result.created, false);
    const written = store.files.get("bbb");
    assert.strictEqual(written.info.workspace, "D:\\other");
    assert.strictEqual(written.info.createdAt, 999);
    assert.strictEqual(written.info.task, "写完第 3 章");
    assert.ok(written.output.length >= 1);
    assert.ok(!written.output.some((item) => item && item.content === "旧记录"), "旧记录被替换");
});

check("from 与 to 相同直接拒绝", () => {
    const store = makeStore({ aaa: sourceRecord() });
    assert.throws(
        () => memoryTransfer.transfer({ from: "aaa", to: "aaa", store }),
        (error) => error.code === "MEMORY_SAME_ID"
    );
});

check("源会话不存在时报错", () => {
    const store = makeStore({});
    assert.throws(
        () => memoryTransfer.transfer({ from: "nope", to: "bbb", store }),
        (error) => error.code === "MEMORY_SOURCE_NOT_FOUND"
    );
});

check("源会话正在运行时拒绝（读到的是半截记录）", () => {
    const manager = makeManager([makeLiveSession(sourceInfo(), OUTPUT, true)]);
    assert.throws(
        () => memoryTransfer.transfer({ from: "aaa", to: "bbb", manager }),
        (error) => error.code === "MEMORY_SOURCE_RUNNING"
    );
});

check("目标会话正在运行时拒绝（写入会被下一次 persist 冲掉）", () => {
    const manager = makeManager([
        makeLiveSession(sourceInfo(), OUTPUT, false),
        makeLiveSession(
            {
                id: "bbb",
                workspace: "D:\\ws",
                provider: "deepseek",
                task: "跑着",
                status: "running",
            },
            [],
            true
        ),
    ]);
    assert.throws(
        () => memoryTransfer.transfer({ from: "aaa", to: "bbb", manager }),
        (error) => error.code === "MEMORY_TARGET_RUNNING"
    );
});

check("provider 不一致时跳过 conversationId 并给出 warning", () => {
    const store = makeStore({
        aaa: sourceRecord({ provider: "deepseek" }),
        bbb: {
            info: { id: "bbb", workspace: "D:\\ws", provider: "qwen", task: "旧", createdAt: 1 },
            output: [],
        },
    });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "full", store });
    assert.strictEqual(result.copied.conversationId, false);
    assert.ok(
        result.warnings.some((item) => /provider 不同/.test(item)),
        "应有 provider 不一致的提示：" + JSON.stringify(result.warnings)
    );
    assert.strictEqual(store.files.get("bbb").info.conversationId, null);
});

check("源没有 conversationId 时 link 模式给出提示", () => {
    const store = makeStore({ aaa: sourceRecord({ conversationId: null }) });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "link", store });
    assert.strictEqual(result.copied.conversationId, false);
    assert.ok(result.warnings.some((item) => /没有可接续的线程/.test(item)));
});

check("记录条数超上限时只留最近的部分并说明", () => {
    const many = [];
    for (let i = 0; i < 10; i++) {
        many.push({ id: "r" + i, type: "stdout", content: "第 " + i + " 条", timestamp: i });
    }
    const store = makeStore({ aaa: { info: sourceInfo(), output: many } });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "records",
        store,
        maxRecords: 3,
    });
    const written = store.files.get("bbb");
    assert.ok(result.warnings.some((item) => /超过上限 3/.test(item)));
    // 1 行截断说明 + 3 条尾部 + 1 行来源说明
    assert.strictEqual(written.output.length, 5);
    assert.ok(/省略了较早的 7 条/.test(written.output[0].content));
    assert.strictEqual(written.output[1].content, "第 7 条", "保留的是尾部");
});

check("搬过去的是副本，改目标不影响源", () => {
    const store = makeStore({ aaa: sourceRecord() });
    memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "records", store });
    store.files.get("bbb").output[0].content = "被改了";
    assert.strictEqual(store.files.get("aaa").output[0].content, "🚀 Starting agent...");
});

check("有管理器时走 absorbRecord（内存与磁盘同步），不直接写 store", () => {
    const manager = makeManager([makeLiveSession(sourceInfo(), OUTPUT, false)]);
    const store = makeStore({});
    let storeWrites = 0;
    store.writeRecord = () => {
        storeWrites++;
    };
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "full",
        manager,
        store,
    });
    assert.strictEqual(result.created, true);
    assert.strictEqual(manager.absorbed.length, 1);
    assert.strictEqual(storeWrites, 0);
    assert.ok(manager.map.get("bbb"), "管理器里应出现新会话");
});

check("管理器容量不足时拒绝新建", () => {
    const manager = makeManager([makeLiveSession(sourceInfo(), OUTPUT, false)], {
        ok: false,
        message: "会话数量已达上限（10/10）",
    });
    assert.throws(
        () => memoryTransfer.transfer({ from: "aaa", to: "bbb", manager }),
        (error) => error.code === "MEMORY_CAPACITY"
    );
});

check("非法 mode 与非法会话 id 都会报错", () => {
    const store = makeStore({ aaa: sourceRecord() });
    assert.throws(
        () => memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "everything", store }),
        (error) => error.code === "MEMORY_MODE_INVALID"
    );
    assert.throws(
        () => memoryTransfer.transfer({ from: "aaa", to: "../evil", store }),
        (error) => error.code === "MEMORY_ID_INVALID"
    );
    assert.throws(
        () => memoryTransfer.transfer({ from: "", to: "bbb", store }),
        (error) => error.code === "MEMORY_ID_REQUIRED"
    );
});

check("列表接口给出会话摘要且最近的在前", () => {
    const store = makeStore({
        aaa: sourceRecord({ finishedAt: 200 }),
        bbb: {
            info: {
                id: "bbb",
                provider: "qwen",
                workspace: "D:\\ws",
                task: "较新",
                finishedAt: 900,
            },
            output: [],
        },
    });
    const list = memoryTransfer.listMemories({ store });
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, "bbb");
    assert.strictEqual(list[0].provider, "qwen");
    assert.strictEqual(list[1].outputCount, 2);
});

// ---------------------------------------------------------------
// 2. 能力门面（ctx.sessions）
// ---------------------------------------------------------------

check("未授权时门面是拒绝态：列表为空、转移抛错", () => {
    const facade = createSessionMemory({ canRead: false, canWrite: false });
    assert.strictEqual(facade.denied, true);
    assert.deepStrictEqual(facade.list(), []);
    assert.throws(
        () => facade.transfer({ from: "aaa", to: "bbb" }),
        (error) => error.code === "SESSIONS_DENIED"
    );
});

check("只有读权限时能列会话但不能写", () => {
    const manager = makeManager([makeLiveSession(sourceInfo(), OUTPUT, false)]);
    const store = makeStore({ aaa: sourceRecord() });
    const facade = createSessionMemory({ manager, store, canRead: true, canWrite: false });
    assert.strictEqual(facade.list().length, 1, "只应看到假件里的会话，不读真实目录");
    assert.throws(
        () => facade.transfer({ from: "aaa", to: "bbb" }),
        (error) => error.code === "SESSIONS_DENIED"
    );
});

check("读写都授权时能完成转移", () => {
    const manager = makeManager([makeLiveSession(sourceInfo(), OUTPUT, false)]);
    const facade = createSessionMemory({
        manager,
        store: makeStore({}),
        canRead: true,
        canWrite: true,
        maxRecords: 100,
    });
    const result = facade.transfer({ from: "aaa", to: "bbb", mode: "full" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.copied.conversationId, true);
});

// ---------------------------------------------------------------
// 3. 插件本身
// ---------------------------------------------------------------

check("插件注册了动作 / 接口 / 面板，且动作声明了两个会话权限", () => {
    const { PluginRegistry } = require("../../plugins/registry");
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-mt-plugin-"));
    try {
        const registry = new PluginRegistry({ enabled: true, storeRoot });
        registry.load();
        const record = registry.plugins.get("memory-transfer");
        assert.ok(record, "插件应被加载");
        assert.strictEqual(record.status, "loaded", record.error || "");

        const action = registry.actions.get("memory-transfer");
        assert.ok(action, "动作应注册");
        assert.deepStrictEqual(action.def.meta.permission, ["sessions:read", "sessions:write"]);

        const routes = record.apiRoutes.map((item) => item.method + " " + item.path);
        assert.ok(routes.includes("GET /sessions"), routes.join(", "));
        assert.ok(routes.includes("POST /transfer"), routes.join(", "));
        assert.ok(
            registry.ui.panels.some((item) => item.panel && item.panel.id === "memory-transfer"),
            "应注册面板"
        );
    } finally {
        fs.rmSync(storeRoot, { recursive: true, force: true });
    }
});

check("插件接口 POST /transfer 与动作走同一条实现", async () => {
    const { PluginRegistry } = require("../../plugins/registry");
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-mt-api-"));
    // 插件的能力门面由宿主装配，测试无法注入 store，因此这里用不会撞车的 id，
    // 避免和真实会话目录里的记录互相干扰。
    const stamp = Date.now();
    const sourceId = "mt-src-" + stamp;
    const targetId = "mt-dst-" + stamp;
    try {
        const manager = makeManager([makeLiveSession(sourceInfo({ id: sourceId }), OUTPUT, false)]);
        const registry = new PluginRegistry({ enabled: true, storeRoot });
        registry.setHostSessions(manager);
        registry.load();

        const okResponse = await registry.callPluginApi("memory-transfer", "POST", "/transfer", {
            body: { from: sourceId, to: targetId, mode: "full" },
        });
        assert.strictEqual(okResponse.status, 200);
        assert.strictEqual(okResponse.body.ok, true);
        assert.strictEqual(okResponse.body.result.copied.conversationId, true);
        assert.strictEqual(okResponse.body.result.to, targetId);

        const badResponse = await registry.callPluginApi("memory-transfer", "POST", "/transfer", {
            body: { from: sourceId, to: sourceId },
        });
        assert.strictEqual(badResponse.body.ok, false);
        assert.strictEqual(badResponse.body.code, "MEMORY_SAME_ID");

        const listResponse = await registry.callPluginApi(
            "memory-transfer",
            "GET",
            "/sessions",
            {}
        );
        assert.ok(Array.isArray(listResponse.body.sessions));
        // 列表只给摘要，不能把 output 正文带出去
        assert.ok(listResponse.body.sessions.every((item) => item.output === undefined));
    } finally {
        fs.rmSync(storeRoot, { recursive: true, force: true });
    }
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
        console.log("test-memory-transfer: " + failed + "/" + checks.length + " FAILED");
        process.exit(1);
    }
    console.log("test-memory-transfer: " + checks.length + "/" + checks.length + " PASS");
})();
