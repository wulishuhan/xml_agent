/** 内置动作：read */

const fs = require("fs");
const agentConfig = require("../config/agent-config");
const { BUILTIN_ACTION_SCHEMAS, MAX_READ_CHARS } = require("../parse/action-schema");

function resolveReadWindow(params) {
    const offset = params.offset === undefined ? 0 : params.offset;
    const limit = params.limit === undefined ? MAX_READ_CHARS : params.limit;
    if (!Number.isInteger(offset) || offset < 0) {
        throw new Error("read offset must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_CHARS) {
        throw new Error("read limit must be an integer between 1 and " + MAX_READ_CHARS);
    }
    return { offset, limit };
}

module.exports = {
    name: "read",
    schema: BUILTIN_ACTION_SCHEMAS.read,
    validate(params) {
        if (!params || typeof params !== "object" || Array.isArray(params)) {
            throw new Error("read action is invalid");
        }
        if (!params.path) {
            throw new Error("read requires path");
        }
        resolveReadWindow(params);
    },
    run(params, ctx) {
        const filePath = params?.path;
        if (!filePath) {
            throw new Error("read requires path");
        }
        const { offset, limit } = resolveReadWindow(params);
        const fullPath = ctx.runtime.resolvePath(filePath);
        // 上限在调用时读取：通过 /api/agent/config 修改后无需重启即可生效。
        const maxReadSize = agentConfig.runtime.maxReadSize;
        if (!fs.existsSync(fullPath)) {
            return {
                ok: false,
                action: "read",
                path: filePath,
                error: "File or directory does not exist",
            };
        }
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            const entries = fs
                .readdirSync(fullPath, {
                    withFileTypes: true,
                })
                .map((entry) => {
                    return entry.name + (entry.isDirectory() ? "/" : "");
                })
                .sort();
            return {
                ok: true,
                action: "read",
                path: filePath,
                type: "directory",
                entries,
            };
        }
        if (stat.size > maxReadSize) {
            return {
                ok: false,
                action: "read",
                path: filePath,
                error: "File too large to read. Size: " + stat.size + " bytes",
            };
        }
        const buffer = fs.readFileSync(fullPath);
        // 二进制文件读成 utf8 会得到一堆 U+0000 与乱码，既浪费上下文，也容易让
        // 模型误判"这个文件坏了"并去改它。NUL 是最可靠的文本/二进制分界。
        if (buffer.subarray(0, 8192).indexOf(0) !== -1) {
            return {
                ok: false,
                action: "read",
                path: filePath,
                size: stat.size,
                binary: true,
                error: "Binary file (NUL bytes detected); read only handles text files",
            };
        }
        const content = buffer.toString("utf8");
        let end = Math.min(content.length, offset + limit);
        if (end > offset + 1 && end < content.length) {
            const before = content.charCodeAt(end - 1);
            const after = content.charCodeAt(end);
            if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
                end -= 1;
            }
        }
        const nextOffset = end < content.length ? end : null;
        return {
            ok: true,
            action: "read",
            path: filePath,
            type: "file",
            size: stat.size,
            offset,
            limit,
            totalChars: content.length,
            returnedChars: end > offset ? end - offset : 0,
            truncated: nextOffset !== null,
            hasMore: nextOffset !== null,
            nextOffset,
            content: content.slice(offset, end),
        };
    },
    meta: {
        prompt: {
            group: "workspace",
            usage: '{"action":"read","params":{"path":"src"}}',
            note: "读取文件或目录；文件最多返回 4000 字符，truncated=true 时用 nextOffset 作为 offset 继续读。",
            priority: 100,
        },
        permission: ["workspace:read"],
        mutating: false,
        timeoutMs: 15000,
        summary: (result) => "read " + (result.path || ""),
    },
};
