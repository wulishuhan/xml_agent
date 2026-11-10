/**
WebUI 后端装配（bootstrap）

历史：这里曾是 650 行的单文件，包含会话 / 工作区 / 存储 / 浏览器 / Agent 配置的全部路由。
v1.1.0 起路由按领域拆到 webui/routes/：
    sessions.js      会话与运行（含 SSE）
    workspace.js     目录浏览与新建
    storage.js       会话存储统计与清理
    browser.js       浏览器设置与 CDP 切换
    agent-config.js  agent / runtime / session 运行参数
    plugins.js       插件管理与插件自定义接口
    skills.js        技能（Skill）列表、文档读取与安装
    providers.js     provider 列表
    upload-api.js    用户附件上传（前端在用）

注意：截图没有 HTTP 入口。它是 screenshot 插件的 XML 动作，由模型调用，
引擎实现随插件放在 plugins/builtin/screenshot/engine/，核心不参与。

本文件只负责：启动顺序（会话恢复 → 配置应用 → 插件加载）、静态资源、
路由注册顺序、HTTP 服务生命周期。新增接口请加到对应的 routes/*.js。
*/

const express = require("express");
const path = require("path");

const { SessionManager } = require("./session/session-manager");
const browserSettings = require("./browser-settings");
const agentConfigApi = require("./agent-config-api");
const { normalizeImages, normalizeConversationId } = require("./request-input");
const { registerUploadRoutes } = require("./upload-api");
const { registerSessionRoutes } = require("./routes/sessions");
const { cleanupAllSync } = require("../processes/registry");
const { registerWorkspaceRoutes } = require("./routes/workspace");
const { registerStorageRoutes } = require("./routes/storage");
const { registerBrowserRoutes } = require("./routes/browser");
const { registerAgentConfigRoutes } = require("./routes/agent-config");
const { registerPluginRoutes } = require("./routes/plugins");
const { registerSkillRoutes } = require("./routes/skills");
const { registerProviderRoutes } = require("./routes/providers");
const { getRegistry } = require("../plugins/registry");

const app = express();

/**
进程级兜底：provider / 插件里任何没被 await 的 Promise 拒绝，在 Node 15+ 的默认语义下
会直接结束进程（WebUI 变成打不开的页面）。这里只记录不退出——
单次拒绝通常是某条会话失败，不该带走整个服务。
（uncaughtException 不在这里吞：同步状态可能已损坏。）
*/
process.on("unhandledRejection", (reason) => {
    const detail = reason && reason.stack ? reason.stack : String(reason);
    console.error("[webui] unhandled rejection:", detail);
});
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const sessionManager = new SessionManager();

// ------------------------------------------------------------
// 启动顺序：会话恢复 → 浏览器设置 → Agent 配置 → 插件
// 每一步失败都只记录日志，不影响服务起来。
// ------------------------------------------------------------

// 从用户主目录恢复上次的会话，避免重启后 WebUI 变成空会话。
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

// 把已保存的浏览器设置同步到运行环境，确保 Agent 使用所选浏览器。
try {
    browserSettings.applyToRuntime(browserSettings.readSettings());
} catch (error) {
    console.warn("[WebUI] Failed to apply browser settings to runtime:", error.message);
}

// 把已保存的 Agent 配置同步到运行环境
try {
    const savedAgentConfig = agentConfigApi.readAgentConfig();
    agentConfigApi.applyToRuntime(savedAgentConfig);
} catch (error) {
    console.warn("[WebUI] Failed to apply agent config to runtime:", error.message);
}

// 加载插件（失败只记录，不影响服务启动）
try {
    const registry = getRegistry();
    const failed = registry.errors.length;
    console.log(
        "[WebUI] Plugins: " +
            (registry.enabled ? "enabled" : "disabled") +
            " / loaded " +
            registry.listLoaded().length +
            " / actions " +
            registry.actions.size +
            (failed > 0 ? " / failed " + failed : "")
    );
} catch (error) {
    console.warn("[WebUI] Failed to load plugins:", error.message);
}

// ------------------------------------------------------------
// 路由注册（顺序与拆分前一致）
// ------------------------------------------------------------

const frontendDistPath = path.join(__dirname, "frontend", "dist");

app.use(express.json());

// 用户附件上传（Web 版与桌面版共用同一份本地 Node 实现）。
registerUploadRoutes(app);
// 插件管理 + 插件自定义接口；技能文档；provider 列表。
registerPluginRoutes(app);
// 技能：扫描/读取/安装到工作区。纯只读文件操作，不依赖插件系统。
registerSkillRoutes(app);
registerProviderRoutes(app);

// 前端静态资源
app.use(express.static(frontendDistPath));
app.get("/xml_agent_web", (req, res) => {
    res.sendFile(path.join(frontendDistPath, "index.html"));
});

// 业务路由
registerWorkspaceRoutes(app);
registerStorageRoutes(app, { sessionManager });
registerBrowserRoutes(app);
registerAgentConfigRoutes(app);
registerSessionRoutes(app, { sessionManager });

// API 兜底 404（必须放在所有 /api 路由之后）
app.use("/api", (req, res) => {
    res.status(404).json({
        error: "API endpoint not found: " + req.method + " " + req.originalUrl,
    });
});

/**
请求体解析失败（坏 JSON / 体积超限）时，Express 默认回一页 HTML 错误页，
页面上带着完整堆栈与本机绝对路径。前端拿到的不是 JSON，用户看到一屏堆栈
也无从判断，同时把服务端目录结构暴露给了浏览器。
*/
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
    if (res.headersSent) {
        return next(error);
    }
    if (error && error.type === "entity.parse.failed") {
        return res.status(400).json({
            error: "Malformed JSON request body",
            code: "BODY_PARSE_FAILED",
        });
    }
    const status = Number(error && (error.status || error.statusCode));
    if (status === 413) {
        return res.status(413).json({
            error: "Request body too large",
            code: "BODY_TOO_LARGE",
        });
    }
    console.error("[WebUI] Unhandled request error:", error && error.message);
    return res.status(500).json({ error: "Internal server error" });
});

// ------------------------------------------------------------
// HTTP 服务生命周期
// ------------------------------------------------------------

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
    // SIGTERM（kill / 进程管理器停止）与 SIGHUP（终端关闭）原来没接，
    // 这两种情况下会话不会被 stopAll()，后台命令会留成孤儿。
    let shuttingDownBySignal = false;
    const handleSignal = async () => {
        if (shuttingDownBySignal) {
            return;
        }
        shuttingDownBySignal = true;
        await shutdown();
        // 信号路径不会触发 process 的 exit 事件，走不到 registry 的退出兜底，
        // 因此这里同步收一次：shutdown 里 stopAll 抛错时也能保证进程不残留。
        cleanupAllSync("signal");
        process.exit(0);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, handleSignal);
    }
}

module.exports = {
    app,
    startServer,
    shutdown,
    sessionManager,
    // 兼容既有调用方与测试：这两个归一化仍在 server 上导出
    normalizeConversationId,
    normalizeImages,
};
