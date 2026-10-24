const path = require("path");
const fs = require("fs");
const { captureScreenshot } = require("../capture/screenshot");
const SCREENSHOT_DIR = "screenshots";
const VALID_SOURCES = ["browser_page", "screen", "window"];
const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 5 * 60 * 1000;
function isPathInside(parent, child) {
    const parentResolved = path.resolve(parent);
    const childResolved = path.resolve(child);
    const prefix = parentResolved.endsWith(path.sep) ? parentResolved : parentResolved + path.sep;
    return childResolved === parentResolved || childResolved.startsWith(prefix);
}
function buildTimestampName(prefix) {
    const now = new Date();
    const pad = function (value, size) {
        return String(value).padStart(size || 2, "0");
    };
    const stamp =
        now.getFullYear() +
        pad(now.getMonth() + 1) +
        pad(now.getDate()) +
        "-" +
        pad(now.getHours()) +
        pad(now.getMinutes()) +
        pad(now.getSeconds()) +
        "-" +
        pad(now.getMilliseconds(), 3);
    return (prefix || "screenshot") + "-" + stamp + ".png";
}
function toBoolean(value, defaultValue) {
    if (value === undefined || value === null) {
        return defaultValue;
    }
    if (typeof value === "boolean") {
        return value;
    }
    const text = String(value).trim().toLowerCase();
    if (text === "true" || text === "1" || text === "yes") {
        return true;
    }
    if (text === "false" || text === "0" || text === "no") {
        return false;
    }
    return defaultValue;
}
function normalizeTimeout(value) {
    if (value === undefined || value === null || value === "") {
        return DEFAULT_TIMEOUT;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        return DEFAULT_TIMEOUT;
    }
    return Math.min(Math.floor(number), MAX_TIMEOUT);
}
// 校验 clip 结构：必须是 { x, y, width, height } 且都是非负有限数字。
// 无法识别时返回 null，由调用方决定是否忽略（playwright 对非法 clip 会抛错，提前拦住给清晰信息）。
function normalizeClip(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const keys = ["x", "y", "width", "height"];
    const clip = {};
    for (const key of keys) {
        const number = Number(value[key]);
        if (!Number.isFinite(number) || number < 0) {
            return null;
        }
        clip[key] = number;
    }
    if (clip.width <= 0 || clip.height <= 0) {
        return null;
    }
    return clip;
}
function resolveOutputPath(workspace, relativePath) {
    const workspaceResolved = path.resolve(workspace);
    const target = relativePath
        ? path.resolve(workspaceResolved, relativePath)
        : path.resolve(workspaceResolved, SCREENSHOT_DIR, buildTimestampName("screenshot"));
    if (!isPathInside(workspaceResolved, target)) {
        throw new Error("Screenshot path escapes workspace: " + relativePath);
    }
    return target;
}
async function takeScreenshot(params) {
    const options = params || {};
    const workspace = options.workspace;
    if (!workspace || typeof workspace !== "string") {
        throw new Error("workspace is required");
    }
    if (options.path !== undefined && options.path !== null && typeof options.path !== "string") {
        throw new Error("path must be a string");
    }
    const workspaceResolved = path.resolve(workspace);
    if (!fs.existsSync(workspaceResolved) || !fs.statSync(workspaceResolved).isDirectory()) {
        throw new Error("workspace does not exist: " + workspace);
    }
    const source = options.source || "screen";
    if (VALID_SOURCES.indexOf(source) === -1) {
        throw new Error("source must be one of: " + VALID_SOURCES.join(", "));
    }
    if (source === "window") {
        const title = options.windowTitle !== undefined ? options.windowTitle : options.title;
        if (title !== undefined && title !== null && typeof title !== "string") {
            throw new Error("windowTitle must be a string");
        }
        if (!title || !String(title).trim()) {
            throw new Error("windowTitle is required for source=window");
        }
    }
    if (source === "browser_page" && options.url !== undefined && options.url !== null) {
        if (typeof options.url !== "string" || !options.url.trim()) {
            throw new Error("url must be a non-empty string");
        }
    }
    if (source === "browser_page" && options.selector !== undefined && options.selector !== null) {
        if (typeof options.selector !== "string" || !options.selector.trim()) {
            throw new Error("selector must be a non-empty string");
        }
    }
    const fullPage = toBoolean(options.fullPage, false);
    const clip = normalizeClip(options.clip);
    // 显式传了 clip 但无法解析，说明调用方写法有误，直接报错而不是静默忽略。
    if (options.clip !== undefined && options.clip !== null && !clip) {
        throw new Error("clip must be an object with numeric x/y/width/height (> 0)");
    }
    const outputPath = resolveOutputPath(workspaceResolved, options.path);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const result = await captureScreenshot({
        source: source,
        outputPath: outputPath,
        url: options.url,
        selector: options.selector,
        clip: clip || undefined,
        fullPage: fullPage,
        windowTitle: options.windowTitle || options.title,
        cdpUrl: options.cdpUrl,
        timeout: normalizeTimeout(options.timeout),
    });
    if (!result.ok) {
        // 截图失败时清掉可能残留的半个文件，避免 workspace 里留下 0 字节图片。
        try {
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
        } catch (error) {
            // ignore
        }
        return {
            ok: false,
            source: source,
            error: result.error || "screenshot failed",
        };
    }
    return {
        ok: true,
        source: source,
        path: path.relative(workspaceResolved, outputPath).split(path.sep).join("/"),
        absolutePath: outputPath,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        url: result.url,
        note: result.note,
    };
}
function registerScreenshotRoutes(app) {
    app.post("/api/screenshot", async (req, res) => {
        try {
            const body = req.body || {};
            const result = await takeScreenshot({
                workspace: body.workspace,
                path: body.path,
                source: body.source,
                url: body.url,
                selector: body.selector,
                clip: body.clip,
                fullPage: body.fullPage,
                windowTitle: body.windowTitle,
                cdpUrl: body.cdpUrl,
                timeout: body.timeout,
            });
            if (!result.ok) {
                return res.status(500).json(result);
            }
            return res.json(result);
        } catch (error) {
            // 参数类错误返回 400，便于前端区分"请求写错了"和"执行失败了"。
            return res.status(400).json({
                ok: false,
                error: error.message,
            });
        }
    });
}
module.exports = {
    takeScreenshot,
    registerScreenshotRoutes,
    resolveOutputPath,
    isPathInside,
    normalizeClip,
    normalizeTimeout,
    toBoolean,
};
