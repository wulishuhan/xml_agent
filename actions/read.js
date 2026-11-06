/**
内置动作：read

从 runtime.js 迁出（P0 动作定义对象化）。run 的方法体与迁移前逐行一致，
只把 this 换成 ctx.runtime，因此行为完全不变（含错误文案）。
*/

const fs = require("fs");
const agentConfig = require("../config/agent-config");

module.exports = {
    name: "read",
    validate(node) {
        if (!node || typeof node !== "object") {
            throw new Error("read action is invalid");
        }
        if (!node["@_path"]) {
            throw new Error("read requires path");
        }
    },
    run(node, ctx) {
        const filePath = node?.["@_path"];
        if (!filePath) {
            throw new Error("read requires path");
        }
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
        return {
            ok: true,
            action: "read",
            path: filePath,
            type: "file",
            size: stat.size,
            content,
        };
    },
    meta: {
        prompt: {
            group: "workspace",
            usage: '<read path="src"/>',
            note: "读取文件或目录；目录返回 entries。",
            priority: 100,
        },
        permission: ["workspace:read"],
        mutating: false,
        timeoutMs: 15000,
        summary: (result) => "read " + (result.path || ""),
    },
};
