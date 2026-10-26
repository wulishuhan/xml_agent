const express = require("express");
const path = require("path");
const fs = require("fs");
const { SessionManager } = require("./session/session-manager");
const browserSettings = require("./browser-settings");
const { registerScreenshotRoutes } = require("./screenshot-api");
const { registerUploadRoutes } = require("./upload-api");
const app = express();
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const sessionManager = new SessionManager();
// 进程启动时，从用户主目录恢复上次的会话，避免重启后 WebUI 变成空会话。
try {
    const restoredCount = sessionManager.restore();
    if (restoredCount > 0) {
        console.log("[WebUI] Restored " + restoredCount + " session(s) from disk");
    }
    // 顺带清理上次异常退出遗留的 .tmp 临时文件，避免占用磁盘。
    const cleanedBytes = sessionManager.cleanOrphanTmpFiles();
    if (cleanedBytes > 0) {
        console.log("[WebUI] Cleaned " + cleanedBytes + " bytes of orphan temp files");
    }
} catch (error) {
    console.error("[WebUI] Failed to restore sessions:", error.message);
}
// 启动时把已保存的浏览器设置同步到运行环境，确保 Agent 使用所选浏览器。
try {
    browserSettings.applyToRuntime(browserSettings.readSettings());
} catch (error) {
    console.warn("[WebUI] Failed to apply browser settings to runtime:", error.message);
}
const frontendDistPath = path.join(__dirname, "frontend", "dist");
const BACKSLASH = String.fromCharCode(92);
app.use(express.json());
// 截图接口：Web 版与桌面版共用同一份本地 Node 后端实现。
registerScreenshotRoutes(app);
// 用户图片上传接口（Web 版）：multipart 落到 workspace/uploads。
registerUploadRoutes(app);
app.use(express.static(frontendDistPath));
app.get("/xml_agent_web", (req, res) => {
    res.sendFile(path.join(frontendDistPath, "index.html"));
});
function getSession(req, res) {
    const session = sessionManager.get(req.params.id);
    if (!session) {
        res.status(404).json({
            error: "Session not found",
        });
        return null;
    }
    return session;
}
function getWindowsDrives() {
    const drives = [];
    for (let code = 65; code <= 90; code += 1) {
        const letter = String.fromCharCode(code);
        const drive = letter + ":" + BACKSLASH;
        try {
            if (fs.statSync(drive).isDirectory()) {
                drives.push({
                    name: letter + ":",
                    path: drive,
                });
            }
        } catch (error) {
            // Drive is unavailable or inaccessible.
        }
    }
    return drives;
}
function getDirectoryEntries(targetPath) {
    return fs
        .readdirSync(targetPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
            name: entry.name,
            path: path.join(targetPath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
// 规范化用户传入的 images：只接受相对 workspace 的路径或绝对路径字符串数组。
// 上限 8 张，非法项直接丢弃，避免恶意/脏数据进入 Agent。
function normalizeImages(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const images = [];
    for (const item of raw) {
        if (typeof item !== "string") {
            continue;
        }
        const trimmed = item.trim();
        if (!trimmed) {
            continue;
        }
        if (images.indexOf(trimmed) === -1) {
            images.push(trimmed);
        }
        if (images.length >= 8) {
            break;
        }
    }
    return images;
}
// 把用户传入的 conversationId 规范化。
// 允许的输入：
// 1. 纯 conversation id，例如 9efa4714-38db-4038-a971-226570f7155d
// 2. 完整的会话 URL，例如 https://chat.deepseek.com/a/chat/s/<id>
// 对以下情况返回 null（表示按新会话处理）：
// - 空字符串
// - 是一个 URL 但无法提取出会话 id（例如新会话入口 https://chat.deepseek.com）
var DEEPSEEK_CID_PATTERN = new RegExp("/a/chat/s/([0-9a-fA-F-]+)");
var DEFAULT_CID_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");
function normalizeConversationId(provider, raw) {
    if (raw === undefined || raw === null) {
        return null;
    }
    const trimmed = String(raw).trim();
    if (!trimmed) {
        return null;
    }
    const looksLikeUrl =
        trimmed.indexOf("http://") === 0 ||
        trimmed.indexOf("https://") === 0 ||
        trimmed.indexOf("/") !== -1;
    if (!looksLikeUrl) {
        return trimmed;
    }
    if (provider === "deepseek") {
        const deepseekMatch = trimmed.match(DEEPSEEK_CID_PATTERN);
        return deepseekMatch ? deepseekMatch[1] : null;
    }
    const defaultMatch = trimmed.match(DEFAULT_CID_PATTERN);
    return defaultMatch ? defaultMatch[1] : null;
}
app.get("/api/workspace/browse", (req, res) => {
    const requestedPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!requestedPath && process.platform === "win32") {
        return res.json({
            path: "",
            displayPath: "This PC",
            parent: null,
            isRootList: true,
            entries: getWindowsDrives(),
        });
    }
    const targetPath = requestedPath ? path.resolve(requestedPath) : path.parse(process.cwd()).root;
    try {
        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) {
            return res.status(400).json({
                error: "Not a directory: " + targetPath,
            });
        }
        return res.json({
            path: targetPath,
            displayPath: targetPath,
            parent: path.dirname(targetPath) === targetPath ? null : path.dirname(targetPath),
            isRootList: false,
            entries: getDirectoryEntries(targetPath),
        });
    } catch (error) {
        return res.status(400).json({
            error: "Unable to browse path: " + error.message,
        });
    }
});
// 在当前浏览目录下新建文件夹，供 WorkspacePicker 的 "New Folder" 按钮使用。
app.post("/api/workspace/mkdir", (req, res) => {
    const parentPath = req.body && typeof req.body.path === "string" ? req.body.path.trim() : "";
    const folderName = req.body && typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!parentPath) {
        return res.status(400).json({
            error: "Parent path is required",
        });
    }
    if (!folderName) {
        return res.status(400).json({
            error: "Folder name is required",
        });
    }
    // 仅允许新建单层文件夹名，禁止路径分隔符与非法字符，避免越权创建。
    if (
        folderName === "." ||
        folderName === ".." ||
        folderName.indexOf("/") !== -1 ||
        folderName.indexOf(BACKSLASH) !== -1 ||
        /[:*?"<>|]/.test(folderName)
    ) {
        return res.status(400).json({
            error: "Invalid folder name: " + folderName,
        });
    }
    const resolvedParent = path.resolve(parentPath);
    try {
        const stat = fs.statSync(resolvedParent);
        if (!stat.isDirectory()) {
            return res.status(400).json({
                error: "Not a directory: " + resolvedParent,
            });
        }
    } catch (error) {
        return res.status(400).json({
            error: "Unable to access path: " + error.message,
        });
    }
    const targetPath = path.join(resolvedParent, folderName);
    if (fs.existsSync(targetPath)) {
        return res.status(409).json({
            error: "Folder already exists: " + folderName,
        });
    }
    try {
        fs.mkdirSync(targetPath);
        return res.json({
            message: "Folder created",
            name: folderName,
            path: targetPath,
            parent: resolvedParent,
        });
    } catch (error) {
        return res.status(500).json({
            error: "Unable to create folder: " + error.message,
        });
    }
});
// 会话存储占用统计：供前端显示数量/磁盘占用并提示用户清理。
app.get("/api/storage", (req, res) => {
    res.json(sessionManager.getStorageStats());
});
// 手动清理遗留的 .tmp 临时文件。
app.post("/api/storage/clean", (req, res) => {
    const cleanedBytes = sessionManager.cleanOrphanTmpFiles();
    return res.json({
        message: "Cleaned orphan temp files",
        cleanedBytes,
        stats: sessionManager.getStorageStats(),
    });
});
// ---- 浏览器设置与切换（Web 版）----
// 读取当前浏览器配置
app.get("/api/browser/settings", (req, res) => {
    res.json(browserSettings.readSettings());
});
// 写入浏览器配置
app.post("/api/browser/settings", (req, res) => {
    try {
        const saved = browserSettings.writeSettings(req.body || {});
        return res.json(saved);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});
// 探测指定浏览器的可执行文件
app.get("/api/browser/detect", (req, res) => {
    const type = typeof req.query.type === "string" ? req.query.type : "";
    const settings = browserSettings.readSettings();
    const targetType = type || settings.browserType;
    return res.json(browserSettings.detect(targetType));
});
// 浏览器 / CDP 状态
app.get("/api/browser/status", async (req, res) => {
    try {
        const status = await browserSettings.getStatus();
        return res.json(status);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});
// 启动当前所选浏览器的 CDP
app.post("/api/browser/launch", async (req, res) => {
    try {
        const settings = browserSettings.readSettings();
        const result = await browserSettings.ensureBrowserCdp(settings);
        return res.json(result);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});
// 切换浏览器：关闭旧浏览器并在独立端口启动目标浏览器
app.post("/api/browser/switch", async (req, res) => {
    try {
        const browserType =
            req.body && typeof req.body.browserType === "string" ? req.body.browserType : "";
        const result = await browserSettings.switchBrowser(browserType);
        return res.json(result);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});
// 新增：创建占位会话（New Session），不立即启动 Agent
app.post("/api/sessions/new", (req, res) => {
    const { workspace, provider = "chatgpt" } = req.body;
    if (!workspace) {
        return res.status(400).json({
            error: "Workspace is required",
        });
    }
    if (!fs.existsSync(workspace)) {
        return res.status(400).json({
            error: "Workspace does not exist: " + workspace,
        });
    }
    const capacity = sessionManager.checkCapacity();
    if (!capacity.ok) {
        return res.status(429).json({
            error: capacity.message,
            code: capacity.code,
            stats: capacity.stats,
        });
    }
    try {
        // 创建不带 task 的占位会话
        const session = sessionManager.create({
            workspace,
            provider,
            task: "", // 空任务，表示占位会话
            conversationId: null,
            images: [],
        });
        console.log("[WebUI] Placeholder session created: " + session.id);
        return res.json({
            message: "Placeholder session created",
            sessionId: session.id,
        });
    } catch (error) {
        console.error("[WebUI] Failed to create placeholder session:", error);
        return res.status(500).json({
            error: error.message,
        });
    }
});
app.post("/api/run", (req, res) => {
    const { workspace, provider, task, conversationId, images, sessionId } = req.body;
    if (!workspace || !task) {
        return res.status(400).json({
            error: "Workspace and task are required",
        });
    }
    if (!fs.existsSync(workspace)) {
        return res.status(400).json({
            error: "Workspace does not exist: " + workspace,
        });
    }
    const providerName = provider || "chatgpt";
    const cid = normalizeConversationId(providerName, conversationId);
    const imagePaths = normalizeImages(images);
    // 如果传入了 sessionId，尝试复用该占位会话
    let session = sessionId ? sessionManager.get(sessionId) : null;
    if (session) {
        // 更新占位会话的信息并启动
        session.workspace = workspace;
        session.provider = providerName;
        session.task = task;
        session.conversationId = cid;
        session.images = imagePaths;
        sessionManager.persist(session);
        try {
            session.start();
            console.log("[WebUI] Placeholder session started: " + session.id);
            return res.json({
                message: "Agent started in placeholder session",
                sessionId: session.id,
                conversationId: session.conversationId || null,
                reused: true,
            });
        } catch (startError) {
            console.error("[WebUI] Failed to start placeholder session:", startError);
            return res.status(500).json({
                error: startError.message,
            });
        }
    }
    // 如果没有 sessionId 或找不到对应会话，走原有逻辑创建新会话
    // 如果指定了 conversationId：
    // - 同一 provider + conversation 已有正在运行的 session：直接复用它。
    // - 已有已结束的 session：在同一个 session 内"继续一次新的运行"（resume），
    //   这样侧边栏不会新增会话，且该 session 的 history 会累积多次回复。
    // - 没有已存在的 session：创建新 session。
    if (cid) {
        const existing = sessionManager.findByConversation(providerName, cid);
        if (existing && existing.isRunning()) {
            return res.json({
                message: "Session already running for this conversation",
                sessionId: existing.id,
                conversationId: cid,
                reused: true,
            });
        }
        if (existing && typeof existing.resume === "function") {
            try {
                // 复用同一 session（同一 id），追加一次运行
                if (workspace && existing.workspace !== workspace) {
                    existing.workspace = workspace;
                }
                existing.provider = providerName;
                existing.conversationId = cid;
                existing.resume(task, imagePaths);
                sessionManager.persist(existing);
                console.log("[WebUI] Session resumed (reused): " + existing.id);
                return res.json({
                    message: "Agent resumed in existing session",
                    sessionId: existing.id,
                    conversationId: existing.conversationId || cid,
                    reused: true,
                    resumed: true,
                });
            } catch (resumeError) {
                console.error(
                    "[WebUI] Failed to resume session " + existing.id + ":",
                    resumeError.message
                );
                // 继续走新建流程
            }
        }
    }
    const capacity = sessionManager.checkCapacity();
    if (!capacity.ok) {
        console.warn("[WebUI] Session capacity exceeded:", capacity.code);
        return res.status(429).json({
            error: capacity.message,
            code: capacity.code,
            stats: capacity.stats,
        });
    }
    try {
        session = sessionManager.create({
            workspace,
            provider: providerName,
            task,
            conversationId: cid,
            images: imagePaths,
        });
        session.start();
        console.log("[WebUI] Session started: " + session.id);
        return res.json({
            message: "Agent started successfully",
            sessionId: session.id,
            conversationId: session.conversationId || null,
        });
    } catch (error) {
        if (session) {
            try {
                sessionManager.remove(session.id);
            } catch (removeError) {
                console.error(
                    "[WebUI] Failed to remove session " + session.id + ":",
                    removeError.message
                );
            }
        }
        console.error("[WebUI] Failed to start session:", error);
        const status = error.code === "MAX_SESSIONS" || error.code === "MAX_DISK" ? 429 : 500;
        return res.status(status).json({
            error: error.message,
            code: error.code || null,
        });
    }
});
app.get("/api/sessions/:id", (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    res.json(session.getInfo());
});
app.get("/api/sessions/:id/output", (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    res.json({
        running: session.isRunning(),
        output: session.getOutput(),
    });
});
app.get("/api/sessions/:id/events", (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    const NEWLINE = String.fromCharCode(10);
    const send = (eventName, data) => {
        if (res.writableEnded) return;
        res.write("event: " + eventName + NEWLINE);
        res.write("data: " + JSON.stringify(data) + NEWLINE + NEWLINE);
    };
    const sendOutput = (output) => send("output", output);
    const sendFinished = (info) => send("finished", info);
    const sendError = (error) => send("error", { message: error.message });
    const sendConversation = (info) => send("conversation", info);
    let replaying = true;
    const pendingOutputs = [];
    const handleOutput = (output) => {
        if (replaying) {
            pendingOutputs.push(output);
            return;
        }
        sendOutput(output);
    };
    session.on("output", handleOutput);
    session.on("finished", sendFinished);
    session.on("session.error", sendError);
    session.on("conversation", sendConversation);
    const existingOutput = session.getOutput();
    for (const output of existingOutput) {
        sendOutput(output);
    }
    replaying = false;
    for (const output of pendingOutputs) {
        sendOutput(output);
    }
    if (session.conversationId) {
        sendConversation({
            id: session.id,
            conversationId: session.conversationId,
        });
    }
    if (!session.isRunning()) {
        sendFinished(session.getInfo());
    }
    const heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        res.write(": heartbeat" + NEWLINE + NEWLINE);
    }, 15000);
    req.on("close", () => {
        clearInterval(heartbeat);
        session.removeListener("output", handleOutput);
        session.removeListener("finished", sendFinished);
        session.removeListener("session.error", sendError);
        session.removeListener("conversation", sendConversation);
    });
});
app.post("/api/sessions/:id/stop", async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    if (!session.isRunning()) {
        return res.status(400).json({ error: "Agent is not running" });
    }
    try {
        await sessionManager.stop(session.id);
        return res.json({
            message: "Agent stopped",
            sessionId: session.id,
        });
    } catch (error) {
        console.error("[WebUI] Failed to stop session " + session.id + ":", error.message);
        return res.status(500).json({ error: error.message });
    }
});
app.get("/api/sessions", (req, res) => {
    res.json({
        sessions: sessionManager.list().map((session) => session.getInfo()),
        storage: sessionManager.getStorageStats(),
    });
});
// 新增：按工作区分组列出所有会话
app.get("/api/workspaces", (req, res) => {
    res.json({
        workspaces: sessionManager.groupByWorkspace(),
        storage: sessionManager.getStorageStats(),
    });
});
app.delete("/api/sessions/:id", (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    try {
        sessionManager.remove(session.id);
        return res.json({
            message: "Session deleted",
            sessionId: session.id,
            storage: sessionManager.getStorageStats(),
        });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});
app.use("/api", (req, res) => {
    res.status(404).json({
        error: "API endpoint not found: " + req.method + " " + req.originalUrl,
    });
});
let server = null;
function startServer(options = {}) {
    if (server) {
        return server;
    }
    const port = Number(options.port) || DEFAULT_PORT;
    server = app.listen(port, "127.0.0.1", () => {
        console.log("[WebUI] Server running on localhost port " + port);
        console.log("[WebUI] Open your browser on http://localhost:" + port + "/xml_agent_web/");
    });
    return server;
}
async function shutdown() {
    console.log("[WebUI] Shutting down...");
    try {
        await sessionManager.stopAll();
    } catch (error) {
        console.error("[WebUI] Failed to stop sessions:", error.message);
    }
    if (!server) {
        return;
    }
    await new Promise((resolve) => {
        server.close(() => {
            server = null;
            resolve();
        });
    });
}
if (require.main === module) {
    startServer();
    process.on("SIGINT", async () => {
        await shutdown();
        process.exit(0);
    });
}
module.exports = {
    app,
    startServer,
    shutdown,
    sessionManager,
    normalizeConversationId,
    normalizeImages,
};
