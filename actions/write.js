/**
内置动作：write

从 runtime.js 迁出（P0 动作定义对象化）。run 的方法体与迁移前逐行一致，
只把 this 换成 ctx.runtime，因此行为完全不变（含错误文案）。

同时接管原 xml-parse.js 里的手写快速解析器（meta.fastPath）：
write 的内容在 CDATA 里可能包含任意文本，交给通用 XML 解析器容易出问题。
*/

const fs = require("fs");
const path = require("path");
const agentConfig = require("../config/agent-config");
const { getText } = require("../parse/xml-text");
const {
    CHAR_LT,
    CHAR_GT,
    CHAR_SLASH,
    CHAR_BANG,
    CHAR_LBRACK,
    CHAR_RBRACK,
    CHAR_DQUOTE,
} = require("../parse/xml-chars");

/**
CDATA 起始处的那个换行是排版产物，不是正文内容。

模型习惯写成 `<write path="x"><![CDATA[\nconsole.log(1);\n]]></write>`，
走通用解析路径时（内容两侧还有别的文字、或首尾不是 `<write>`）这段文本会被
原样取出来，于是每个新建文件都以一个空行开头——lint 会报，diff 也难看。
只吃掉开头**一个**换行，正文内部的空行保持不动。
*/
function stripCdataLeadingNewline(content) {
    return typeof content === "string" ? content.replace(/^\r?\n/, "") : content;
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
解码属性里的实体。

快速解析器读到的是原始文本，`path="a&amp;b.txt"` 会原样当成文件名；
而通用解析路径（fast-xml-parser）和 read 都会解码成 `a&b.txt`。
两条路径给出不同的文件名，就会出现"刚写进去的文件读不到"，
所以这里统一按 XML 规则解一次。
*/
function decodeXmlAttribute(value) {
    return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
        if (body.charAt(0) === "#") {
            const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
            const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
                return match;
            }
            try {
                return String.fromCodePoint(code);
            } catch (error) {
                return match;
            }
        }
        const key = body.toLowerCase();
        return Object.prototype.hasOwnProperty.call(XML_ENTITIES, key) ? XML_ENTITIES[key] : match;
    });
}

// 验证写入内容（可选）
function validateContent(filePath, content) {
    // 如果是 JSON 文件，尝试解析
    if (filePath.endsWith(".json")) {
        try {
            JSON.parse(content);
        } catch (e) {
            throw new Error("Invalid JSON content: " + e.message);
        }
    }
    // 可扩展其他验证
}

/**
手写解析 <write path="..."><![CDATA[...]]></write>。
返回 { action, node } 或 null（null 表示交给通用解析器）。
*/
function tryExtractWriteManually(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    const WRITE_OPEN_PREFIX = CHAR_LT + "write";
    const WRITE_CLOSE_TAG = CHAR_LT + CHAR_SLASH + "write" + CHAR_GT;
    if (trimmed.indexOf(WRITE_OPEN_PREFIX) !== 0) return null;
    if (!trimmed.endsWith(WRITE_CLOSE_TAG)) return null;
    const firstGt = trimmed.indexOf(CHAR_GT);
    if (firstGt === -1) return null;
    const openTag = trimmed.substring(0, firstGt + 1);
    const pathMarker = "path=" + CHAR_DQUOTE;
    const pathStart = openTag.indexOf(pathMarker);
    if (pathStart === -1) return null;
    const pathValueStart = pathStart + pathMarker.length;
    const pathValueEnd = openTag.indexOf(CHAR_DQUOTE, pathValueStart);
    if (pathValueEnd === -1) return null;
    const filePath = decodeXmlAttribute(openTag.substring(pathValueStart, pathValueEnd));
    if (!filePath) return null;
    let content = trimmed.substring(firstGt + 1, trimmed.length - WRITE_CLOSE_TAG.length);
    content = content.trim();
    const CDATA_START = CHAR_LT + CHAR_BANG + CHAR_LBRACK + "CDATA" + CHAR_LBRACK;
    if (content.indexOf(CDATA_START) === 0) {
        content = content.substring(CDATA_START.length);
    }
    const CDATA_END = CHAR_RBRACK + CHAR_RBRACK + CHAR_GT;
    if (content.endsWith(CDATA_END)) {
        content = content.substring(0, content.length - CDATA_END.length);
    }
    if (!content.trim()) return null;
    return {
        action: "write",
        node: {
            "@_path": filePath,
            "#text": content,
        },
    };
}

module.exports = {
    name: "write",
    validate(node) {
        if (!node || typeof node !== "object") {
            throw new Error("write action is invalid");
        }
        if (!node["@_path"]) {
            throw new Error("write requires path");
        }
        // 归一化之后再判空：只写了一个换行的文件等于空文件，
        // 与 validate 的 "content cannot be empty" 保持一致。
        if (!stripCdataLeadingNewline(getText(node)).trim()) {
            throw new Error("write content cannot be empty");
        }
    },
    run(node, ctx) {
        const filePath = node?.["@_path"];
        if (!filePath) {
            throw new Error("write requires path");
        }
        const fullPath = ctx.runtime.resolvePath(filePath);
        const content = stripCdataLeadingNewline(getText(node));
        // 目标是已存在的目录时，rename 会抛 EPERM 并把临时文件名带进错误信息，
        // 模型看到的是"内部错误"。这里直接给出可理解的结论。
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
            return {
                ok: false,
                action: "write",
                path: filePath,
                error: "Path is an existing directory, not a file",
            };
        }
        if (Buffer.byteLength(content, "utf8") > agentConfig.runtime.maxFileSize) {
            return {
                ok: false,
                action: "write",
                path: filePath,
                error: "File too large",
            };
        }
        // 内容验证（仅对特定类型）
        try {
            validateContent(filePath, content);
        } catch (validationError) {
            return {
                ok: false,
                action: "write",
                path: filePath,
                error: "Content validation failed: " + validationError.message,
            };
        }
        // 原子写入：先写入临时文件，再重命名
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        const tempPath = fullPath + ".tmp." + Date.now();
        try {
            fs.writeFileSync(tempPath, content, "utf8");
            fs.renameSync(tempPath, fullPath);
        } catch (err) {
            // 清理临时文件
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch (_) {
                // ignore
            }
            throw err;
        }
        return {
            ok: true,
            action: "write",
            path: filePath,
            size: Buffer.byteLength(content, "utf8"),
        };
    },
    meta: {
        prompt: {
            group: "workspace",
            usage: '<write path="src/test.js"><![CDATA[\nconsole.log("hello");\n]]></write>',
            note: "写入文件，自动创建父目录；内容必须放在 CDATA 中。",
            priority: 95,
        },
        permission: ["workspace:write"],
        mutating: true,
        timeoutMs: 15000,
        summary: (result) => "write " + (result.path || ""),
        fastPath: tryExtractWriteManually,
    },
};
