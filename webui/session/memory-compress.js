/**
 * 会话记忆压缩
 *
 * 为什么需要：一次长任务会话动辄几千条记录、几 MB JSON。拆开看，体积几乎全花在
 * 两处对"接着做"没有帮助的地方：
 * 1. 每条记录的 event 字段是 content 的原始副本（runtime.result 的 content 就是
 *    event.result 的 pretty JSON），实测 event 比 content 还大 1~2 倍；
 * 2. 大量过程噪声（Agent step 42 / Provider request (step 42) / Provider response
 *    received (1234 chars)），一条几十字节，几千条就是几十 KB，且没有信息量。
 * 真正有用的东西（读了哪个文件、改了什么、报了什么错）只占很小一部分。
 *
 * 三档，全部是确定性规则：不调用模型、不联网、同样的输入永远得到同样的输出。
 * - off     不动；
 * - light   去掉 event + 截断超长单条 + 折叠过程噪声 —— 性价比最高；
 * - strong  light + 合并连续重复 + 按字符预算省略中段（保留开头和结尾）。
 *
 * auto：先量体积，不超预算就不动；超了先 light，仍超再 strong。这样"小会话搬到
 * 另一个会话"这件事保持原样，只有真的大到会拖慢磁盘和前端时才付压缩的代价。
 *
 * 有损压缩的代价要说清楚：
 * - 去掉 event 后，搬过去的历史在 Trace 面板里只能看到摘要（Console 不受影响）；
 * - 省略的中段不会消失，原始记录仍在源会话里，只在目标会话留一行说明。
 */

/** 可传入的档位（含 auto 这个"自动判断"入口）。 */
const LEVELS = ["off", "auto", "light", "strong"];

/** 实际执行的档位（auto 会被解析成其中之一）。 */
const EXECUTED_LEVELS = ["off", "light", "strong"];

/** auto 与 strong 的字符预算（content + event 的字符总量）。 */
const DEFAULT_MAX_CHARS = 300000;

/** 单条记录保留的字符上限（截断时头 60% + 尾 20%，中间留说明）。 */
const DEFAULT_MAX_RECORD_CHARS = 2000;

/** 预算裁剪时优先保留的开头条数：任务的第一句话往往决定了后面在讲什么。 */
const DEFAULT_KEEP_HEAD = 5;

const HEAD_RATIO = 0.6;
const TAIL_RATIO = 0.2;

/** 预算裁剪时给中段说明留的余量。 */
const MARKER_RESERVE = 200;

/**
 * 过程噪声：形如"第 N 步/第 N 次请求"的机器心跳，内容随 N 变化但没有信息量。
 * 注意只折叠**连续**的一段，中间夹了别的记录就断开，避免把时间线搅乱。
 */
const NOISE_PATTERNS = [
    [/^Agent step \d+$/, "Agent step"],
    [/^Provider request \(step \d+\)$/, "Provider request"],
    [/^Provider response received \(\d+ chars\)$/, "Provider response"],
    [/^(Starting provider|Provider started|Provider closed): /, "provider lifecycle"],
    [/^🚀 Agent started$/, "agent started"],
];

function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeLevel(value, fallback = "auto") {
    const raw = value === undefined || value === null || value === "" ? fallback : value;
    const level = String(raw).trim().toLowerCase();
    if (LEVELS.indexOf(level) === -1) {
        throw createError(
            "MEMORY_COMPRESS_INVALID",
            "compress 只能是 " + LEVELS.join(" / ") + "，收到：" + value
        );
    }
    return level;
}

function positiveInt(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        return fallback;
    }
    return Math.trunc(num);
}

/** 一条记录占多少字符：content + event（event 序列化失败时只算 content）。 */
function recordChars(record) {
    if (!record || typeof record !== "object") {
        return 0;
    }
    const content = typeof record.content === "string" ? record.content.length : 0;
    if (!record.event) {
        return content;
    }
    try {
        return content + JSON.stringify(record.event).length;
    } catch (error) {
        // 循环引用等：宁可少算，也不能让统计把压缩搞崩
        return content;
    }
}

/** 量体积：条数与字符总量（压缩前后都用这把尺子，避免两处口径不一致）。 */
function measure(records) {
    const list = Array.isArray(records) ? records : [];
    let chars = 0;
    for (const record of list) {
        chars += recordChars(record);
    }
    return { count: list.length, chars };
}

/** 人类可读的字符数：给提示与日志用。 */
function humanChars(value) {
    const num = Number(value) || 0;
    if (num < 1000) {
        return num + " 字符";
    }
    if (num < 1000 * 1000) {
        return (num / 1000).toFixed(1) + "K 字符";
    }
    return (num / (1000 * 1000)).toFixed(1) + "M 字符";
}

function savedPercent(before, after) {
    if (!before) {
        return 0;
    }
    return Math.round(((before - after) / before) * 1000) / 10;
}

function noiseLabel(record) {
    const content = String((record && record.content) || "").trim();
    if (!content) {
        return null;
    }
    for (const pair of NOISE_PATTERNS) {
        if (pair[0].test(content)) {
            return pair[1];
        }
    }
    return null;
}

/** 浅拷贝一条记录：压缩不能改到源会话的对象。 */
function copyRecord(record) {
    if (!record || typeof record !== "object") {
        return record;
    }
    return Object.assign({}, record);
}

/**
 * 第 1 步：去掉 event。
 * content 已经是给人看的渲染结果，event 是它的原始副本；两者都存等于存两份。
 */
function stripEvents(records, stats) {
    const out = [];
    for (const record of records) {
        const copy = copyRecord(record);
        if (copy && typeof copy === "object" && copy.event !== undefined) {
            delete copy.event;
            stats.strippedEvents++;
        }
        out.push(copy);
    }
    return out;
}

/** 第 2 步：截断超长单条（保留头尾，中间留省略说明）。 */
function truncateLong(records, maxRecordChars, stats) {
    return records.map((record) => {
        if (!record || typeof record.content !== "string") {
            return record;
        }
        const content = record.content;
        if (content.length <= maxRecordChars) {
            return record;
        }
        const headLen = Math.floor(maxRecordChars * HEAD_RATIO);
        const tailLen = Math.floor(maxRecordChars * TAIL_RATIO);
        const omitted = content.length - headLen - tailLen;
        stats.truncated++;
        return Object.assign({}, record, {
            content:
                content.slice(0, headLen) +
                "\n…（压缩：此处省略 " +
                omitted +
                " 字符，完整内容见源会话）…\n" +
                content.slice(content.length - tailLen),
        });
    });
}

/**
 * 第 3 步：折叠连续过程噪声。
 * 只有连续 ≥2 条才折叠 —— 单独一条"Agent step 3"就留着，它至少能定位到第几步。
 */
function collapseNoise(records, stats) {
    const out = [];
    let index = 0;
    while (index < records.length) {
        const label = noiseLabel(records[index]);
        if (!label) {
            out.push(records[index]);
            index++;
            continue;
        }
        let end = index;
        while (end + 1 < records.length && noiseLabel(records[end + 1]) === label) {
            end++;
        }
        const count = end - index + 1;
        if (count < 2) {
            out.push(records[index]);
            index = end + 1;
            continue;
        }
        const first = records[index];
        stats.noiseCollapsed += count;
        out.push({
            id: "memory-compress-noise",
            type: "system",
            content: "（压缩：合并了 " + count + " 条过程提示 — " + label + "）",
            timestamp: (first && first.timestamp) || Date.now(),
        });
        index = end + 1;
    }
    return out;
}

/** 第 4 步：合并连续完全相同的记录（重复的报错、重复的一行输出）。 */
function mergeRuns(records, stats) {
    const out = [];
    let index = 0;
    while (index < records.length) {
        const current = records[index];
        const key =
            current && typeof current === "object"
                ? String(current.type || "") + "\u0000" + String(current.content || "")
                : null;
        if (key === null) {
            out.push(current);
            index++;
            continue;
        }
        let end = index;
        while (
            end + 1 < records.length &&
            records[end + 1] &&
            String(records[end + 1].type || "") +
                "\u0000" +
                String(records[end + 1].content || "") ===
                key
        ) {
            end++;
        }
        const count = end - index + 1;
        if (count < 2) {
            out.push(current);
            index = end + 1;
            continue;
        }
        stats.mergedRuns += count - 1;
        out.push(
            Object.assign({}, current, {
                content:
                    String(current.content || "") + "\n（压缩：相同记录 ×" + count + "，已合并）",
            })
        );
        index = end + 1;
    }
    return out;
}

/**
 * 第 5 步：按字符预算省略中段。
 * 头部（任务起点）与尾部（最近的上下文）都留着，中间用一行说明代替。
 */
function applyBudget(records, maxChars, keepHead, stats) {
    const total = measure(records).chars;
    if (total <= maxChars) {
        return records;
    }
    const headCount = Math.min(keepHead, records.length);
    const head = records.slice(0, headCount);
    let used = 0;
    for (const record of head) {
        used += recordChars(record);
    }
    const tail = [];
    for (let i = records.length - 1; i >= headCount; i--) {
        const size = recordChars(records[i]);
        if (used + size > maxChars) {
            break;
        }
        tail.unshift(records[i]);
        used += size;
    }
    // 一条都放不下也要留最后一条：会话末尾往往就是"做到哪儿了"
    if (tail.length === 0 && records.length > headCount) {
        tail.push(records[records.length - 1]);
    }
    const omitted = records.length - head.length - tail.length;
    if (omitted <= 0) {
        return records;
    }
    stats.omitted += omitted;
    return head.concat(
        [
            {
                id: "memory-compress-omitted",
                type: "system",
                content: "（压缩：省略中段 " + omitted + " 条记录，完整记录仍保留在源会话）",
                timestamp: Date.now(),
            },
        ],
        tail
    );
}

function createStats(requested, before) {
    return {
        requested,
        level: "off",
        before: before,
        after: before,
        strippedEvents: 0,
        truncated: 0,
        noiseCollapsed: 0,
        mergedRuns: 0,
        omitted: 0,
    };
}

function finishStats(stats, records) {
    stats.after = measure(records);
    stats.savedCount = stats.before.count - stats.after.count;
    stats.savedChars = stats.before.chars - stats.after.chars;
    stats.savedPercent = savedPercent(stats.before.chars, stats.after.chars);
    return stats;
}

/** 按某一档执行（不做 auto 解析）。always 返回新数组，不改入参。 */
function runLevel(records, level, options) {
    const stats = createStats(options.requested || level, measure(records));
    if (level === "off") {
        stats.level = "off";
        return { records: records.map(copyRecord), stats: finishStats(stats, records) };
    }
    let out = records.map(copyRecord);
    // light 起就做的三件事
    out = stripEvents(out, stats);
    out = truncateLong(out, options.maxRecordChars, stats);
    out = collapseNoise(out, stats);
    if (level === "strong") {
        out = mergeRuns(out, stats);
        out = applyBudget(out, options.maxChars, options.keepHead, stats);
    }
    stats.level = level;
    return { records: out, stats: finishStats(stats, out) };
}

function pickOptions(options = {}) {
    return {
        requested: normalizeLevel(options.level, "auto"),
        maxChars: positiveInt(options.maxChars, DEFAULT_MAX_CHARS),
        maxRecordChars: positiveInt(options.maxRecordChars, DEFAULT_MAX_RECORD_CHARS),
        keepHead: positiveInt(options.keepHead, DEFAULT_KEEP_HEAD),
        maxRecords: positiveInt(options.maxRecords, 0),
    };
}

/** 条目太多也算"太大"：几千条短记录同样会拖慢前端渲染。 */
function needsCompression(before, options) {
    if (before.chars > options.maxChars) {
        return true;
    }
    return options.maxRecords > 0 && before.count > options.maxRecords;
}

/**
 * 压缩一批输出记录。
 *
 * options:
 *     level           off / auto / light / strong（默认 auto）
 *     maxChars        字符预算（默认 300000）
 *     maxRecordChars  单条保留上限（默认 2000）
 *     keepHead        预算裁剪时保留的开头条数（默认 5）
 *     maxRecords      条数上限；auto 下超过它也触发压缩（0 表示不看条数）
 *
 * 返回 { records, stats }；records 永远是副本，改它不会影响入参。
 */
function compressRecords(records, options = {}) {
    const list = Array.isArray(records) ? records : [];
    const opts = pickOptions(options);
    const before = measure(list);

    if (opts.requested === "off" || list.length === 0) {
        return runLevel(list, "off", opts);
    }
    if (opts.requested !== "auto") {
        return runLevel(list, opts.requested, opts);
    }
    if (!needsCompression(before, opts)) {
        return runLevel(list, "off", opts);
    }
    // auto：先轻压，够了就停；还不够再上强压
    const light = runLevel(list, "light", opts);
    if (light.stats.after.chars <= opts.maxChars && !needsCompression(light.stats.after, opts)) {
        return light;
    }
    const strong = runLevel(list, "strong", opts);
    strong.stats.requested = "auto";
    return strong;
}

/** 给提示/日志用的一句话摘要。 */
function describeCompression(stats) {
    if (!stats || stats.level === "off") {
        return null;
    }
    return (
        "记忆压缩（" +
        stats.level +
        "）：" +
        stats.before.count +
        " 条 / " +
        humanChars(stats.before.chars) +
        " → " +
        stats.after.count +
        " 条 / " +
        humanChars(stats.after.chars) +
        "（省 " +
        stats.savedPercent +
        "%）"
    );
}

/** 转移结果里带的精简摘要（完整 stats 太长，模型不需要）。 */
function summarize(stats) {
    if (!stats) {
        return null;
    }
    return {
        level: stats.level,
        beforeCount: stats.before.count,
        afterCount: stats.after.count,
        beforeChars: stats.before.chars,
        afterChars: stats.after.chars,
        savedPercent: stats.savedPercent,
    };
}

module.exports = {
    LEVELS,
    EXECUTED_LEVELS,
    DEFAULT_MAX_CHARS,
    DEFAULT_MAX_RECORD_CHARS,
    DEFAULT_KEEP_HEAD,
    compressRecords,
    describeCompression,
    summarize,
    measure,
    recordChars,
    humanChars,
    normalizeLevel,
};
