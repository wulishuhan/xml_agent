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
    const filePath = openTag.substring(pathValueStart, pathValueEnd);
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
        if (!getText(node)) {
            throw new Error("write content cannot be empty");
        }
    },
    run(node, ctx) {
        const filePath = node?.["@_path"];
        if (!filePath) {
            throw new Error("write requires path");
        }
        const fullPath = ctx.runtime.resolvePath(filePath);
        const content = getText(node);
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
