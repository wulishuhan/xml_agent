const path = require("path");
const fs = require("fs");
const multer = require("multer");
const UPLOAD_DIR = "uploads";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 8;
const ALLOWED_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
function isPathInside(parent, child) {
    const parentResolved = path.resolve(parent);
    const childResolved = path.resolve(child);
    const prefix = parentResolved.endsWith(path.sep) ? parentResolved : parentResolved + path.sep;
    return childResolved === parentResolved || childResolved.startsWith(prefix);
}
function buildSafeName(originalName) {
    const base = path.basename(String(originalName || "image"));
    const ext = path.extname(base).toLowerCase();
    const stem = base.slice(0, base.length - ext.length).replace(/[^a-zA-Z0-9_-]/g, "_") || "image";
    const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    return stem.slice(0, 40) + "-" + stamp + ext;
}
function resolveWorkspace(raw) {
    if (!raw || typeof raw !== "string") {
        throw new Error("workspace is required");
    }
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error("workspace does not exist: " + raw);
    }
    return resolved;
}
// 用内存存储接收文件，校验通过后再写入 workspace/uploads，避免半途失败留下垃圾文件。
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_BYTES,
        files: MAX_FILES,
    },
    fileFilter: function (req, file, cb) {
        const ext = path.extname(String(file.originalname || "")).toLowerCase();
        if (ALLOWED_EXT.indexOf(ext) === -1) {
            cb(new Error("unsupported image type: " + (ext || "(none)")));
            return;
        }
        cb(null, true);
    },
});
function registerUploadRoutes(app) {
    app.post("/api/uploads", function (req, res) {
        // workspace 放在 query 上，multer 解析文件之前就能拿到，避免字段顺序依赖。
        let workspace;
        try {
            workspace = resolveWorkspace(req.query.workspace);
        } catch (error) {
            return res.status(400).json({ ok: false, error: error.message });
        }
        upload.array("images", MAX_FILES)(req, res, function (err) {
            if (err) {
                return res.status(400).json({ ok: false, error: err.message });
            }
            const files = req.files || [];
            if (!files.length) {
                return res.status(400).json({ ok: false, error: "no files uploaded" });
            }
            const uploadDir = path.resolve(workspace, UPLOAD_DIR);
            if (!isPathInside(workspace, uploadDir)) {
                return res.status(400).json({ ok: false, error: "upload path escapes workspace" });
            }
            fs.mkdirSync(uploadDir, { recursive: true });
            const saved = [];
            try {
                for (const file of files) {
                    const name = buildSafeName(file.originalname);
                    const target = path.join(uploadDir, name);
                    if (!isPathInside(workspace, target)) {
                        throw new Error("target path escapes workspace");
                    }
                    fs.writeFileSync(target, file.buffer);
                    saved.push({
                        path: path.relative(workspace, target).split(path.sep).join("/"),
                        absolutePath: target,
                        bytes: file.size,
                        name: name,
                    });
                }
            } catch (writeError) {
                // 写盘阶段失败：清理本次已写入的文件，避免残留。
                for (const item of saved) {
                    try {
                        fs.unlinkSync(item.absolutePath);
                    } catch (cleanupError) {
                        // ignore
                    }
                }
                return res.status(500).json({ ok: false, error: writeError.message });
            }
            return res.json({
                ok: true,
                count: saved.length,
                files: saved,
                paths: saved.map((item) => item.path),
            });
        });
    });
}
module.exports = {
    registerUploadRoutes,
    UPLOAD_DIR,
    MAX_FILE_BYTES,
    MAX_FILES,
    ALLOWED_EXT,
};
