/**

Electron 冒烟测试（不打开窗口，只验证主进程能否启动内置 Express 服务）

说明：

直接运行 electron/main.js 需要 Electron GUI 环境，CI/命令行下容易挂起。

这里我们改为验证 “等价逻辑”：用 Node 启动 webui/server.js，

再访问 /xml_agent_web 和 /api/sessions，确认 Electron 依赖的能力可用。

这能证明 electron/main.js 依赖的 startServer/shutdown 可正常工作。
*/

const http = require("http");
const path = require("path");

process.env.PORT = "34567";

const projectRoot = path.join(__dirname, "..");
const server = require(path.join(projectRoot, "webui", "server.js"));

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => {
                resolve({ statusCode: res.statusCode, body });
            });
        });
        req.on("error", reject);
        req.setTimeout(5000, () => {
            req.destroy(new Error("request timeout: " + url));
        });
    });
}

async function main() {
    const instance = server.startServer();

    await new Promise((resolve, reject) => {
        if (instance.listening) return resolve();
        instance.once("listening", resolve);
        instance.once("error", reject);
    });

    const base = "http://127.0.0.1:" + instance.address().port;

    const page = await httpGet(base + "/xml_agent_web");
    if (page.statusCode !== 200) {
        throw new Error("/xml_agent_web expected 200 but got " + page.statusCode);
    }
    if (page.body.indexOf('<div id="app"></div>') === -1) {
        throw new Error("/xml_agent_web did not return the Vue entry html");
    }

    const sessions = await httpGet(base + "/api/sessions");
    if (sessions.statusCode !== 200) {
        throw new Error("/api/sessions expected 200 but got " + sessions.statusCode);
    }
    const parsed = JSON.parse(sessions.body);
    if (!Array.isArray(parsed.sessions)) {
        throw new Error("/api/sessions did not return { sessions: [] }");
    }

    await server.shutdown();

    console.log("Electron smoke test passed:");
    console.log(" - /xml_agent_web reachable and serves Vue entry");
    console.log(" - /api/sessions reachable and returns sessions array");
    console.log(" - startServer/shutdown work as expected");
}

main().catch(async (error) => {
    console.error("Electron smoke test failed:", error.message);
    try {
        await server.shutdown();
    } catch (e) {
        // ignore
    }
    process.exitCode = 1;
});
