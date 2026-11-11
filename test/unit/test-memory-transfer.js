/**
会话记忆转移的单元测试

覆盖三层：
1. 核心 transfer（四种模式、目标新建/已存在、各种拒绝条件、截断、深拷贝）；
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

check("目录清单里的会话摘要带 outputChars（面板据此判断要不要压）", () => {
    const store = makeStore({ aaa: sourceRecord() });
    const list = memoryTransfer.listMemories({ store });
    assert.strictEqual(list[0].outputCount, 2);
    assert.ok(list[0].outputChars > 0, "应给出字符量：" + list[0].outputChars);
});

// ---------------------------------------------------------------
// 1b. 压缩（搬之前先瘦身）
// ---------------------------------------------------------------

check("默认 auto：小会话原样搬，不付有损的代价", () => {
    const store = makeStore({ aaa: sourceRecord() });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "records", store });
    assert.strictEqual(result.compression.level, "off");
    assert.strictEqual(result.compression.beforeCount, 2);
    assert.ok(!result.warnings.some((item) => /记忆压缩/.test(item)), "没压就不该有压缩提示");
});

check("compress=light：去掉事件副本、折叠过程噪声，并说明省了多少", () => {
    const records = [];
    for (let i = 0; i < 20; i++) {
        records.push({
            id: "p" + i,
            type: "stdout",
            content: "Provider request (step " + i + ")",
            timestamp: i,
        });
    }
    records.push({
        id: "big",
        type: "stdout",
        content: "R".repeat(9000),
        timestamp: 99,
        event: { type: "runtime.result", result: { text: "R".repeat(9000) } },
    });
    const store = makeStore({ aaa: { info: sourceInfo(), output: records } });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "records",
        store,
        compress: "light",
    });
    assert.strictEqual(result.compression.level, "light");
    assert.ok(result.compression.afterChars < result.compression.beforeChars);
    assert.ok(result.compression.savedPercent > 0);
    assert.ok(
        result.warnings.some((item) => /记忆压缩（light）/.test(item)),
        JSON.stringify(result.warnings)
    );

    const written = store.files.get("bbb");
    assert.ok(
        written.output.every((item) => !item.event),
        "搬过去的历史不应再带事件副本"
    );
    assert.ok(
        written.output.some((item) => /合并了 20 条过程提示/.test(item.content)),
        "连续噪声应被折叠"
    );
    assert.ok(
        written.output.some((item) => /省略 \d+ 字符/.test(item.content)),
        "超长单条应被截断"
    );
});

check("compress=strong：按预算省略中段，开头与结尾都保留", () => {
    const records = [];
    for (let i = 0; i < 40; i++) {
        records.push({
            id: "r" + i,
            type: "stdout",
            content: "第 " + i + " 步：" + "z".repeat(400),
            timestamp: i,
        });
    }
    const store = makeStore({ aaa: { info: sourceInfo(), output: records } });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "records",
        store,
        compress: "strong",
        maxChars: 3000,
    });
    const written = store.files.get("bbb");
    const contents = written.output.map((item) => item.content);
    assert.ok(contents[0].startsWith("第 0 步"), "开头保留");
    assert.ok(
        contents.some((item) => /省略中段/.test(item)),
        "应有中段省略说明"
    );
    assert.ok(
        contents[contents.length - 2].startsWith("第 39 步"),
        "最后一条源记录之后才是来源说明"
    );
    assert.ok(result.compression.savedPercent > 50, "强压应显著变小");
});

check("compress=off：明确要求原样搬时不压缩", () => {
    const records = [];
    for (let i = 0; i < 10; i++) {
        records.push({ id: "r" + i, type: "stdout", content: "x".repeat(500), timestamp: i });
    }
    const store = makeStore({ aaa: { info: sourceInfo(), output: records } });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "records",
        store,
        compress: "off",
        maxChars: 100,
    });
    assert.strictEqual(result.compression.level, "off");
    assert.strictEqual(result.compression.afterChars, result.compression.beforeChars);
    // 超过 maxRecords 的兜底截断仍然生效（压缩关了不等于保护也关了）
    assert.strictEqual(result.copied.records, 10);
});

check("mode=link 不压缩：根本没搬记录，没什么可压的", () => {
    const store = makeStore({ aaa: sourceRecord() });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "link",
        store,
        compress: "strong",
    });
    assert.strictEqual(result.compression, null);
});

check("previewCompression 只读：给出统计，不创建也不修改任何会话", () => {
    const records = [];
    for (let i = 0; i < 30; i++) {
        records.push({
            id: "r" + i,
            type: "stdout",
            content: "内容 " + i + "：" + "q".repeat(300),
            timestamp: i,
            event: { type: "x" },
        });
    }
    const store = makeStore({ aaa: { info: sourceInfo(), output: records } });
    const before = JSON.stringify(store.files.get("aaa"));
    const preview = memoryTransfer.previewCompression({
        from: "aaa",
        compress: "auto",
        maxChars: 2000,
        store,
    });
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.requested, "auto");
    assert.ok(preview.stats.after.chars < preview.stats.before.chars);
    assert.ok(/记忆压缩/.test(preview.summary), preview.summary);
    assert.deepStrictEqual(Array.from(store.files.keys()), ["aaa"], "不应凭空写入新会话");
    assert.strictEqual(JSON.stringify(store.files.get("aaa")), before, "源会话一个字节都不该变");
});

check("非法 compress 档位报错（错误码可被插件映射）", () => {
    const store = makeStore({ aaa: sourceRecord() });
    assert.throws(
        () => memoryTransfer.transfer({ from: "aaa", to: "bbb", store, compress: "ultra" }),
        (error) => error.code === "MEMORY_COMPRESS_INVALID"
    );
});

// ---------------------------------------------------------------
// 1c. 摘要（让模型真的能读到历史）
// ---------------------------------------------------------------

/** 带 event 的记录：摘要要靠 event 里的 action / result 才能提炼。 */
const DIGEST_OUTPUT = [
    {
        id: "d1",
        type: "stdout",
        content: "Runtime action: write",
        timestamp: 10,
        event: {
            type: "runtime.result",
            result: { ok: true, action: "write", path: "src/ch3.md" },
        },
    },
    {
        id: "d2",
        type: "stdout",
        content: "Runtime action: exec",
        timestamp: 20,
        event: {
            type: "runtime.result",
            result: { ok: false, action: "exec", command: "npm test", exitCode: 1, error: "boom" },
        },
    },
];

check("records 模式自动生成摘要：写回调收到路径与正文，task 里要求先 read", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    const writes = [];
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "records",
        store,
        writeDigest: (relativePath, markdown, meta) => {
            writes.push({ relativePath, markdown, meta });
            return { path: relativePath };
        },
    });
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].relativePath, ".xml-agent-memory/bbb.md");
    assert.ok(/## 改过的文件/.test(writes[0].markdown), "摘要正文应是 markdown");
    assert.strictEqual(writes[0].meta.workspace, "D:\\ws", "写入口要拿到目标工作区用于校验");

    assert.ok(result.digest, "结果里要有摘要元信息");
    assert.strictEqual(result.digest.file, ".xml-agent-memory/bbb.md");
    assert.ok(result.digest.chars > 0);
    assert.strictEqual(result.digest.markdown, null, "已落盘就不必把正文塞回结果");
    assert.ok(
        /开工前先 read `\.xml-agent-memory\/bbb\.md`/.test(store.files.get("bbb").info.task),
        "task 必须写清楚去 read 哪个文件：" + store.files.get("bbb").info.task
    );
});

check("full 模式接上了 provider 线程时不生成摘要（模型本来就记得）", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    let writes = 0;
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "full",
        store,
        writeDigest: () => {
            writes++;
            return {};
        },
    });
    assert.strictEqual(result.copied.conversationId, true);
    assert.strictEqual(result.digest, null);
    assert.strictEqual(writes, 0, "不该写文件");
});

check("full 但源没有线程时仍生成摘要（否则模型一片空白）", () => {
    const store = makeStore({
        aaa: { info: sourceInfo({ conversationId: null }), output: DIGEST_OUTPUT },
    });
    let writes = 0;
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "full",
        store,
        writeDigest: (relativePath) => {
            writes++;
            return { path: relativePath };
        },
    });
    assert.strictEqual(result.copied.conversationId, false);
    assert.strictEqual(writes, 1);
    assert.ok(result.digest.file);
});

check("digest=off 不生成；digest=always 即使接上线程也生成", () => {
    const offStore = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    const off = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "records",
        store: offStore,
        digest: "off",
        writeDigest: () => {
            throw new Error("不该被调用");
        },
    });
    assert.strictEqual(off.digest, null);

    const alwaysStore = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    const always = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "full",
        store: alwaysStore,
        digest: "always",
        writeDigest: (relativePath) => ({ path: relativePath }),
    });
    assert.ok(always.digest && always.digest.file);
});

check("摘要写入失败时转移仍然成功，只降级成 warning", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "records",
        store,
        writeDigest: () => {
            throw new Error("目标会话的工作区与当前工作区不同");
        },
    });
    assert.strictEqual(result.ok, true, "记录已经搬好，不该因为摘要失败而回滚");
    assert.strictEqual(result.digest.file, null);
    assert.ok(result.digest.markdown, "落盘失败时把正文带回去，调用方还能自己处理");
    assert.ok(
        result.warnings.some((item) => /摘要写入失败/.test(item)),
        result.warnings.join(" | ")
    );
    assert.ok(
        !/开工前先 read/.test(store.files.get("bbb").info.task),
        "没写成功就不该让 task 指向一个不存在的文件"
    );
});

check("没提供写入口时给出提示，而不是静默丢摘要", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    const result = memoryTransfer.transfer({ from: "aaa", to: "bbb", mode: "records", store });
    assert.strictEqual(result.digest.file, null);
    assert.ok(result.digest.markdown);
    assert.ok(result.warnings.some((item) => /没有提供摘要写入口/.test(item)));
});

check("previewDigest 只读：返回摘要正文与统计，不写文件不改会话", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    const before = JSON.stringify(store.files.get("aaa"));
    const preview = memoryTransfer.previewDigest({ from: "aaa", to: "bbb", store });
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.path, ".xml-agent-memory/bbb.md");
    assert.ok(/## 改过的文件/.test(preview.markdown));
    assert.strictEqual(preview.counts.calls, 2);
    assert.deepStrictEqual(Array.from(store.files.keys()), ["aaa"]);
    assert.strictEqual(JSON.stringify(store.files.get("aaa")), before);
});

check("非法 digest 档位报错", () => {
    const store = makeStore({ aaa: sourceRecord() });
    assert.throws(
        () => memoryTransfer.transfer({ from: "aaa", to: "bbb", store, digest: "sometimes" }),
        (error) => error.code === "MEMORY_DIGEST_INVALID"
    );
});

// ---------------------------------------------------------------
// 1b. 省略目标 id（Web 端「转移并新开」用）
// ---------------------------------------------------------------

check("省略 to 时自动生成新会话 id 并落盘", () => {
    const store = makeStore();
    store.files.set("aaa", {
        info: { id: "aaa", workspace: "D:\\ws", provider: "deepseek", task: "写第 3 章" },
        output: [{ id: "r1", type: "stdout", content: "hello", timestamp: 1 }],
    });
    const result = memoryTransfer.transfer({ from: "aaa", mode: "records", store });
    assert.match(
        result.to,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        "应生成 uuid 形式的新 id，实际 " + result.to
    );
    assert.notStrictEqual(result.to, "aaa");
    assert.ok(store.files.has(result.to), "新会话应当已经落盘");
    assert.strictEqual(result.created, true);
});

check("from 仍然必填，不会顺手生成一个源会话", () => {
    assert.throws(
        () => memoryTransfer.transfer({ mode: "records", store: makeStore() }),
        /from 不能为空/
    );
});

// ---------------------------------------------------------------
// 4. digest 模式：只带任务 + 摘要
// ---------------------------------------------------------------

check("digest 模式：记录一条不搬，只留一行来源说明", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "digest",
        store,
        writeDigest: (relativePath) => ({ path: relativePath }),
    });

    assert.strictEqual(result.copied.records, 0, "digest 不搬过程记录");
    assert.strictEqual(result.compression, null, "没搬记录就没有压缩这回事");

    const saved = store.files.get("bbb");
    assert.strictEqual(saved.output.length, 1, "只有一行来源说明，界面不该又长一遍");
    assert.strictEqual(saved.output[0].type, "system");
    assert.ok(/只带摘要/.test(saved.output[0].content), saved.output[0].content);
    assert.ok(/aaa/.test(saved.output[0].content), "说明里要写清来自哪个会话");
    assert.ok(
        !result.warnings.some((item) => /压缩/.test(item)),
        "没有压缩就不该报压缩相关的 warning：" + result.warnings.join(" | ")
    );
});

check("digest 模式：任务照搬并追加接手提示，模型不会接手一个空任务", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "digest",
        store,
        writeDigest: (relativePath) => ({ path: relativePath }),
    });

    assert.strictEqual(result.copied.task, true);
    const task = store.files.get("bbb").info.task;
    assert.ok(task.startsWith("写完第 3 章"), "源任务原话要保留：" + task);
    assert.ok(/开工前先 read/.test(task), "摘要路径要写进 task，否则模型读不到");
    assert.ok(result.digest && result.digest.file, "digest 模式必须落一份摘要");
});

check("digest 模式：即使源有 conversationId 也不接续（否则还是那条满线程）", () => {
    const store = makeStore({
        aaa: { info: sourceInfo({ conversationId: "conv-aaa" }), output: DIGEST_OUTPUT },
    });
    const result = memoryTransfer.transfer({
        from: "aaa",
        to: "bbb",
        mode: "digest",
        store,
        writeDigest: (relativePath) => ({ path: relativePath }),
    });

    assert.strictEqual(result.copied.conversationId, false, "接上旧线程等于没换会话");
    assert.strictEqual(store.files.get("bbb").info.conversationId, null);
});

check("digest 模式配 digest=off 直接拒绝（否则什么都没搬）", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    assert.throws(
        () =>
            memoryTransfer.transfer({
                from: "aaa",
                to: "bbb",
                mode: "digest",
                digest: "off",
                store,
            }),
        (error) => error.code === "MEMORY_DIGEST_REQUIRED"
    );
    assert.strictEqual(store.files.has("bbb"), false, "拒绝时不该留下半成品会话");
});

check("digest 模式下摘要写不进工作区就整体失败，不留空会话", () => {
    const store = makeStore({ aaa: { info: sourceInfo(), output: DIGEST_OUTPUT } });
    assert.throws(
        () =>
            memoryTransfer.transfer({
                from: "aaa",
                to: "bbb",
                mode: "digest",
                store,
                writeDigest: () => {
                    throw new Error("工作区不可写");
                },
            }),
        (error) => error.code === "MEMORY_DIGEST_WRITE_FAILED" && /工作区不可写/.test(error.message)
    );
    assert.strictEqual(
        store.files.has("bbb"),
        false,
        "摘要没写成，这个模式就没有内容可留，不该建一个只有 task 的空会话"
    );
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
        // 第三个权限是写摘要 md 用的：摘要必须落在工作区里，模型才 read 得到
        assert.deepStrictEqual(action.def.meta.permission, [
            "sessions:read",
            "sessions:write",
            "workspace:write",
        ]);

        const routes = record.apiRoutes.map((item) => item.method + " " + item.path);
        assert.ok(routes.includes("GET /sessions"), routes.join(", "));
        assert.ok(routes.includes("POST /transfer"), routes.join(", "));
        assert.ok(routes.includes("POST /preview"), routes.join(", "));
        assert.ok(routes.includes("POST /digest"), routes.join(", "));
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

        // 预览接口只读：给统计，不创建会话
        const previewResponse = await registry.callPluginApi(
            "memory-transfer",
            "POST",
            "/preview",
            { body: { from: sourceId, compress: "light" } }
        );
        assert.strictEqual(previewResponse.status, 200);
        assert.strictEqual(previewResponse.body.ok, true);
        assert.strictEqual(previewResponse.body.preview.from, sourceId);
        assert.strictEqual(previewResponse.body.preview.stats.before.count, 2);
    } finally {
        fs.rmSync(storeRoot, { recursive: true, force: true });
    }
});

check("插件接口也能落摘要：走 HTTP 的 mode=digest 不能退化成空会话", async () => {
    const { PluginRegistry } = require("../../plugins/registry");
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-mt-digestapi-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-mt-ws-"));
    const stamp = Date.now();
    const sourceId = "mt-dgsrc-" + stamp;
    const targetId = "mt-dgdst-" + stamp;
    try {
        const manager = makeManager([
            makeLiveSession(sourceInfo({ id: sourceId, workspace }), DIGEST_OUTPUT, false),
        ]);
        const registry = new PluginRegistry({ enabled: true, storeRoot });
        registry.setHostSessions(manager);
        registry.load();

        // 接口路径拿不到"当前工作区"，只能靠目标会话自己记录的 workspace。
        // 这条用例就是盯住这个分支：webui 的一键转移走的正是它。
        const response = await registry.callPluginApi("memory-transfer", "POST", "/transfer", {
            body: { from: sourceId, to: targetId, mode: "digest" },
        });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.ok, true, JSON.stringify(response.body));
        const result = response.body.result;
        assert.strictEqual(result.copied.records, 0);
        const digestFile = path.join(workspace, ".xml-agent-memory", targetId + ".md");
        assert.ok(fs.existsSync(digestFile), "摘要应落到目标会话的工作区：" + digestFile);
        assert.ok(/## 任务/.test(fs.readFileSync(digestFile, "utf8")), "落盘的应该是摘要正文");
    } finally {
        fs.rmSync(storeRoot, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

check("插件动作真的把摘要写进工作区（模型才 read 得到）", async () => {
    const { PluginRegistry } = require("../../plugins/registry");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-mt-ws-"));
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-mt-store-"));
    const stamp = Date.now();
    const sourceId = "mt-digest-src-" + stamp;
    const targetId = "mt-digest-dst-" + stamp;
    try {
        const manager = makeManager([
            makeLiveSession(
                sourceInfo({ id: sourceId, workspace, conversationId: null }),
                DIGEST_OUTPUT,
                false
            ),
        ]);
        const registry = new PluginRegistry({ enabled: true, storeRoot });
        registry.setHostSessions(manager);
        registry.load();

        const result = await registry.invokeAction(
            "memory-transfer",
            { "@_from": sourceId, "@_to": targetId, "@_mode": "records" },
            // runtime 就是这样把 workspace 与解析器交给插件的
            { workspace, resolvePath: (target) => path.resolve(workspace, String(target || "")) }
        );

        assert.strictEqual(result.ok, true, result.error || "");
        assert.ok(result.digest && result.digest.file, "结果应带摘要文件路径");
        const file = path.join(workspace, ".xml-agent-memory", targetId + ".md");
        assert.ok(fs.existsSync(file), "摘要应真的落到工作区：" + file);
        const markdown = fs.readFileSync(file, "utf8");
        assert.ok(/## 改过的文件/.test(markdown), "摘要内容应是提炼过的事实");
        assert.ok(markdown.includes(sourceId), "摘要要写明来自哪个会话");
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(storeRoot, { recursive: true, force: true });
    }
});

check("目标工作区与当前不同时，摘要不落盘且只给警告", async () => {
    const { PluginRegistry } = require("../../plugins/registry");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-mt-ws2-"));
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-mt-store2-"));
    const stamp = Date.now();
    const sourceId = "mt-digest-x-" + stamp;
    try {
        const manager = makeManager([
            makeLiveSession(
                // 源会话在另一个工作区：写进当前 workspace 也没人会去 read
                sourceInfo({ id: sourceId, workspace: "D:\\elsewhere", conversationId: null }),
                DIGEST_OUTPUT,
                false
            ),
        ]);
        const registry = new PluginRegistry({ enabled: true, storeRoot });
        registry.setHostSessions(manager);
        registry.load();

        const result = await registry.invokeAction(
            "memory-transfer",
            { "@_from": sourceId, "@_to": "mt-digest-y-" + stamp, "@_mode": "records" },
            { workspace, resolvePath: (target) => path.resolve(workspace, String(target || "")) }
        );
        assert.strictEqual(result.ok, true, "记录照样搬，不该因为摘要失败而整体失败");
        assert.strictEqual(result.digest.file, null);
        assert.ok(
            result.warnings.some((item) => /工作区/.test(item)),
            result.warnings.join(" | ")
        );
        assert.ok(
            !fs.existsSync(path.join(workspace, ".xml-agent-memory")),
            "不该在无关工作区里留下目录"
        );
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
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
