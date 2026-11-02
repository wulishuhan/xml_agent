/**
会话相关接口（从 server.js 拆出）

POST   /api/sessions/new        创建占位会话（不启动 Agent）
POST   /api/run                 启动 / 复用 / 续跑一次 Agent 运行
GET    /api/sessions            会话列表（附带存储统计）
GET    /api/sessions/:id        单个会话信息
GET    /api/sessions/:id/output 当前输出（轮询兜底）
GET    /api/sessions/:id/events SSE 实时输出
POST   /api/sessions/:id/stop   停止运行
DELETE /api/sessions/:id        删除会话
GET    /api/workspaces          按工作区分组的会话
*/

const fs = require("fs");
const { normalizeConversationId, normalizeImages } = require("../request-input");

function registerSessionRoutes(app, deps = {}) {
    const sessionManager = deps.sessionManager;

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

    // 创建占位会话（New Session），不立即启动 Agent
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

    // 按工作区分组列出所有会话
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
}

module.exports = {
    registerSessionRoutes,
};
