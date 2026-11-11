/**
 * 会话记忆摘要（markdown）
 *
 * 为什么需要：`output` 是写给界面看的流水账（两千多条、几 MB），模型根本读不动；
 * 而 `conversationId` 那条线程只在同一 provider 上有效 —— 换了 provider、或者刻意
 * 用 records 模式新开一段对话时，模型对之前发生过什么一无所知，只拿到一句原始 task。
 *
 * 这里把流水账压成一页纸：任务是什么、改过哪些文件、跑过什么命令、报了什么错、
 * 最后停在哪一步。落到工作区里一个 md，由新会话第一句话 read 一次即可。
 *
 * 与 memory-compress.js 的分工：
 * - compress 处理"界面回看"，目标是体积，保留原始记录的可读性；
 * - digest 处理"给模型读"，目标是信息密度，只留结论性事实。
 * 两者都从同一批原始记录出发，互不依赖。
 *
 * 所有信息都从 `record.event` 里取（runtime.result 带着 action / result 原始对象）；
 * 事件缺失的老记录退化成文本匹配，仍能贡献报错与关键行。
 */

/** 摘要默认字符上限：一页纸的量级，模型一次 read 能吃完。 */
const DEFAULT_MAX_CHARS = 8000;

/** 摘要落在工作区里的目录。放隐藏目录，避免和用户自己的文件混在一起。 */
const DIGEST_DIR = ".xml-agent-memory";

/** 摘要文件的相对路径（相对 workspace，模型据此 read）。 */
function digestPath(sessionId) {
    return DIGEST_DIR + "/" + String(sessionId || "unknown") + ".md";
}

/** 各列表的默认条数上限。 */
const LIMITS = {
    filesWritten: 40,
    filesRead: 30,
    commands: 20,
    errors: 12,
    tail: 8,
};

/** 裁剪顺序：先牺牲尾部与"读过"，最后才动"改过"和"报错"。 */
const SHRINK_ORDER = ["tail", "filesRead", "commands", "errors", "filesWritten"];

const MIN_LIMIT = 3;

const NOISE_PATTERN =
    /^(Agent step \d+|Provider request \(step \d+\)|Provider response received \(\d+ chars\)|Starting provider: .*|Provider started: .*|Provider closed: .*|XML action parsed: .*|🚀 Starting agent\.\.\.|🚀 Agent started)$/;

function pad2(value) {
    return String(value).padStart(2, "0");
}

/** 时间戳 → 本地 `YYYY-MM-DD HH:mm`；无效值返回 null。 */
function formatTime(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        return null;
    }
    const date = new Date(num);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return (
        date.getFullYear() +
        "-" +
        pad2(date.getMonth() + 1) +
        "-" +
        pad2(date.getDate()) +
        " " +
        pad2(date.getHours()) +
        ":" +
        pad2(date.getMinutes())
    );
}

/** 单行化 + 截断：命令与报错都可能带换行，写进列表会把版式撑坏。 */
function oneLine(value, maxLength = 160) {
    const text = String(value === undefined || value === null ? "" : value)
        .replace(/\s+/g, " ")
        .trim();
    if (text.length <= maxLength) {
        return text;
    }
    return text.slice(0, maxLength) + "…";
}

/**
 * 剥掉每次调用都一样的壳：`Command failed: `、`cmd /c chcp 65001 >nul &&`、
 * `powershell -NoProfile -Command`。报表里的命令与 exec 报错都走这里，
 * 否则同一句前缀会在摘要里重复几十遍。
 */
function stripShell(value) {
    let text = String(value === undefined || value === null ? "" : value)
        .replace(/\s+/g, " ")
        .trim();
    text = text.replace(/^Command failed:\s*/i, "");
    // `cmd /c` 是 child_process 自己套的壳；先剥它，再剥后面可能跟的 chcp 链
    text = text.replace(/^cmd(?:\.exe)?\s+\/c\s+/i, "");
    text = text.replace(/^(?:(?:chcp\s+\d+\s*>\s*nul|chcp\s+\d+)\s*&&\s*)+/i, "");
    return text.replace(/^powershell(?:\.exe)?\s+-NoProfile\s+-Command\s+/i, "");
}

/** 命令的可读化：去壳 + 截断。 */
function commandText(value, maxLength = 100) {
    const text = stripShell(value);
    if (!text) {
        return "";
    }
    if (text.length <= maxLength) {
        return text;
    }
    return text.slice(0, maxLength) + "…";
}

function bump(map, key, delta = 1) {
    map.set(key, (map.get(key) || 0) + delta);
}

/**
 * 把记录聚合成结构化数据。
 * 只读 event，不改记录；records 里没有 event 的条目走文本兜底。
 */
function collect(records) {
    const files = new Map();
    const commands = new Map();
    const actions = new Map();
    const errors = [];
    let calls = 0;
    // 真正的"什么时候跑的"只能从记录上看：info.createdAt 是会话文件的时间，
    // 迁移/重写后会变，跟实际运行时间没关系（实测差了 12 天）。
    let firstTs = 0;
    let lastTs = 0;

    for (const record of Array.isArray(records) ? records : []) {
        const content = String((record && record.content) || "");
        const event = record && record.event;
        const ts = Number(record && record.timestamp) || 0;
        if (ts > 0) {
            if (!firstTs || ts < firstTs) {
                firstTs = ts;
            }
            if (ts > lastTs) {
                lastTs = ts;
            }
        }

        if (!event) {
            // 事件副本被裁掉（或本来就没写）时，至少把报错与命令从文本里捞回来
            if (/error|fail|失败|异常/i.test(content) && !NOISE_PATTERN.test(content)) {
                errors.push(oneLine(content));
            }
            continue;
        }

        if (event.type === "action.parse_error") {
            errors.push("XML 解析失败：" + oneLine(event.error || ""));
            continue;
        }
        if (event.type === "provider.error" || event.type === "provider.close_error") {
            errors.push("provider：" + oneLine(event.error || ""));
            continue;
        }
        if (event.type !== "runtime.result" || !event.result) {
            continue;
        }

        const result = event.result || {};
        const action = String(result.action || event.action || "unknown");
        calls++;
        bump(actions, action);

        // 命令在 exec 分支里清洗一次，报错分支还要用它（块作用域不能跨 if）
        let commandLabel = "";

        if (action === "read" && result.path) {
            // 失败的 read 不进"读过"清单：它什么都没读到，只在报错里出现
            if (result.ok !== false) {
                const key = String(result.path);
                const entry = files.get(key) || { path: key, reads: 0, writes: 0, kind: "file" };
                entry.reads++;
                if (result.type === "directory") {
                    entry.kind = "dir";
                }
                files.set(key, entry);
            }
        } else if (action === "write" && result.path) {
            if (result.ok !== false) {
                const key = String(result.path);
                const entry = files.get(key) || { path: key, reads: 0, writes: 0, kind: "file" };
                entry.writes++;
                files.set(key, entry);
            }
        } else if (action === "exec") {
            const command = commandText(result.command || "", 100);
            commandLabel = command;
            if (command) {
                const entry = commands.get(command) || {
                    command,
                    runs: 0,
                    lastExit: null,
                    failed: 0,
                };
                entry.runs++;
                if (typeof result.exitCode === "number") {
                    entry.lastExit = result.exitCode;
                    if (result.exitCode !== 0) {
                        entry.failed++;
                    }
                }
                commands.set(command, entry);
            }
        }

        if (result.ok === false && result.error) {
            // 文件类失败必须带路径：只说"读不到"等于没说
            const where = result.path ? "（" + result.path + "）" : "";
            errors.push(action + where + "：" + oneLine(stripShell(result.error)));
        } else if (
            action === "exec" &&
            typeof result.exitCode === "number" &&
            result.exitCode !== 0
        ) {
            // 命令失败但 result 没带 error 时补一条，否则"跑挂了"这件事会从摘要里消失
            errors.push("exec：`" + (commandLabel || "?") + "` 退出码 " + result.exitCode);
        }
    }

    const written = Array.from(files.values()).filter((item) => item.writes > 0);
    const read = Array.from(files.values()).filter((item) => item.writes === 0 && item.reads > 0);
    written.sort((a, b) => b.writes - a.writes);
    read.sort((a, b) => b.reads - a.reads);

    return {
        files,
        written,
        read,
        commands: Array.from(commands.values()).sort((a, b) => b.runs - a.runs),
        actions: Array.from(actions.entries()).sort((a, b) => b[1] - a[1]),
        errors,
        calls,
        times: { first: firstTs, last: lastTs },
    };
}

/**
把一条记录渲染成"看得懂在干什么"的一行。

不能用 record.content：那是给界面渲染的 `Runtime action: exec { "ok": true, ... }`，
截断后只剩一串 JSON。要回答"停在哪"，需要的是动作 + 目标。
*/
function tailLine(record) {
    const event = record && record.event;
    const result = event && event.type === "runtime.result" ? event.result : null;
    if (!result) {
        // 生命周期提示（Agent stopped by user / Provider closed）原样保留：
        // "上次是被停掉的"往往是接手的第一个关键信息
        return oneLine((record && record.content) || "", 120);
    }
    const action = String(result.action || event.action || "?");
    const failed = result.ok === false;
    if (action === "read" || action === "write") {
        return (failed ? "✗ " : "") + action + " " + String(result.path || "?");
    }
    if (action === "exec") {
        const command = commandText(result.command || "", 80);
        const bad = typeof result.exitCode === "number" && result.exitCode !== 0;
        return (
            (failed || bad ? "✗ " : "") +
            "exec " +
            command +
            (bad ? "（退出码 " + result.exitCode + "）" : "")
        );
    }
    if (action === "answer") {
        return "answer " + oneLine(result.content || "", 100);
    }
    if (action === "done") {
        return "done";
    }
    return (failed ? "✗ " : "") + action;
}

/** 尾部关键行：噪声与纯进度提示不要，保留能看出"停在哪"的几条。 */
function tailLines(records, limit) {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(records) ? records : [];
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
        const record = list[i] || {};
        const content = oneLine(record.content || "", 120);
        if (!content || NOISE_PATTERN.test(content)) {
            continue;
        }
        const line = tailLine(record);
        if (!line) {
            continue;
        }
        // 从后往前扫，所以同一个动作只留最后那一次（"停在哪"只关心最近一次）；
        // 相邻重复与隔着几行的重复（stop 事件常出现两遍）都靠这里收掉
        if (seen.has(line)) {
            continue;
        }
        seen.add(line);
        out.unshift({ time: formatTime(record.timestamp), text: line });
    }
    return out;
}

/**
列表被裁短时补一行说明。
标题写的是总数、正文只列前 N 条，不说明就是撒谎 —— 接手的人会以为那就是全部。
*/
function truncNote(total, shown, unit) {
    const hidden = total - shown;
    return hidden > 0 ? "\n- … 另有 " + hidden + " " + unit + "未列出（完整清单在原会话）" : "";
}

function renderTable(rows, head) {
    if (rows.length === 0) {
        return "";
    }
    const lines = ["| " + head[0] + " | " + head[1] + " |", "| --- | --- |"];
    for (const row of rows) {
        lines.push("| " + row[0] + " | " + row[1] + " |");
    }
    return lines.join("\n");
}

/** 渲染整份摘要（limits 可调，供预算裁剪时反复重算）。 */
function render(data, meta, limits) {
    const parts = [];
    const title = "# 会话记忆摘要";
    parts.push(title);
    // 只预览（不指定目标）时不要说成"从 aaa 转到 aaa"
    const scope =
        meta.to && meta.to !== meta.from
            ? "从会话 `" + meta.from + "` 转到 `" + meta.to + "`"
            : "会话 `" + meta.from + "`";
    parts.push(
        "> " +
            scope +
            (meta.generatedAt ? " · " + meta.generatedAt : "") +
            " · 源记录 " +
            data.records +
            " 条"
    );

    parts.push("## 任务");
    parts.push(meta.task ? meta.task : "（源会话没有记录任务描述）");

    const info = meta.info || {};
    const statusLines = [];
    if (info.provider) {
        statusLines.push("- provider：" + info.provider);
    }
    if (info.workspace) {
        statusLines.push("- 工作区：`" + info.workspace + "`");
    }
    if (info.status) {
        statusLines.push(
            "- 状态：" +
                info.status +
                (Number(info.runCount) > 0 ? "，运行 " + info.runCount + " 次" : "")
        );
    }
    // 优先用记录自身的首末时间：info.createdAt / startedAt 描述的是会话文件，
    // 会话被重写过就会漂移，容易让人误判"上次跑到什么时候"
    const times = data.times || {};
    const recordFirst = formatTime(times.first);
    const recordLast = formatTime(times.last);
    const startedAt = recordFirst || formatTime(info.startedAt) || formatTime(info.createdAt);
    const finishedAt = recordLast || formatTime(info.finishedAt);
    if (startedAt || finishedAt) {
        statusLines.push(
            "- 时间：" +
                (startedAt || "?") +
                (finishedAt ? " → " + finishedAt : "") +
                (recordFirst ? "（按记录时间）" : "")
        );
    }
    if (info.error) {
        statusLines.push("- 结束错误：" + oneLine(info.error));
    }
    parts.push("## 会话状态");
    parts.push(statusLines.length > 0 ? statusLines.join("\n") : "- （无元信息）");

    if (data.written.length > 0) {
        parts.push("## 改过的文件（" + data.written.length + "）");
        parts.push(
            data.written
                .slice(0, limits.filesWritten)
                .map(
                    (item) => "- `" + item.path + "`" + (item.writes > 1 ? " ×" + item.writes : "")
                )
                .join("\n") + truncNote(data.written.length, limits.filesWritten, "个文件")
        );
    }

    if (data.read.length > 0) {
        parts.push("## 读过的文件或目录（" + data.read.length + "）");
        parts.push(
            data.read
                .slice(0, limits.filesRead)
                .map(
                    (item) =>
                        "- `" +
                        item.path +
                        "`" +
                        (item.kind === "dir" ? "（目录）" : "") +
                        (item.reads > 1 ? " ×" + item.reads : "")
                )
                .join("\n") + truncNote(data.read.length, limits.filesRead, "个路径")
        );
    }

    if (data.commands.length > 0) {
        parts.push("## 执行过的命令（" + data.commands.length + "）");
        parts.push(
            data.commands
                .slice(0, limits.commands)
                .map((item) => {
                    let line = "- `" + item.command + "` ×" + item.runs;
                    if (item.failed > 0) {
                        line += "，其中 " + item.failed + " 次失败";
                    } else if (item.lastExit !== null) {
                        line += "，最近退出码 " + item.lastExit;
                    }
                    return line;
                })
                .join("\n") + truncNote(data.commands.length, limits.commands, "条命令")
        );
    }

    if (data.errors.length > 0) {
        // 同样的报错重复出现时只留一条，模型不需要看第 7 次同一个失败
        const unique = [];
        for (const item of data.errors) {
            if (unique.indexOf(item) === -1) {
                unique.push(item);
            }
        }
        // 标题按去重后的条数写：原来写的是去重前的 29，而正文只有 11 条
        parts.push("## 报错（" + unique.length + "）");
        parts.push(
            unique
                .slice(0, limits.errors)
                .map((item) => "- " + item)
                .join("\n") + truncNote(unique.length, limits.errors, "条报错")
        );
    }

    if (data.actions.length > 0) {
        parts.push("## 动作统计");
        parts.push(renderTable(data.actions, ["动作", "次数"]));
    }

    const tail = tailLines(meta.list, limits.tail);
    if (tail.length > 0) {
        // 不叫"最后几条输出"：那是原始日志的口径，这里给的是动作与结束状态
        parts.push("## 最后几个动作");
        parts.push(
            tail
                .map((item) => "- " + (item.time ? "[" + item.time + "] " : "") + item.text)
                .join("\n")
        );
    }

    parts.push(
        "---\n\n以上是摘要，不是完整记录。完整记录（" +
            data.records +
            " 条）仍在会话 `" +
            meta.from +
            "`，需要细节可以去那个会话查看或让我读具体文件。"
    );

    return parts.filter(Boolean).join("\n\n");
}

/**
 * 生成摘要。
 *
 * options:
 *     from / to        会话 id（只用于文案）
 *     info             源会话的 info（task、provider、workspace、时间、状态）
 *     records          源会话的原始 output，**压缩前**的那份（要靠 event 取 action）
 *     maxChars         字符预算（默认 8000）
 *     now              生成时间戳（默认 Date.now()）
 *
 * 返回 { markdown, chars, lines, calls, files, commands, errors }
 */
function buildDigest(records, options = {}) {
    const list = Array.isArray(records) ? records : [];
    const data = collect(list);
    data.records = list.length;

    const meta = {
        from: String(options.from || "?"),
        to: String(options.to || "?"),
        info: options.info || {},
        task: String((options.info && options.info.task) || "").trim(),
        list: list,
        generatedAt: formatTime(options.now === undefined ? Date.now() : options.now),
    };

    const maxChars =
        Number(options.maxChars) > 0 ? Math.trunc(Number(options.maxChars)) : DEFAULT_MAX_CHARS;
    const limits = Object.assign({}, LIMITS);

    let markdown = render(data, meta, limits);
    // 超预算就按优先级一档档砍；每砍一次重算，保证结果确定（不依赖随机或时间）
    let guard = 0;
    while (markdown.length > maxChars && guard < 40) {
        guard++;
        let shrunk = false;
        for (const key of SHRINK_ORDER) {
            if (limits[key] > MIN_LIMIT) {
                limits[key] = Math.max(MIN_LIMIT, Math.floor(limits[key] / 2));
                shrunk = true;
                break;
            }
        }
        if (!shrunk) {
            break;
        }
        markdown = render(data, meta, limits);
    }
    if (markdown.length > maxChars) {
        markdown = markdown.slice(0, maxChars) + "\n\n…（摘要已按字符上限截断）";
    }

    return {
        markdown,
        chars: markdown.length,
        lines: markdown.split("\n").length,
        calls: data.calls,
        files: data.files.size,
        commands: data.commands.length,
        errors: data.errors.length,
    };
}

module.exports = {
    DEFAULT_MAX_CHARS,
    DIGEST_DIR,
    LIMITS,
    buildDigest,
    digestPath,
    collect,
    formatTime,
    oneLine,
    commandText,
};
