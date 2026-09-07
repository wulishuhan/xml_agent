const express = require("express");
const path = require("path");
const fs = require("fs");
const { AgentSession } = require("./session/agent-session");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "frontend", "dist")));

/**
 * 所有 Agent Session
 *
 * Map:
 * sessionId -> AgentSession
 */
const sessions = new Map();

/**
 * 创建 Agent Session
 */
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

  /**
   * 创建 Session
   */
  const session = new AgentSession({
    workspace,
    provider: provider || "chatgpt",
    task,
  });

  /**
   * 保存 Session
   */
  sessions.set(session.id, session);

  /**
   * 启动 Agent
   */
  try {
    session.start();

    console.log(`[WebUI] Session started: ${session.id}`);

    res.json({
      message: "Agent started successfully",
      sessionId: session.id,
    });
  } catch (error) {
    sessions.delete(session.id);

    console.error(`[WebUI] Failed to start session ${session.id}:`, error);

    res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * 获取 Session 状态
 */
app.get("/api/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    return res.status(404).json({
      error: "Session not found",
    });
  }

  res.json(session.getInfo());
});

/**
 * 获取 Session 输出
 */
app.get("/api/sessions/:id/output", (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    return res.status(404).json({
      error: "Session not found",
    });
  }

  res.json({
    running: session.isRunning(),
    output: session.getOutput(),
  });
});

/**
 * 停止 Agent
 */
app.post("/api/sessions/:id/stop", (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    return res.status(404).json({
      error: "Session not found",
    });
  }

  if (!session.isRunning()) {
    return res.status(400).json({
      error: "Agent is not running",
    });
  }

  try {
    session.stop();

    res.json({
      message: "Agent stopped",
      sessionId: session.id,
    });
  } catch (error) {
    console.error(`[WebUI] Failed to stop session ${session.id}:`, error);

    res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * 获取所有 Session
 *
 * 目前主要用于调试。
 * 后面 WebUI 做多任务管理时可以直接使用。
 */
app.get("/api/sessions", (req, res) => {
  const result = [];

  for (const session of sessions.values()) {
    result.push(session.getInfo());
  }

  res.json({
    sessions: result,
  });
});

/**
 * 删除已经结束的 Session
 */
app.delete("/api/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    return res.status(404).json({
      error: "Session not found",
    });
  }

  if (session.isRunning()) {
    return res.status(400).json({
      error: "Cannot delete a running session",
    });
  }

  sessions.delete(session.id);

  res.json({
    message: "Session deleted",
    sessionId: session.id,
  });
});

/**
 * Server
 */
const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`[WebUI] Server running at http://localhost:${PORT}`);

  console.log(`[WebUI] Open your browser to http://localhost:${PORT}`);
});

/**
 * 优雅退出
 */
process.on("SIGINT", () => {
  console.log("[WebUI] Shutting down...");

  /**
   * 停止所有正在运行的 Agent
   */
  for (const session of sessions.values()) {
    if (session.isRunning()) {
      try {
        session.stop();
      } catch (error) {
        console.error(`[WebUI] Failed to stop session ${session.id}:`, error.message);
      }
    }
  }

  server.close(() => {
    process.exit(0);
  });
});
