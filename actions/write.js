/**
 * 内置动作：write
 *
 * 接收 JSON params；content 是正文本身，不做任何归一化。
 */

const fs = require("fs");
const path = require("path");
const agentConfig = require("../config/agent-config");
const { BUILTIN_ACTION_SCHEMAS } = require("../parse/action-schema");
const { validateContent } = require("./content-check");

module.exports = {
    name: "write",
    schema: BUILTIN_ACTION_SCHEMAS.write,
    validate(params) {
        if (!params || typeof params !== "object" || Array.isArray(params)) {
            throw new Error("write action is invalid");
        }
        if (!params.path) {
            throw new Error("write requires path");
        }
        if (typeof params.content !== "string" || !params.content.trim()) {
            throw new Error("write content cannot be empty");
        }
    },
    run(params, ctx) {
        const filePath = params?.path;
        if (!filePath) {
            throw new Error("write requires path");
        }
        const fullPath = ctx.runtime.resolvePath(filePath);
        const content = params.content;
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
            usage: '{"action":"write","params":{"path":"src/test.js","content":"console.log(\\"hello\\");\\n"}}',
            note: "写入文件，自动创建父目录；content 按 JSON 字符串逐字保存。",
            priority: 95,
        },
        permission: ["workspace:write"],
        mutating: true,
        timeoutMs: 15000,
        summary: (result) => "write " + (result.path || ""),
    },
};
