/**
浏览器设置与切换接口（Web 版，从 server.js 拆出）

GET  /api/browser/settings  读取浏览器配置
POST /api/browser/settings  保存浏览器配置（保存即生效）
GET  /api/browser/detect    探测指定浏览器的可执行文件
GET  /api/browser/status    浏览器 / CDP 状态（含 typeMatches）
POST /api/browser/launch    启动当前所选浏览器的 CDP
POST /api/browser/switch    切换浏览器（关闭旧的、在独立端口启动新的）
*/

const browserSettings = require("../browser-settings");

function registerBrowserRoutes(app) {
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
}

module.exports = {
    registerBrowserRoutes,
};
