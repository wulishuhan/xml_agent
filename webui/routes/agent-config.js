/**
Agent 运行参数配置接口（从 server.js 拆出）

GET  /api/agent/config  读取 agent / runtime / session 三段运行参数
POST /api/agent/config  写入并即时生效（校验由 config/schema.js 负责）

浏览器设置走 /api/browser/*，插件配置走 /api/plugins/:name/config，互不重叠。
*/

const agentConfigApi = require("../agent-config-api");

function registerAgentConfigRoutes(app) {
    app.get("/api/agent/config", (req, res) => {
        res.json(agentConfigApi.readAgentConfig());
    });

    app.post("/api/agent/config", (req, res) => {
        try {
            const saved = agentConfigApi.writeAgentConfig(req.body || {});
            return res.json(saved);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });
}

module.exports = {
    registerAgentConfigRoutes,
};
