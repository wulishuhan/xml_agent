const express = require("express");
const path = require("path");
const fs = require("fs");
const { SessionManager } = require("./session/session-manager");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const sessionManager = new SessionManager();

app.use(express.json());
app.use(express.static(path.join(__dirname, "frontend", "dist")));

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

app.get("/api/workspace/browse", (req, res) => {
    const requestedPath =
        typeof req.query.path === "string" && req.query.path.trim()
            ? req.query.path.trim()
            : path.parse(process.cwd()).root;

    let targetPath;
    try {
        targetPath = path.resolve(requestedPath);
    } catch (error) {
        return res.status(400).json({
            error: "Invalid path: " + error.message,
        });
    }

    try {
        const stat = fs.statSync(targetPath);

        if (!stat.isDirectory()) {
            return res.status(400).json({
                error: "Not a directory: " + targetPath,
            });
        }

        const entries = fs
            .readdirSync(targetPath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({
                name: entry.name,
                path: path.join(targetPath, entry.name),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        return res.json({
            path: targetPath,
            parent: path.dirname(targetPath) === targetPath ? null : path.dirname(targetPath),
            entries,
        });
    } catch (error) {
        return res.status(400).json({
            error: "Unable to browse path: " + error.message,
        });
    }
});

app.post("/api/run", (req, res) => {
    const { workspace, provider, task } = req.body;

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

    let session;

    try {
        session = sessionManager.create({
            workspace,
            provider: provider || "chatgpt",
            task,
        });

        session.start();

        console.log("[WebUI] Session started: " + session.id);

        return res.json({
            message: "Agent started successfully",
            sessionId: session.id,
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

        return res.status(500).json({
            error: error.message,
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

    const send = (eventName, data) => {
        if (res.writableEnded) return;

        res.write("event: " + eventName + "\n");
        res.write("data: " + JSON.stringify(data) + "\n\n");
    };

    const sendOutput = (output) => send("output", output);
    const sendFinished = (info) => send("finished", info);
    const sendError = (error) => send("error", { message: error.message });

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

    const existingOutput = session.getOutput();

    for (const output of existingOutput) {
        sendOutput(output);
    }

    replaying = false;

    for (const output of pendingOutputs) {
        sendOutput(output);
    }

    if (!session.isRunning()) {
        sendFinished(session.getInfo());
    }

    const heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        res.write(": heartbeat\n\n");
    }, 15000);

    req.on("close", () => {
        clearInterval(heartbeat);
        session.removeListener("output", handleOutput);
        session.removeListener("finished", sendFinished);
        session.removeListener("session.error", sendError);
    });
});

app.post("/api/sessions/:id/stop", async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    if (!session.isRunning()) {
        return res.status(400).json({
            error: "Agent is not running",
        });
    }

    try {
        await sessionManager.stop(session.id);

        return res.json({
            message: "Agent stopped",
            sessionId: session.id,
        });
    } catch (error) {
        console.error("[WebUI] Failed to stop session " + session.id + ":", error.message);

        return res.status(500).json({
            error: error.message,
        });
    }
});

app.get("/api/sessions", (req, res) => {
    res.json({
        sessions: sessionManager.list().map((session) => session.getInfo()),
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
        });
    } catch (error) {
        return res.status(400).json({
            error: error.message,
        });
    }
});

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "API endpoint not found: " + req.method + " " + req.originalUrl,
    });
});

// app.get("*", (req, res) => {
//     res.sendFile(path.join(__dirname, "frontend", "dist", "index.html"));
// });

let server = null;

function startServer() {
    if (server) {
        return server;
    }

    server = app.listen(PORT, "127.0.0.1", () => {
        console.log("[WebUI] Server running on localhost port " + PORT);
        console.log("[WebUI] Open your browser on localhost port " + PORT);
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
};
