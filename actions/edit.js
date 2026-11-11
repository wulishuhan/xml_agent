/**
内置动作：edit —— 局部修改文件

write 是"整篇重写"：为了改一行，模型必须把整个文件重新生成一遍。
代价有两层：token 花在复述没变的代码上；任何一处手误都会把原本没问题的
部分一起改坏，而 diff 里根本看不出哪些是"顺手改到的"。

edit 只要求给出"要改的那一段（old）"和"改成什么（new）"，
其余内容逐字节保留。一次动作可以带多个 <change>，按顺序执行。

匹配规则（依次尝试）：
1. 精确匹配：old 在文件里必须出现；出现多次要让 old 带更多上下文，
   或用 all="true" 表示"全部替换"。
2. 宽松匹配：精确匹配 0 次时，忽略行首缩进与行尾空白再找一次
   （old 长度不足 MIN_LOOSE_LENGTH 时不启用，避免短串误命中别处）。
   命中后按原文位置替换，并把缩进差补到 new 的每一行上。

任何一处 <change> 失败就整体放弃、不落盘 —— 改到一半的文件比没改更难收拾。
*/

const fs = require("fs");
const path = require("path");
const agentConfig = require("../config/agent-config");
const { getText, decodeXmlEntities } = require("../parse/xml-text");
const { validateContent } = require("./content-check");

// 宽松匹配的最短长度：太短的锚点剥掉缩进后容易命中别处，宁可报"找不到"。
const MIN_LOOSE_LENGTH = 16;
// 单次动作的修改块上限：再多就不该用 edit，而是重写整个文件。
const MAX_CHANGES = 20;
// diff 回显上限：给模型确认用，不是给界面看的完整补丁。
const MAX_DIFF_LINES = 40;
const MAX_DIFF_CHARS = 2000;
const MAX_DIFF_LINE_CHARS = 200;

const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

/**
CDATA 两侧的换行是排版产物，不是正文。

模型习惯写成
  <old><![CDATA[
  const a = 1;
  ]]></old>
开头和结尾那两个换行都不属于"要匹配的原文"。old 与 new 用同一套规则
剥掉（仅当内容以换行开头时，首尾各剥一个），两边口径一致，
替换结果才不会莫名多出或少掉一个空行。
*/
function trimBlock(text) {
    const value = typeof text === "string" ? text : String(text === undefined ? "" : text);
    if (!value.startsWith("\n") && !value.startsWith("\r\n")) {
        return value;
    }
    return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

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

function countNewlines(text, upTo) {
    let count = 0;
    let index = text.indexOf("\n");
    while (index !== -1 && index < upTo) {
        count += 1;
        index = text.indexOf("\n", index + 1);
    }
    return count;
}

function lineOf(text, offset) {
    return 1 + countNewlines(text, offset);
}

/**
生成"忽略缩进与行尾空白"的视图，并记录每个字符回到原文的下标。

为什么要映射：宽松匹配是在归一化后的字符串上找位置的，而替换必须落在原文
的确切区间上。map[i] 是归一化第 i 个字符在原文中的下标，map[length] 是原文长度。
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

function leadingIndent(line) {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0] : "";
}

/**
算出"模型写的 old 与文件里那段原文"的缩进差。

只看第一行是不够的：块的第一行往往没有缩进（`if (x) {` 就在行首），
真正的差异在块内部 —— 只看第一行会得出"没差别"，于是把模型的缩进原样插进去。
所以逐行比对，取出现次数最多的那一种差值（按行投票），空行不参与。
*/
function detectIndentShift(oldText, matched) {
    const oldLines = oldText.split(/\r?\n/);
    const fileLines = matched.split(/\r?\n/);
    if (oldLines.length !== fileLines.length) {
        return null;
    }
    const votes = new Map();
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
            continue;
        }
        const key = mode + ":" + prefix;
        const entry = votes.get(key) || { mode, prefix, count: 0 };
        entry.count += 1;
        votes.set(key, entry);
    }
    let best = null;
    for (const entry of votes.values()) {
        if (!best || entry.count > best.count) {
            best = entry;
        }
    }
    return best;
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

/** 找不到时给一条"最接近的位置"，比只说 not found 有用得多。 */
function notFoundHint(text, oldText) {
    const probe = oldText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length >= 8);
    if (!probe) {
        return "";
    }
    const needle = probe.slice(0, 40);
    const index = text.indexOf(needle);
    if (index === -1) {
        return "";
    }
    return (
        " The closest line of <old> appears at line " +
        lineOf(text, index) +
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
回显这次改动，让模型不必再 read 一次整个文件就能确认结果。
不是标准 unified diff（没有上下文行），只列被替换的行 —— 够用且便宜。
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

// ------------------------------------------------------------
// 节点归一化：快速解析器与通用解析器给出的结构不同，统一成 change 列表
// ------------------------------------------------------------

function normalizeChanges(node) {
    if (!node || typeof node !== "object") {
        return [];
    }
    const raw = node.change;
    const items = raw === undefined || raw === null ? [node] : Array.isArray(raw) ? raw : [raw];
    const changes = [];
    for (const item of items) {
        if (!item || typeof item !== "object") {
            continue;
        }
        // <new></new> 与 <new/> 都会被解析成空串（= 删除这段）；
        // 只有整个 <new> 缺失时才是 undefined，那属于写法错误。
        const hasNew = item.new !== undefined && item.new !== null;
        changes.push({
            old: trimBlock(getText(item.old)),
            new: hasNew ? trimBlock(getText(item.new)) : null,
        });
    }
    return changes;
}

function isAll(node) {
    const value = node && node["@_all"];
    if (value === undefined || value === null) {
        return false;
    }
    const text = String(value).trim().toLowerCase();
    return text === "true" || text === "1" || text === "yes";
}

// ------------------------------------------------------------
// 手写快速解析器
// ------------------------------------------------------------

function readAttribute(openTag, name) {
    for (const quote of ['"', "'"]) {
        const marker = name + "=" + quote;
        const start = openTag.indexOf(marker);
        if (start === -1) {
            continue;
        }
        const valueStart = start + marker.length;
        const valueEnd = openTag.indexOf(quote, valueStart);
        if (valueEnd === -1) {
            continue;
        }
        return decodeXmlEntities(openTag.slice(valueStart, valueEnd));
    }
    return "";
}

/**
识别 pos 处的 <name ...> / </name>。
返回 { closing, selfClosing, end } 或 null。
*/
function matchTag(body, pos, name) {
    if (body.charAt(pos) !== "<") {
        return null;
    }
    const closing = body.substring(pos, pos + name.length + 2) === "</" + name;
    if (!closing) {
        if (body.substring(pos, pos + name.length + 1) !== "<" + name) {
            return null;
        }
        const next = body.charAt(pos + name.length + 1);
        // <new> 不能匹配到 <newline> 这种前缀相同的标签
        if (next !== "" && "> \t\r\n/".indexOf(next) === -1) {
            return null;
        }
    }
    const end = body.indexOf(">", pos);
    if (end === -1) {
        return null;
    }
    return {
        closing,
        selfClosing: body.charAt(end - 1) === "/",
        end: end + 1,
    };
}

/**
扫描 <edit> 的正文，tokens 顺序无关（<change> 可写可不写）。
返回 [{ old, new }] 或 null（写法无法识别时交给通用解析器）。
*/
function scanChanges(body) {
    const pairs = [];
    let current = null;
    let field = null;
    let pieces = [];

    const finishField = () => {
        if (!field) {
            return;
        }
        // 分段解码：CDATA 段是字面文本（`&amp;` 保持原样），
        // 段落外的文本遵循 XML 规则解码。按段而不是按字符，
        // 否则单字符的 "&" 永远匹配不到 "&amp;" 这个整体。
        const value = pieces
            .map((piece) => (piece.cdata ? piece.text : decodeXmlEntities(piece.text)))
            .join("");
        if (current) {
            current[field] = value;
        }
        field = null;
        pieces = [];
    };
    const pushPiece = (text, cdata) => {
        const last = pieces[pieces.length - 1];
        if (last && last.cdata === cdata) {
            last.text += text;
            return;
        }
        pieces.push({ text, cdata });
    };
    const ensureCurrent = () => {
        if (!current) {
            current = { old: undefined, new: undefined };
        }
        return current;
    };

    let pos = 0;
    const len = body.length;
    while (pos < len) {
        const ch = body.charAt(pos);
        if (ch === "<" && body.startsWith(CDATA_OPEN, pos)) {
            const end = body.indexOf(CDATA_CLOSE, pos + CDATA_OPEN.length);
            if (end === -1) {
                return null;
            }
            pushPiece(body.slice(pos + CDATA_OPEN.length, end), true);
            pos = end + CDATA_CLOSE.length;
            continue;
        }
        if (ch === "<") {
            const changeTag = matchTag(body, pos, "change");
            if (changeTag) {
                finishField();
                if (changeTag.closing) {
                    if (current) {
                        pairs.push(current);
                        current = null;
                    }
                } else {
                    ensureCurrent();
                }
                pos = changeTag.end;
                continue;
            }
            let handled = false;
            for (const name of ["old", "new"]) {
                const tag = matchTag(body, pos, name);
                if (!tag) {
                    continue;
                }
                finishField();
                // 扁平写法里可以连续出现多组 <old>/<new>：见到新的 <old> 就收口上一组
                if (
                    name === "old" &&
                    !tag.closing &&
                    !tag.selfClosing &&
                    current &&
                    current.old !== undefined
                ) {
                    pairs.push(current);
                    current = null;
                }
                const target = ensureCurrent();
                if (tag.closing) {
                    if (target[name] === undefined) {
                        target[name] = "";
                    }
                } else if (tag.selfClosing) {
                    target[name] = "";
                } else {
                    field = name;
                    pieces = [];
                }
                pos = tag.end;
                handled = true;
                break;
            }
            if (handled) {
                continue;
            }
        }
        if (field) {
            pushPiece(ch, false);
        }
        pos += 1;
    }
    finishField();
    if (current) {
        pairs.push(current);
    }
    const changes = pairs.filter((pair) => pair.old !== undefined || pair.new !== undefined);
    if (!changes.length) {
        return null;
    }
    return changes;
}

/**
手写解析 <edit path="...">...</edit>。
返回 { action, node } 或 null（null 表示交给通用解析器）。
理由与 write 相同：正文里可能出现任意文本，通用 XML 解析器对未加 CDATA 的
`<` / `&` 很敏感，而这里只需要认出几个固定标签。
*/
function tryExtractEditManually(text) {
    if (!text || typeof text !== "string") {
        return null;
    }
    const trimmed = text.trim();
    if (trimmed.indexOf("<edit") !== 0) {
        return null;
    }
    const CLOSE_TAG = "</edit>";
    if (!trimmed.endsWith(CLOSE_TAG)) {
        return null;
    }
    const firstGt = trimmed.indexOf(">");
    if (firstGt === -1) {
        return null;
    }
    const openTag = trimmed.slice(0, firstGt + 1);
    const filePath = readAttribute(openTag, "path");
    if (!filePath) {
        return null;
    }
    const body = trimmed.slice(firstGt + 1, trimmed.length - CLOSE_TAG.length);
    const changes = scanChanges(body);
    if (!changes) {
        return null;
    }
    const node = { "@_path": filePath };
    const all = readAttribute(openTag, "all");
    if (all) {
        node["@_all"] = all;
    }
    node.change = changes;
    return { action: "edit", node };
}

// ------------------------------------------------------------

module.exports = {
    name: "edit",
    validate(node) {
        if (!node || typeof node !== "object") {
            throw new Error("edit action is invalid");
        }
        if (!node["@_path"]) {
            throw new Error("edit requires path");
        }
        const changes = normalizeChanges(node);
        if (!changes.length) {
            throw new Error("edit requires at least one <change> with <old>/<new>");
        }
        for (const change of changes) {
            if (change.new === null) {
                throw new Error("edit change requires <new> (use an empty <new> to delete)");
            }
            if (!change.old.trim()) {
                throw new Error(
                    "edit change requires non-empty <old> (use write to create a file)"
                );
            }
        }
    },
    run(node, ctx) {
        const filePath = node?.["@_path"];
        if (!filePath) {
            throw new Error("edit requires path");
        }
        const fullPath = ctx.runtime.resolvePath(filePath);
        const changes = normalizeChanges(node);
        const fail = (error, extra) =>
            Object.assign({ ok: false, action: "edit", path: filePath, error }, extra || {});

        if (!changes.length) {
            return fail("edit requires at least one <change> with <old>/<new>");
        }
        if (changes.length > MAX_CHANGES) {
            return fail("Too many changes in one edit (max " + MAX_CHANGES + ")");
        }
        for (const change of changes) {
            if (change.new === null) {
                return fail("edit change requires <new> (use an empty <new> to delete)");
            }
            if (!change.old.trim()) {
                return fail("edit change requires non-empty <old> (use write to create a file)");
            }
        }
        if (!fs.existsSync(fullPath)) {
            return fail("File does not exist; use <write> to create it");
        }
        if (fs.statSync(fullPath).isDirectory()) {
            return fail("Path is an existing directory, not a file");
        }
        const buffer = fs.readFileSync(fullPath);
        if (buffer.subarray(0, 8192).indexOf(0) !== -1) {
            return fail("Binary file (NUL bytes detected); edit only handles text files");
        }

        let text = buffer.toString("utf8");
        const eol = text.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
        const all = isAll(node);
        const applied = [];
        let usedLoose = false;
        let addedLines = 0;
        let removedLines = 0;

        for (const change of changes) {
            const oldText = toFileEol(change.old, eol);
            let newText = toFileEol(change.new, eol);
            const found = locate(text, oldText);

            if (!found.count) {
                return fail(
                    "Text to replace not found in " + filePath + "." + notFoundHint(text, oldText),
                    { matched: "none" }
                );
            }
            if (found.count > 1 && !all) {
                const lines = occurrenceLines(text, oldText, 5);
                return fail(
                    "Found " +
                        found.count +
                        " matches of <old> (lines " +
                        lines.join(", ") +
                        (found.count > lines.length ? ", …" : "") +
                        '). Add more surrounding lines to make it unique, or use all="true" to replace every match.',
                    { matches: found.count, lines }
                );
            }
            // 宽松匹配只能定位到"唯一一处"（位置来自归一化视图的映射）。
            // 又要 all=true 就会变成"答应替换全部，实际只改一处"，
            // 这种静默少做比直接报错更难发现。
            if (found.mode === "loose" && found.count > 1 && all) {
                return fail(
                    'all="true" cannot be combined with an indentation-loose match (found ' +
                        found.count +
                        "). Copy <old> exactly as it appears in the file, or edit one occurrence at a time.",
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
                    const startLine = lineOf(text, index);
                    text = text.slice(0, index) + newText + text.slice(index + oldText.length);
                    applied.push({ startLine, removed: oldText, added: newText });
                    removedLines += splitDiffLines(oldText).length;
                    addedLines += splitDiffLines(newText).length;
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
                let back = start;
                while (
                    back > 0 &&
                    (text.charAt(back - 1) === " " || text.charAt(back - 1) === "\t")
                ) {
                    back -= 1;
                }
                if (back > 0 && text.charAt(back - 1) !== "\n") {
                    back = start;
                }
                start = back;
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
                newText = applyIndentShift(newText, detectIndentShift(oldText, matched));
                const startLine = lineOf(text, start);
                text = text.slice(0, start) + newText + text.slice(end);
                applied.push({ startLine, removed: matched, added: newText });
                removedLines += splitDiffLines(matched).length;
                addedLines += splitDiffLines(newText).length;
                count = 1;
            }

            if (!count) {
                return fail(
                    "Text to replace not found in " + filePath + "." + notFoundHint(text, oldText),
                    {
                        matched: "none",
                    }
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
            throw error;
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
            usage: '<edit path="src/app.js">\n  <change>\n    <old><![CDATA[const port = 3000;]]></old>\n    <new><![CDATA[const port = process.env.PORT || 3000;]]></new>\n  </change>\n</edit>',
            note: '局部修改：只给出要替换的原文与新内容，其余部分保持不变（<new> 留空表示删除，all="true" 表示全部替换）。',
            priority: 96,
        },
        permission: ["workspace:write"],
        mutating: true,
        timeoutMs: 15000,
        summary: (result) => "edit " + (result.path || ""),
        fastPath: tryExtractEditManually,
    },
};
