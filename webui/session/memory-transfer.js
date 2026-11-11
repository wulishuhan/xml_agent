/**
会话记忆转移

把一个会话的"记忆"写到另一个会话 id 上。这里的记忆有两层，来源不同：
- 记录：output（过程日志）+ task（任务描述）—— 决定界面上能不能回看之前发生了什么；
- 模型上下文：info.conversationId —— provider 侧的对话线程 id，决定下一句话模型记不记得。

三种模式（mode）：
- full（默认）：两层都搬，换会话接着做；
- records：只搬记录，模型从新对话开始（安全，不会串味）；
- link：只接续模型线程，界面保持空白（除了一行来源说明）。

为什么有这些约束（每条都对应一个真实的坏结果）：
- from === to 直接拒绝：只会把 output 自己乘一遍，条目翻倍。
- 目标正在运行直接拒绝：运行中的会话每次落盘都会覆盖，搬过去的记录会被下一次
  persist 冲掉，界面还会出现两条时间线。
- provider 不一致时不能复用 conversationId：那是 provider 侧的 id（DeepSeek 的 id
  拿到 Qwen 上是无效值），强行写入会让下一次运行直接报错。full 会降级成 records 并回 warning。
- output 有上限：会话可能有上万条输出，整包搬进另一个会话会同时撑大磁盘和前端渲染。
  超出时保留尾部（最近的更有用）并插一行说明。
- 图片不搬：images 是一次性上传的运行时状态，恢复时不还原（见 AgentSession.restore）。
*/

const defaultStore = require("./session-store");

/** 一次最多搬多少条 output；超出保留尾部。 */
const DEFAULT_MAX_RECORDS = 2000;

const MODES = ["full", "records", "link"];

function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeMode(value) {
    const mode = String(value || "full")
        .trim()
        .toLowerCase();
    if (MODES.indexOf(mode) === -1) {
        throw createError(
            "MEMORY_MODE_INVALID",
            "mode 只能是 " + MODES.join(" / ") + "，收到：" + value
        );
    }
    return mode;
}

/**
会话 id 校验：这里只做"能不能当文件名"的检查，不查存在性。
长度上限与 sessionStore 的路径安全处理保持一致，避免出现两张不同的白名单。
*/
function normalizeId(value, label) {
    const id = String(value === undefined || value === null ? "" : value).trim();
    if (!id) {
        throw createError("MEMORY_ID_REQUIRED", label + " 不能为空");
    }
    if (id.length > 128) {
        throw createError("MEMORY_ID_INVALID", label + " 过长（最多 128 字符）");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        throw createError("MEMORY_ID_INVALID", label + " 只允许字母/数字/下划线/横线，收到：" + id);
    }
    return id;
}

/** 从内存里的活会话或磁盘读一份 {info, output}。内存优先（可能尚未落盘）。 */
function readMemory(id, { store, manager }) {
    const live = manager && typeof manager.get === "function" ? manager.get(id) : null;
    if (live && typeof live.getInfo === "function") {
        return {
            info: live.getInfo(),
            output: typeof live.getOutput === "function" ? live.getOutput() || [] : [],
            live: true,
            running: typeof live.isRunning === "function" ? live.isRunning() : false,
        };
    }
    const record = typeof store.loadSession === "function" ? store.loadSession(id) : null;
    if (record && record.info) {
        return {
            info: record.info,
            output: Array.isArray(record.output) ? record.output : [],
            live: false,
            running: false,
        };
    }
    return null;
}

/** 会话摘要：列表与转移结果都用它，避免两处字段口径不一致。 */
function describeMemory(memory) {
    if (!memory) {
        return { exists: false };
    }
    const info = memory.info || {};
    return {
        exists: true,
        id: info.id,
        provider: info.provider || null,
        workspace: info.workspace || null,
        task: String(info.task || ""),
        status: info.status || null,
        running: memory.running === true,
        outputCount: Array.isArray(memory.output) ? memory.output.length : 0,
        hasConversation: Boolean(info.conversationId),
        conversationId: info.conversationId || null,
        createdAt: info.createdAt || null,
        finishedAt: info.finishedAt || null,
    };
}

/** 列出现有会话（内存 + 磁盘，按 id 去重，最近的在前）。limit 传 0 表示不限。 */
function listMemories({ store = defaultStore, manager = null, limit = 50 } = {}) {
    const byId = new Map();
    if (manager && typeof manager.list === "function") {
        for (const session of manager.list()) {
            const memory = {
                info: session.getInfo(),
                output: typeof session.getOutput === "function" ? session.getOutput() : [],
                running: typeof session.isRunning === "function" ? session.isRunning() : false,
            };
            byId.set(memory.info.id, memory);
        }
    }
    if (typeof store.listSavedSessions === "function") {
        for (const record of store.listSavedSessions()) {
            const info = record && record.info;
            if (!info || !info.id || byId.has(info.id)) {
                continue;
            }
            byId.set(info.id, {
                info,
                output: Array.isArray(record.output) ? record.output : [],
                running: false,
            });
        }
    }
    const all = Array.from(byId.values()).map(describeMemory);
    // 最近活跃的在前：finishedAt 可能为空（新建未跑），退回 createdAt
    all.sort((a, b) => (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0));
    const wanted = limit === undefined ? 50 : Math.trunc(Number(limit));
    return wanted > 0 ? all.slice(0, wanted) : all;
}

/** 单个会话摘要（存在性判断与详情展示共用）。 */
function describeById(id, { store = defaultStore, manager = null } = {}) {
    const target = normalizeId(id, "id");
    const memory = readMemory(target, { store, manager });
    return memory ? describeMemory(memory) : { exists: false, id: target };
}

/**
把 output 复制一份（不共享引用：改目标会话不应该污染源会话的数组）。

超出上限时保留尾部，并在最前面插一行说明 —— 让人一眼看出"前面还有内容被截掉了"。
*/
function copyOutput(output, maxRecords, warnings, sourceId) {
    const records = Array.isArray(output) ? output : [];
    let kept = records;
    if (records.length > maxRecords) {
        const dropped = records.length - maxRecords;
        kept = records.slice(records.length - maxRecords);
        warnings.push(
            "源会话有 " +
                records.length +
                " 条记录，超过上限 " +
                maxRecords +
                "，只搬了最近 " +
                maxRecords +
                " 条（省略 " +
                dropped +
                " 条）"
        );
        kept = [
            {
                id: "memory-transfer-truncated",
                type: "system",
                content:
                    "（记忆搬移时省略了较早的 " +
                    dropped +
                    " 条记录，完整记录仍在会话 " +
                    sourceId +
                    "）",
                timestamp: Date.now(),
            },
        ].concat(kept);
    }
    // 浅拷贝：目标会话与源会话不能共享同一批对象，否则改一边会影响另一边
    return kept.map((item) => (item && typeof item === "object" ? Object.assign({}, item) : item));
}

/**
执行转移。

返回：
    {
      ok, from, to, mode, created, warnings,
      source: 会话摘要, target: 会话摘要,
      copied: { records, task, conversationId }
    }
失败时抛错，error.code 以 MEMORY_ 开头，便于插件映射成给模型看的文案。
*/
function transfer(options = {}) {
    const store = options.store || defaultStore;
    const manager = options.manager || null;
    const from = normalizeId(options.from, "from");
    const to = normalizeId(options.to, "to");
    const mode = normalizeMode(options.mode);
    const maxRecords =
        Number(options.maxRecords) > 0
            ? Math.trunc(Number(options.maxRecords))
            : DEFAULT_MAX_RECORDS;

    if (from === to) {
        throw createError("MEMORY_SAME_ID", "from 与 to 不能是同一个会话：" + from);
    }

    const source = readMemory(from, { store, manager });
    if (!source) {
        throw createError("MEMORY_SOURCE_NOT_FOUND", "会话 " + from + " 不存在");
    }
    if (source.running) {
        // 源在跑：此刻读到的记录是半截的，搬过去只会得到一个断掉的时间线
        throw createError(
            "MEMORY_SOURCE_RUNNING",
            "会话 " + from + " 正在运行，请先停止再转移记忆"
        );
    }

    const targetExisting = readMemory(to, { store, manager });
    if (targetExisting && targetExisting.running) {
        throw createError(
            "MEMORY_TARGET_RUNNING",
            "目标会话 " + to + " 正在运行，请先停止再写入记忆"
        );
    }

    const created = !targetExisting;
    if (created && manager && typeof manager.checkCapacity === "function") {
        const capacity = manager.checkCapacity();
        if (!capacity.ok) {
            throw createError("MEMORY_CAPACITY", capacity.message);
        }
    }

    const sourceInfo = source.info || {};
    const targetInfo = targetExisting ? targetExisting.info || {} : {};
    const now = Date.now();
    const warnings = [];

    // 目标存在就保留它自己的元信息（创建时间、工作区），只覆盖"记忆"相关的字段；
    // 目标不存在则用源的 workspace/provider 造一个能直接继续用的空壳会话。
    const base = targetExisting
        ? Object.assign({}, targetInfo)
        : {
              id: to,
              conversationId: null,
              workspace: sourceInfo.workspace || null,
              provider: sourceInfo.provider || null,
              task: sourceInfo.task || "",
              images: [],
              execScope: sourceInfo.execScope || "workspace",
              status: "completed",
              running: false,
              pid: null,
              exitCode: 0,
              outputLength: 0,
              runCount: Number(sourceInfo.runCount) || 0,
              createdAt: now,
              startedAt: null,
              finishedAt: now,
              error: null,
          };

    if (!base.workspace) {
        throw createError(
            "MEMORY_NO_WORKSPACE",
            "会话 " + from + " 没有记录 workspace，无法据此新建目标会话"
        );
    }

    let task = String(base.task || "");
    let output = targetExisting ? copyOutput(targetExisting.output, Infinity, [], from) : [];
    let conversationId = base.conversationId || null;
    const copied = { records: 0, task: false, conversationId: false };

    if (mode !== "link") {
        if (sourceInfo.task) {
            task = String(sourceInfo.task);
            copied.task = true;
        }
        output = copyOutput(source.output, maxRecords, warnings, from);
        copied.records = output.length;
    }

    if (mode !== "records") {
        if (sourceInfo.conversationId) {
            if (base.provider && sourceInfo.provider && base.provider !== sourceInfo.provider) {
                // conversationId 是 provider 侧的 id，跨 provider 无意义
                warnings.push(
                    "provider 不同（" +
                        sourceInfo.provider +
                        " → " +
                        base.provider +
                        "），conversationId 无法复用，已跳过"
                );
            } else {
                conversationId = sourceInfo.conversationId;
                copied.conversationId = true;
            }
        } else if (mode === "link") {
            warnings.push(
                "源会话还没有 conversationId（没成功起过 provider 会话），没有可接续的线程"
            );
        }
    }

    // 新建目标时哪怕只接续线程也要把 task 带上：task 为空的新会话连 start() 都过不了
    if (created && !task && sourceInfo.task) {
        task = String(sourceInfo.task);
        copied.task = true;
    }

    if (mode === "link") {
        output = [
            {
                id: "memory-transfer-link",
                type: "system",
                content: "🔗 已从会话 " + from + " 接续模型上下文（过程记录未搬移）",
                timestamp: now,
            },
        ];
    } else {
        output = output.concat({
            id: "memory-transfer-note",
            type: "system",
            content:
                "🚚 记忆已从会话 " +
                from +
                " 转移（模式 " +
                mode +
                "，记录 " +
                copied.records +
                " 条" +
                (copied.conversationId ? "，已接续模型上下文" : "") +
                "）",
            timestamp: now,
        });
    }

    const info = Object.assign({}, base, {
        id: to,
        task,
        conversationId,
        outputLength: output.length,
        status: created ? "completed" : base.status || "completed",
        running: false,
        pid: null,
        error: null,
    });

    if (manager && typeof manager.absorbRecord === "function") {
        // 有管理器就走它：目标会话可能正在界面上，必须同时更新内存与磁盘
        manager.absorbRecord({ info, output });
    } else {
        store.writeRecord(to, { info, output });
    }

    return {
        ok: true,
        from,
        to,
        mode,
        created,
        warnings,
        copied,
        source: describeMemory(source),
        target: describeMemory({ info, output, running: false }),
    };
}

module.exports = {
    MODES,
    DEFAULT_MAX_RECORDS,
    transfer,
    listMemories,
    describeById,
    describeMemory,
    normalizeMode,
    normalizeId,
};
