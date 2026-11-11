/**
会话记忆转移

把一个会话的"记忆"写到另一个会话 id 上。这里的记忆有两层，来源不同：
- 记录：output（过程日志）+ task（任务描述）—— 决定界面上能不能回看之前发生了什么；
- 模型上下文：info.conversationId —— provider 侧的对话线程 id，决定下一句话模型记不记得。

四种模式（mode）：
- full（默认）：两层都搬，换会话接着做；
- records：只搬记录，模型从新对话开始（安全，不会串味）；
- link：只接续模型线程，界面保持空白（除了一行来源说明）；
- digest：只搬任务 + 一页摘要，不搬记录也不接续线程。

digest 是"上下文满了就换会话"的推荐模式：那个场景下新会话本来就不该继承旧的
过程记录（旧记录已经把 provider 的窗口塞满了，搬过去只会让界面又臭又长），
模型需要的只是"做过什么、改过哪些文件、还差什么"这类概要 —— 也就是摘要本身。

为什么有这些约束（每条都对应一个真实的坏结果）：
- from === to 直接拒绝：只会把 output 自己乘一遍，条目翻倍。
- 目标正在运行直接拒绝：运行中的会话每次落盘都会覆盖，搬过去的记录会被下一次
  persist 冲掉，界面还会出现两条时间线。
- provider 不一致时不能复用 conversationId：那是 provider 侧的 id（DeepSeek 的 id
  拿到 Qwen 上是无效值），强行写入会让下一次运行直接报错。full 会降级成 records 并回 warning。
- output 有上限：会话可能有上万条输出，整包搬进另一个会话会同时撑大磁盘和前端渲染。
  超出时保留尾部（最近的更有用）并插一行说明。
- 图片不搬：images 是一次性上传的运行时状态，恢复时不还原（见 AgentSession.restore）。
- 搬之前先压缩：真实会话里 event 字段是 content 的副本、过程噪声又占掉大半条数，
  原样搬过去等于把浪费也复制一份。压缩规则与档位见 memory-compress.js。
- 记录不进模型上下文：真正让模型"记得"的是 conversationId 那条 provider 线程。
  所以 records 模式（或源会话本来就没有线程）下，新会话对历史一无所知 ——
  这时额外生成一份 markdown 摘要，落到工作区让模型自己 read 一次（memory-digest.js）。
*/

const crypto = require("crypto");
const defaultStore = require("./session-store");
const memoryCompress = require("./memory-compress");
const memoryDigest = require("./memory-digest");

/** 一次最多搬多少条 output；超出保留尾部。 */
const DEFAULT_MAX_RECORDS = 2000;

const MODES = ["full", "records", "link", "digest"];

/** 摘要档位：off 不生成；auto 只在"模型不会记得历史"时生成；always 总是生成。 */
const DIGEST_MODES = ["off", "auto", "always"];

function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeDigestMode(value) {
    const mode = String(value === undefined || value === null || value === "" ? "auto" : value)
        .trim()
        .toLowerCase();
    if (DIGEST_MODES.indexOf(mode) === -1) {
        throw createError(
            "MEMORY_DIGEST_INVALID",
            "digest 只能是 " + DIGEST_MODES.join(" / ") + "，收到：" + value
        );
    }
    return mode;
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
/**
id 归一化。
generate=true 时缺省值不报错，直接生成一个新 id —— 供「上下文快满了，
一键开个新会话接着干」这种场景用：调用方不该被迫先想一个 id。
*/
function normalizeId(value, label, options = {}) {
    const id = String(value === undefined || value === null ? "" : value).trim();
    if (!id) {
        if (options.generate) {
            return crypto.randomUUID();
        }
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
    const size = memoryCompress.measure(memory.output);
    return {
        exists: true,
        id: info.id,
        provider: info.provider || null,
        workspace: info.workspace || null,
        task: String(info.task || ""),
        status: info.status || null,
        running: memory.running === true,
        outputCount: size.count,
        outputChars: size.chars,
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
      copied: { records, task, conversationId },
      compression: { level, beforeCount, afterCount, beforeChars, afterChars, savedPercent },
      digest: { file, path, chars, lines, calls, files, commands, errors, markdown }
    }
失败时抛错，error.code 以 MEMORY_ 开头，便于插件映射成给模型看的文案。

摘要相关选项（都不传也能跑）：
    digest          off / auto（默认）/ always
    maxDigestChars  摘要字符预算，默认 8000
    writeDigest     (relativePath, markdown) => { path }，由宿主提供写入口；
                    写成功才会把"先 read 摘要"追加进 task
*/
function transfer(options = {}) {
    const store = options.store || defaultStore;
    const manager = options.manager || null;
    const from = normalizeId(options.from, "from");
    // to 省略时自动生成：Web 端的「转移并新开」按钮就是这么用的
    const to = normalizeId(options.to, "to", { generate: true });
    const mode = normalizeMode(options.mode);
    const maxRecords =
        Number(options.maxRecords) > 0
            ? Math.trunc(Number(options.maxRecords))
            : DEFAULT_MAX_RECORDS;
    const compressLevel = memoryCompress.normalizeLevel(options.compress, "auto");
    const maxChars = options.maxChars;
    const digestMode = normalizeDigestMode(options.digest);

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
    let compression = null;

    // 三件事分开决定：任务描述 / 过程记录 / 模型线程。
    // digest 只要任务 + 摘要，所以任务照搬、记录和线程都不动。
    const wantsTask = mode !== "link";
    const wantsRecords = mode === "full" || mode === "records";
    const wantsThread = mode === "full" || mode === "link";

    if (wantsTask && sourceInfo.task) {
        task = String(sourceInfo.task);
        copied.task = true;
    }

    if (wantsRecords) {
        // 先压再截：压缩能保住更多"有信息量"的记录，尾部截断只是兜底
        const packed = memoryCompress.compressRecords(source.output, {
            level: compressLevel,
            maxChars,
            maxRecords,
        });
        compression = packed.stats;
        if (compression.level !== "off") {
            const note = memoryCompress.describeCompression(compression);
            if (note) {
                warnings.push(note);
            }
            if (compression.strippedEvents > 0) {
                // 有损的地方要说清楚，别让人以为搬过去还能看回放
                warnings.push(
                    "已去掉 " +
                        compression.strippedEvents +
                        " 条记录的事件原始副本：目标会话的 Trace 面板只能看到摘要（Console 不受影响）"
                );
            }
        }
        output = copyOutput(packed.records, maxRecords, warnings, from);
        copied.records = output.length;
    }

    if (wantsThread) {
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

    /**
    摘要：只有"模型拿不到历史"时才有意义。
    full 且接上了线程时不做 —— 模型本来就记得，再塞一份摘要是噪音。
    生成用的是压缩前的 source.output：摘要要从 event 里取 action / path / command，
    压缩会把 event 删掉。
    */
    if (mode === "digest" && digestMode === "off") {
        // digest 的全部内容就是这份摘要，关掉它等于转了一个空会话
        throw createError(
            "MEMORY_DIGEST_REQUIRED",
            "mode=digest 只搬摘要，digest=off 就什么都没搬；要留记录请用 mode=records"
        );
    }
    let digest = null;
    const digestNeeded =
        digestMode === "always" || (digestMode === "auto" && !copied.conversationId);
    if (digestNeeded) {
        const built = memoryDigest.buildDigest(source.output, {
            from,
            to,
            info: sourceInfo,
            maxChars: options.maxDigestChars,
            now,
        });
        const relativePath = memoryDigest.digestPath(to);
        let savedPath = null;
        let failure = null;
        if (typeof options.writeDigest === "function") {
            try {
                const outcome = options.writeDigest(relativePath, built.markdown, {
                    workspace: base.workspace || null,
                });
                savedPath = (outcome && outcome.path) || relativePath;
            } catch (error) {
                // 写不进去不该让整个转移失败：记录已经搬好了，只是模型少了那份摘要
                failure = (error && error.message) || String(error);
                warnings.push(
                    "摘要写入失败（" +
                        failure +
                        "）：目标会话只能靠过程记录回看，模型不会知道之前做过什么"
                );
            }
        } else {
            failure = "没有提供摘要写入口（writeDigest）";
            warnings.push("没有提供摘要写入口（writeDigest）：摘要已生成但没有落盘，模型读不到");
        }
        if (mode === "digest" && !savedPath) {
            // 这个模式下摘要没落盘就等于白转（连记录都没有），宁可在写盘前报错，
            // 也不留一个只有 task 一句话的空会话。此时还没 writeRecord，没有副作用。
            throw createError(
                "MEMORY_DIGEST_WRITE_FAILED",
                "摘要没能落到工作区（" + failure + "），mode=digest 已取消本次转移"
            );
        }
        digest = {
            file: savedPath,
            path: relativePath,
            chars: built.chars,
            lines: built.lines,
            calls: built.calls,
            files: built.files,
            commands: built.commands,
            errors: built.errors,
            // 未落盘时把正文带回去，调用方（脚本 / preview）还能自己处理
            markdown: savedPath ? null : built.markdown,
        };
        if (savedPath) {
            // 提示必须进 task：新会话首轮提示词里唯一能带过去的文字就是它
            task =
                task +
                "\n\n---\n" +
                "接手提示：这是一次记忆转移，之前的工作发生在会话 " +
                from +
                "。开工前先 read `" +
                savedPath +
                "`，" +
                "那里有任务原话、改过哪些文件、跑过什么命令、报了哪些错。" +
                "读完再决定下一步，不要从头重做。";
        }
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
                (mode === "digest" ? "，只带摘要" : "，记录 " + copied.records + " 条") +
                (copied.conversationId ? "，已接续模型上下文" : "") +
                (compression && compression.level !== "off"
                    ? "，压缩 " + compression.level + " 省 " + compression.savedPercent + "%"
                    : "") +
                (digest && digest.file ? "，摘要 " + digest.file : "") +
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
        compression: memoryCompress.summarize(compression),
        digest,
        source: describeMemory(source),
        target: describeMemory({ info, output, running: false }),
    };
}

/**
预览压缩效果：只读，不写任何会话。

先看能省多少再决定要不要搬 —— 面板和脚本都需要这个"后悔药"。
返回 { ok, from, requested, stats, summary }；stats 是完整统计。
*/
function previewCompression(options = {}) {
    const store = options.store || defaultStore;
    const manager = options.manager || null;
    const from = normalizeId(options.from, "from");
    const requested = memoryCompress.normalizeLevel(options.compress, "auto");
    const maxRecords =
        Number(options.maxRecords) > 0
            ? Math.trunc(Number(options.maxRecords))
            : DEFAULT_MAX_RECORDS;

    const source = readMemory(from, { store, manager });
    if (!source) {
        throw createError("MEMORY_SOURCE_NOT_FOUND", "会话 " + from + " 不存在");
    }
    const packed = memoryCompress.compressRecords(source.output, {
        level: requested,
        maxChars: options.maxChars,
        maxRecords,
    });
    return {
        ok: true,
        from,
        requested,
        stats: packed.stats,
        summary: memoryCompress.describeCompression(packed.stats),
    };
}

/**
预览摘要：只读，不写任何文件、不改会话。

给人（和面板）先看一眼"模型将会读到什么"，再决定要不要真的转移。
返回 { ok, from, path, chars, lines, markdown, counts }。
*/
function previewDigest(options = {}) {
    const store = options.store || defaultStore;
    const manager = options.manager || null;
    const from = normalizeId(options.from, "from");
    const to = options.to ? normalizeId(options.to, "to") : from;
    const maxChars = options.maxChars;

    const source = readMemory(from, { store, manager });
    if (!source) {
        throw createError("MEMORY_SOURCE_NOT_FOUND", "会话 " + from + " 不存在");
    }
    const built = memoryDigest.buildDigest(source.output, {
        from,
        to,
        info: source.info || {},
        maxChars,
    });
    return {
        ok: true,
        from,
        path: memoryDigest.digestPath(to),
        chars: built.chars,
        lines: built.lines,
        counts: {
            calls: built.calls,
            files: built.files,
            commands: built.commands,
            errors: built.errors,
        },
        markdown: built.markdown,
    };
}

module.exports = {
    MODES,
    DIGEST_MODES,
    DEFAULT_MAX_RECORDS,
    transfer,
    previewCompression,
    previewDigest,
    listMemories,
    describeById,
    describeMemory,
    normalizeMode,
    normalizeId,
    normalizeDigestMode,
};
