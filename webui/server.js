const express = require("express");
const path = require("path");
const fs = require("fs");
const { SessionManager } = require("./session/session-manager");
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

const frontendDistPath = path.join(__dirname, "frontend", "dist");
const BACKSLASH = String.fromCharCode(92);
app.use(express.json());
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

app.post("/api/run", (req, res) => {
    const { workspace, provider, task, conversationId } = req.body;
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

    // 如果指定了 conversationId，优先复用同一 provider 下相同会话 id 且仍在运行的 session。
    // 若已有 session 已结束，则删除它并创建新的 session 继续该会话，
    // 否则用户无法在同一个 conversation 上继续执行新任务。
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

        if (existing) {
            try {
                sessionManager.remove(existing.id);
            } catch (removeError) {
                console.error(
                    "[WebUI] Failed to remove finished session " + existing.id + ":",
                    removeError.message
                );
            }
        }
    }

    // 复用已结束会话时上面的 remove 会释放名额，因此这里再检查一次容量。
    const capacity = sessionManager.checkCapacity();

    if (!capacity.ok) {
        console.warn("[WebUI] Session capacity exceeded:", capacity.code);

        return res.status(429).json({
            error: capacity.message,
            code: capacity.code,
            stats: capacity.stats,
        });
    }

    let session;

    try {
        session = sessionManager.create({
            workspace,
            provider: providerName,
            task,
            conversationId: cid,
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

        // 容量类错误用 429，其余用 500
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

    // 如果 session 已经关联了 conversationId，补发给前端，避免错过事件
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
};
