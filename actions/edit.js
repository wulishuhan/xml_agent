/**
 * 内置动作：edit —— 局部修改文件
 *
 * write 是"整篇重写"：为了改一行，模型必须把整个文件重新生成一遍。
 * 代价有两层：token 花在复述没变的代码上；任何一处手误都会把原本没问题的
 * 部分一起改坏，而 diff 里根本看不出哪些是"顺手改到的"。
 *
 * edit 只要求给出"要改的那一段（old）"和"改成什么（new）"，
 * 其余内容逐字节保留。一次动作可以带多个 change，按顺序执行。
 *
 * 匹配规则（依次尝试）：
 * 1. 精确匹配：old 在文件里必须出现；出现多次要让 old 带更多上下文，
 *    或用 all=true 表示"全部替换"。
 * 2. 宽松匹配：精确匹配 0 次时，忽略行首缩进与行尾空白再找一次
 *   （old 长度不足 MIN_LOOSE_LENGTH 时不启用，避免短串误命中别处）。
 *   命中后按原文位置替换，并把缩进差补到 new 的每一行上。
 *
 * 任何一处 change 失败就整体放弃、不落盘 —— 改到一半的文件比没改更难收拾。
 */

const fs = require("fs");
const path = require("path");
const agentConfig = require("../config/agent-config");
const { BUILTIN_ACTION_SCHEMAS } = require("../parse/action-schema");
const { validateContent } = require("./content-check");

// 宽松匹配的最短长度：太短的锚点剥掉缩进后容易命中别处，宁可报"找不到"。
const MIN_LOOSE_LENGTH = 16;
// 单次动作的修改块上限：再多就不该用 edit，而是重写整个文件。
const MAX_CHANGES = 20;
// diff 回显上限：给模型确认用，不是给界面看的完整补丁。
const MAX_DIFF_LINES = 40;
const MAX_DIFF_CHARS = 2000;
const MAX_DIFF_LINE_CHARS = 200;

/** 新内容按目标文件的换行风格写入，避免在 CRLF 文件里混进 LF。 */
function toFileEol(value, eol) {
    const lf = String(value).replace(/\r\n/g, "\n");
    return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

function countOccurrences(text, needle) {
    if (!needle) {
        return 0;
    }
    let count = 0;
    let index = text.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = text.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * 统计 offset 之前的换行数（用于把字符偏移换算成行号）。
 *
 * 三种换行都要认：\r\n（CRLF）、单独 \n（LF）、单独 \r（1990s Mac 老式换行）。
 * 旧实现只数 \n，老式 \r-only 文件里整段都被当成第 1 行，diff 行号全错。
 * \r\n 必须只算一次，所以遇到 \r 时把紧随的 \n 一并跳过。
 */
function countNewlines(text, upTo) {
    let count = 0;
    let index = 0;
    while (index < upTo && index < text.length) {
        const ch = text.charAt(index);
        if (ch === "\r") {
            count += 1;
            index += text.charAt(index + 1) === "\n" ? 2 : 1;
        } else if (ch === "\n") {
            count += 1;
            index += 1;
        } else {
            index += 1;
        }
    }
    return count;
}

function lineOf(text, offset) {
    return 1 + countNewlines(text, offset);
}

/**
 * 把原子写入抛出的 syscall 错误（典型是 EPERM: rename tmp -> file）转成
 * 模型能看懂的提示：说清属于权限/磁盘/目录哪一类，保留错误码与原始消息。
 * 直接 rethrow 会让模型看到 "EPERM: operation not permitted, rename ...tmp..."
 * 这种无从下手的信息，进而反复重试同一个写操作。
 */
function describeWriteFailure(error) {
    const code = error && error.code ? error.code : "";
    const raw = error && error.message ? error.message : String(error);
    let reason = raw;
    if (code === "EPERM" || code === "EACCES") {
        reason = "permission denied (file or directory is read-only, or no write access)";
    } else if (code === "ENOSPC") {
        reason = "disk full";
    } else if (code === "ENOENT") {
        reason = "parent directory does not exist";
    } else if (code === "EISDIR") {
        reason = "target is a directory";
    } else if (code === "ENOTDIR") {
        reason = "a path component is not a directory";
    }
    return (
        "Failed to write file" +
        (code ? " [" + code + "]" : "") +
        ": " +
        reason +
        ". The original file is unchanged. (raw: " +
        raw +
        ")"
    );
}

/**
 * 生成"忽略缩进与行尾空白"的视图，并记录每个字符回到原文的下标。
 *
 * 为什么要映射：宽松匹配是在归一化后的字符串上找位置的，而替换必须落在原文
 * 的确切区间上。map[i] 是归一化第 i 个字符在原文中的下标，map[length] 是原文长度。
 */
function normalizeForMatch(text) {
    const chars = [];
    const map = [];
    let lineStart = true;
    let index = 0;
    const len = text.length;
    while (index < len) {
        const ch = text.charAt(index);
        if (ch === "\r" && text.charAt(index + 1) === "\n") {
            index += 1;
            continue;
        }
        if (ch === "\n") {
            chars.push("\n");
            map.push(index);
            lineStart = true;
            index += 1;
            continue;
        }
        if (lineStart && (ch === " " || ch === "\t")) {
            index += 1;
            continue;
        }
        if (ch === " " || ch === "\t") {
            let end = index;
            while (end < len && (text.charAt(end) === " " || text.charAt(end) === "\t")) {
                end += 1;
            }
            const next = text.charAt(end);
            const atLineEnd =
                next === "" || next === "\n" || (next === "\r" && text.charAt(end + 1) === "\n");
            if (atLineEnd) {
                index = end;
                continue;
            }
        }
        chars.push(ch);
        map.push(index);
        // 只有换行之后的空白才算"行首缩进"；行内的空格属于内容，必须保留
        lineStart = false;
        index += 1;
    }
    map.push(len);
    return { text: chars.join(""), map };
}

function locate(text, oldText) {
    const exact = countOccurrences(text, oldText);
    if (exact > 0) {
        return { count: exact, mode: "exact" };
    }
    const haystack = normalizeForMatch(text);
    const needle = normalizeForMatch(oldText).text;
    if (needle.length >= MIN_LOOSE_LENGTH) {
        const loose = countOccurrences(haystack.text, needle);
        if (loose > 0) {
            return { count: loose, mode: "loose", haystack, needle };
        }
    }
    return { count: 0, mode: "none" };
}

function occurrenceLines(text, needle, limit) {
    const lines = [];
    let from = 0;
    while (lines.length < limit) {
        const index = text.indexOf(needle, from);
        if (index === -1) {
            break;
        }
        lines.push(lineOf(text, index));
        from = index + needle.length;
    }
    return lines;
}

/**
 * 宽松模式下 old 的精确出现次数是 0，但归一化视图里有 count 处命中。
 * 在归一化视图上找命中、用 map 映射回原文偏移，才能报出真实行号。
 */
function looseOccurrenceLines(text, oldText, limit) {
    const haystack = normalizeForMatch(text);
    const needle = normalizeForMatch(oldText).text;
    if (!needle.length) {
        return [];
    }
    const lines = [];
    let from = 0;
    while (lines.length < limit) {
        const index = haystack.text.indexOf(needle, from);
        if (index === -1) {
            break;
        }
        lines.push(lineOf(text, haystack.map[index]));
        from = index + needle.length;
    }
    return lines;
}

/**
 * 判断 [start, end) 是否与任何"前一个 change 插入的区间"重叠。
 * 重叠意味着本次 change 会匹配到前一次刚写进去的文本 —— 静默误命中。
 */
function overlapsInserted(start, end, insertedRanges) {
    for (const range of insertedRanges) {
        if (start < range.end && end > range.start) {
            return true;
        }
    }
    return false;
}

/** 文本被替换后，同步平移已记录的插入区间（后续偏移会随增删变化）。 */
function shiftInsertedRanges(ranges, replaceStart, replaceEnd, insertedLength) {
    const delta = insertedLength - (replaceEnd - replaceStart);
    for (const range of ranges) {
        if (range.start >= replaceEnd) {
            range.start += delta;
            range.end += delta;
        } else if (range.end <= replaceStart) {
            // 完全在替换区间之前，不受影响
        } else {
            // 插入区间被本次 change 覆盖了一部分，不再追踪它
            range.start = replaceStart;
            range.end = replaceStart;
        }
    }
}

function leadingIndent(line) {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0] : "";
}

/**
 * 算出"模型写的 old 与文件里那段原文"的缩进差。
 *
 * 只看第一行是不够的：块的第一行往往没有缩进（`if (x) {` 就在行首），
 * 真正的差异在块内部 —— 只看第一行会得出"没差别"，于是把模型的缩进原样插进去。
 * 所以逐行比对，空行不参与。
 *
 * 关键修复：不再按行投票取多数。旧逻辑遇到"各行差值不一致"（模型把一行写
 * 成 4 空格、相邻行写成 6 空格）会选多数，把少数行静默改错；tab/空格混用
 * 时又完全无法判定，于是把模型的空格缩进原样写进 tab 文件。两种情况都返回
 * error，让本次 edit 整体失败，要求模型照抄原文 —— 静默写错远比明确报错糟。
 */
function detectIndentShift(oldText, matched) {
    const oldLines = oldText.split(/\r?\n/);
    const fileLines = matched.split(/\r?\n/);
    if (oldLines.length !== fileLines.length) {
        return { error: "matched block has a different line count than old" };
    }
    let shift = null;
    for (let i = 0; i < oldLines.length; i++) {
        const oldLine = oldLines[i];
        const fileLine = fileLines[i];
        if (!oldLine.trim() || !fileLine.trim()) {
            continue;
        }
        const oldIndent = leadingIndent(oldLine);
        const fileIndent = leadingIndent(fileLine);
        if (oldIndent === fileIndent) {
            continue;
        }
        let mode = "";
        let prefix = "";
        if (fileIndent.startsWith(oldIndent)) {
            mode = "add";
            prefix = fileIndent.slice(oldIndent.length);
        } else if (oldIndent.startsWith(fileIndent)) {
            mode = "strip";
            prefix = oldIndent.slice(fileIndent.length);
        }
        if (!prefix) {
            return {
                error:
                    "incompatible indentation between old and file (e.g. tabs vs spaces) at line " +
                    (i + 1) +
                    " of the block; copy old exactly as it appears in the file",
            };
        }
        const current = { mode, prefix };
        if (shift && (shift.mode !== current.mode || shift.prefix !== current.prefix)) {
            return {
                error:
                    "inconsistent indentation inside old at line " +
                    (i + 1) +
                    " of the block; copy old exactly as it appears in the file",
            };
        }
        shift = current;
    }
    return { shift };
}

/** 把缩进差补到 new 的每一行（空行不加，否则会产生尾随空白）。 */
function applyIndentShift(newText, shift) {
    if (!newText || !shift || !shift.prefix) {
        return newText;
    }
    return newText
        .split("\n")
        .map((line) => {
            if (!line.trim()) {
                return line;
            }
            if (shift.mode === "add") {
                return shift.prefix + line;
            }
            return line.startsWith(shift.prefix) ? line.slice(shift.prefix.length) : line;
        })
        .join("\n");
}

/**
 * 找不到时给一条"最接近的位置"，比只说 not found 有用得多。
 *
 * 必须用原始文件文本（而非已应用前面 change 的中间态）来定位：模型 read 到的
 * 是原文件，报一个中间态行号会让模型按错误行号改、反复失败。
 * 探针也放宽到 >= 4 字符，避免短标识符（如 `a();`）直接给空提示。
 */
function notFoundHint(originalText, text, oldText) {
    const probe = oldText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length >= 4);
    if (!probe) {
        return " No distinctive line in old (all shorter than 4 chars) — re-read the file and copy a longer exact block.";
    }
    const needle = probe.slice(0, 40);
    const originalIndex = originalText.indexOf(needle);
    const currentIndex = text.indexOf(needle);
    if (originalIndex === -1 && currentIndex === -1) {
        return (
            " No line of old appears verbatim, even after earlier changes — re-read the file " +
            "and copy the exact text."
        );
    }
    const parts = [];
    if (originalIndex !== -1) {
        parts.push("line " + lineOf(originalText, originalIndex) + " of the original file");
    }
    if (currentIndex !== -1 && currentIndex !== originalIndex) {
        parts.push("line " + lineOf(text, currentIndex) + " after earlier changes");
    }
    return (
        " The closest line of old appears at " +
        parts.join(" / ") +
        ", but the block around it differs — re-read the file and copy the exact text."
    );
}

function splitDiffLines(value) {
    if (!value) {
        return [];
    }
    const lines = String(value).split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}

function clipLine(line) {
    return line.length > MAX_DIFF_LINE_CHARS ? line.slice(0, MAX_DIFF_LINE_CHARS) + " …" : line;
}

/**
 * 回显这次改动，让模型不必再 read 一次整个文件就能确认结果。
 * 不是标准 unified diff（没有上下文行），只列被替换的行 —— 够用且便宜。
 */
function renderDiff(entries) {
    const out = [];
    let delta = 0;
    for (const entry of entries) {
        const removed = splitDiffLines(entry.removed);
        const added = splitDiffLines(entry.added);
        const destLine = entry.startLine + delta;
        out.push(
            "@@ -" +
                entry.startLine +
                "," +
                removed.length +
                " +" +
                destLine +
                "," +
                added.length +
                " @@"
        );
        for (const line of removed) {
            out.push("-" + clipLine(line));
        }
        for (const line of added) {
            out.push("+" + clipLine(line));
        }
        delta += added.length - removed.length;
        if (out.length >= MAX_DIFF_LINES) {
            out.push("… 其余改动已省略");
            break;
        }
    }
    const text = out.join("\n");
    return text.length > MAX_DIFF_CHARS ? text.slice(0, MAX_DIFF_CHARS) + "\n… 已截断" : text;
}

module.exports = {
    name: "edit",
    schema: BUILTIN_ACTION_SCHEMAS.edit,
    validate(params) {
        if (!params || typeof params !== "object" || Array.isArray(params)) {
            throw new Error("edit action is invalid");
        }
        if (!params.path) {
            throw new Error("edit requires path");
        }
        const changes = Array.isArray(params.changes) ? params.changes : [];
        if (!changes.length) {
            throw new Error("edit requires at least one change with old/new");
        }
        for (const change of changes) {
            if (!change || typeof change !== "object" || typeof change.new !== "string") {
                throw new Error("edit change requires new (use an empty new to delete)");
            }
            if (typeof change.old !== "string" || !change.old.trim()) {
                throw new Error("edit change requires non-empty old (use write to create a file)");
            }
        }
    },
    run(params, ctx) {
        const filePath = params?.path;
        if (!filePath) {
            throw new Error("edit requires path");
        }
        const fullPath = ctx.runtime.resolvePath(filePath);
        const changes = Array.isArray(params?.changes) ? params.changes : [];
        const fail = (error, extra) =>
            Object.assign({ ok: false, action: "edit", path: filePath, error }, extra || {});

        if (!changes.length) {
            return fail("edit requires at least one change with old/new");
        }
        if (changes.length > MAX_CHANGES) {
            return fail("Too many changes in one edit (max " + MAX_CHANGES + ")");
        }
        for (const change of changes) {
            if (!change || typeof change !== "object" || typeof change.new !== "string") {
                return fail("edit change requires new (use an empty new to delete)");
            }
            if (typeof change.old !== "string" || !change.old.trim()) {
                return fail("edit change requires non-empty old (use write to create a file)");
            }
        }
        if (!fs.existsSync(fullPath)) {
            return fail("File does not exist; use write to create it");
        }
        if (fs.statSync(fullPath).isDirectory()) {
            return fail("Path is an existing directory, not a file");
        }
        const buffer = fs.readFileSync(fullPath);
        if (buffer.subarray(0, 8192).indexOf(0) !== -1) {
            return fail("Binary file (NUL bytes detected); edit only handles text files");
        }

        let text = buffer.toString("utf8");
        // 原始文本快照：notFoundHint 必须基于它算行号（模型 read 到的就是这份），
        // 否则前一个 change 改动后行号漂移，提示会把模型引到错误位置。
        const originalText = text;
        const eol = text.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
        const all = params.all === true;
        const applied = [];
        // 已插入内容的区间（相对当前 text 的绝对偏移）。后续 change 若命中这些
        // 区间，说明它匹配到的是前一个 change 刚写进去的文本 —— 几乎总是误命中，
        // 静默改错。检测后明确拒绝，让模型拆成两次 edit 或调整顺序。
        const insertedRanges = [];
        let usedLoose = false;
        let addedLines = 0;
        let removedLines = 0;

        for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
            const change = changes[changeIndex];
            const oldText = toFileEol(change.old, eol);
            let newText = toFileEol(change.new, eol);
            const found = locate(text, oldText);

            if (!found.count) {
                return fail(
                    "Text to replace not found in " +
                        filePath +
                        "." +
                        notFoundHint(originalText, text, oldText),
                    { matched: "none", changeIndex }
                );
            }
            if (found.count > 1 && !all) {
                // 宽松匹配时 old 的精确出现次数是 0，必须用归一化视图找行号，
                // 否则提示会变成 "(lines , …)" 这种没有定位信息的空列表。
                const lines =
                    found.mode === "loose"
                        ? looseOccurrenceLines(text, oldText, 5)
                        : occurrenceLines(text, oldText, 5);
                return fail(
                    "Found " +
                        found.count +
                        " matches of old (lines " +
                        (lines.length ? lines.join(", ") : "unknown") +
                        (found.count > lines.length ? ", …" : "") +
                        "). Add more surrounding lines to make it unique, or use all=true to replace every match.",
                    { matches: found.count, lines, changeIndex }
                );
            }
            // 宽松匹配只能定位到"唯一一处"（位置来自归一化视图的映射）。
            // 又要 all=true 就会变成"答应替换全部，实际只改一处"，
            // 这种静默少做比直接报错更难发现。
            if (found.mode === "loose" && found.count > 1 && all) {
                return fail(
                    "all=true cannot be combined with an indentation-loose match (found " +
                        found.count +
                        "). Copy old exactly as it appears in the file, or edit one occurrence at a time.",
                    { matches: found.count, matched: "loose" }
                );
            }

            let count = 0;
            if (found.mode === "exact") {
                let cursor = 0;
                while (true) {
                    const index = text.indexOf(oldText, cursor);
                    if (index === -1) {
                        break;
                    }
                    const endIndex = index + oldText.length;
                    if (overlapsInserted(index, endIndex, insertedRanges)) {
                        return fail(
                            "change " +
                                changeIndex +
                                " matches text inserted by an earlier change in the same edit; " +
                                "this is likely unintended. Split the changes into separate edit actions " +
                                "or include more context to target the original text.",
                            { matched: "inserted-overlap", changeIndex }
                        );
                    }
                    const startLine = lineOf(text, index);
                    text = text.slice(0, index) + newText + text.slice(endIndex);
                    applied.push({ startLine, removed: oldText, added: newText });
                    removedLines += splitDiffLines(oldText).length;
                    addedLines += splitDiffLines(newText).length;
                    shiftInsertedRanges(insertedRanges, index, endIndex, newText.length);
                    insertedRanges.push({ start: index, end: index + newText.length });
                    cursor = index + newText.length;
                    count += 1;
                    if (!all) {
                        break;
                    }
                }
            } else {
                usedLoose = true;
                const index = found.haystack.text.indexOf(found.needle);
                // 归一化视图跳过了行首缩进，映射回来时把这段缩进补进匹配区间：
                // 既让"文件里的缩进"可比较，也让替换连带换掉整行缩进，
                // 否则会变成"原缩进 + 新缩进"。只有匹配点前面全是空白（即在行首）才补。
                let start = found.haystack.map[index];
                if (found.needle.charAt(0) === "\n") {
                    // needle 以换行开头 = old 的首行是空行，匹配点就是上一行的换行符。
                    // map 指向 \r\n 里的 \n，必须把前面的 \r 一并纳入替换区间，
                    // 否则会留下 "header();\rREPLACED\r\n" 这种孤立 \r。
                    if (start > 0 && text.charAt(start - 1) === "\r") {
                        start -= 1;
                    }
                } else {
                    // 归一化视图跳过了行首缩进，映射回来后把缩进补进匹配区间，
                    // 否则会变成"原缩进 + 新缩进"。仅当回退后确实在行首才采纳。
                    let back = start;
                    while (
                        back > 0 &&
                        (text.charAt(back - 1) === " " || text.charAt(back - 1) === "\t")
                    ) {
                        back -= 1;
                    }
                    const atLineStart =
                        back > 0 &&
                        (text.charAt(back - 1) === "\n" ||
                            (text.charAt(back - 1) === "\r" &&
                                back > 1 &&
                                text.charAt(back - 2) === "\n"));
                    if (atLineStart) {
                        start = back;
                    }
                }
                const last = found.haystack.map[index + found.needle.length - 1];
                let end = last + 1;
                // 命中段的行尾空白一并吃掉，否则替换后会在行尾留下空格
                let scan = end;
                while (
                    scan < text.length &&
                    (text.charAt(scan) === " " || text.charAt(scan) === "\t")
                ) {
                    scan += 1;
                }
                if (scan >= text.length || text.charAt(scan) === "\n") {
                    end = scan;
                }
                const matched = text.slice(start, end);
                if (overlapsInserted(start, end, insertedRanges)) {
                    return fail(
                        "change " +
                            changeIndex +
                            " matches text inserted by an earlier change in the same edit; " +
                            "this is likely unintended. Split the changes into separate edit actions " +
                            "or include more context to target the original text.",
                        { matched: "inserted-overlap", changeIndex }
                    );
                }
                const indentResult = detectIndentShift(oldText, matched);
                if (indentResult.error) {
                    return fail(
                        "Cannot apply change " + changeIndex + ": " + indentResult.error,
                        { matched: "loose", changeIndex }
                    );
                }
                newText = applyIndentShift(newText, indentResult.shift);
                const startLine = lineOf(text, start);
                text = text.slice(0, start) + newText + text.slice(end);
                applied.push({ startLine, removed: matched, added: newText });
                removedLines += splitDiffLines(matched).length;
                addedLines += splitDiffLines(newText).length;
                shiftInsertedRanges(insertedRanges, start, end, newText.length);
                insertedRanges.push({ start, end: start + newText.length });
                count = 1;
            }

            if (!count) {
                return fail(
                    "Text to replace not found in " +
                        filePath +
                        "." +
                        notFoundHint(originalText, text, oldText),
                    { matched: "none", changeIndex }
                );
            }
        }

        try {
            validateContent(filePath, text);
        } catch (validationError) {
            return fail("Content validation failed: " + validationError.message, {
                matched: usedLoose ? "loose" : "exact",
            });
        }
        const size = Buffer.byteLength(text, "utf8");
        if (size > agentConfig.runtime.maxFileSize) {
            return fail("File too large", { matched: usedLoose ? "loose" : "exact" });
        }

        // 原子写入：与 write 一致，先写临时文件再重命名，中断时不会留下半个文件
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        const tempPath = fullPath + ".tmp." + Date.now();
        try {
            fs.writeFileSync(tempPath, text, "utf8");
            fs.renameSync(tempPath, fullPath);
        } catch (error) {
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch (_) {
                // ignore
            }
            // 不再 rethrow 裸 syscall 错误：包装成可读提示，让模型知道是
            // 只读/权限/磁盘这类问题，而不是反复重试同一个写操作。
            return fail(describeWriteFailure(error), {
                matched: usedLoose ? "loose" : "exact",
            });
        }

        const result = {
            ok: true,
            action: "edit",
            path: filePath,
            changes: applied.length,
            lines: { added: addedLines, removed: removedLines },
            matched: usedLoose ? "loose" : "exact",
            size,
            diff: renderDiff(applied),
        };
        if (usedLoose) {
            result.hint =
                "Matched with indentation/trailing-space differences ignored; verify the result.";
        }
        return result;
    },
    meta: {
        prompt: {
            group: "workspace",
            usage: JSON.stringify({
                action: "edit",
                params: {
                    path: "src/app.js",
                    changes: [
                        {
                            old: "const port = 3000;",
                            new: "const port = process.env.PORT || 3000;",
                        },
                    ],
                },
            }),
            note: "局部修改：changes 只给出要替换的原文与新内容，其余部分保持不变（new 为空字符串表示删除，all=true 表示全部替换）。",
            priority: 96,
        },
        permission: ["workspace:write"],
        mutating: true,
        timeoutMs: 15000,
        summary: (result) => "edit " + (result.path || ""),
    },
};
