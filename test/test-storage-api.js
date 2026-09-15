/**
存储统计 API 测试：启动内置服务，验证 /api/storage 与 /api/sessions 返回结构。
用随机端口避免与其它测试冲突，测完立即关闭。
*/

const http = require("http");
const path = require("path");

process.env.PORT = "34590";

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
            res.on("end", () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    });
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function main() {
    const instance = server.startServer();

    await new Promise((resolve, reject) => {
        if (instance.listening) return resolve();
        instance.once("listening", resolve);
        instance.once("error", reject);
    });

    const base = "http://127.0.0.1:" + instance.address().port;

    const storage = await httpGet(base + "/api/storage");
    assert(storage.statusCode === 200, "/api/storage 应返回 200");
    const storageData = JSON.parse(storage.body);
    assert(typeof storageData.sessions === "number", "storage.sessions 应为数字");
    assert(typeof storageData.maxSessions === "number", "storage.maxSessions 应为数字");
    assert(typeof storageData.bytes === "number", "storage.bytes 应为数字");
    assert(typeof storageData.maxDiskBytes === "number", "storage.maxDiskBytes 应为数字");
    assert(typeof storageData.ratio === "number", "storage.ratio 应为数字");
    assert(typeof storageData.root === "string", "storage.root 应为字符串");

    const sessions = await httpGet(base + "/api/sessions");
    assert(sessions.statusCode === 200, "/api/sessions 应返回 200");
    const sessionsData = JSON.parse(sessions.body);
    assert(Array.isArray(sessionsData.sessions), "sessions 应为数组");
    assert(sessionsData.storage, "/api/sessions 应附带 storage 统计");

    await server.shutdown();

    console.log("Storage API test passed:");
    console.log(" - /api/storage 返回统计结构");
    console.log(" - /api/sessions 附带 storage");
}

main().catch(async (error) => {
    console.error("Storage API test failed:", error.message);
    try {
        await server.shutdown();
    } catch (e) {
        // ignore
    }
    process.exitCode = 1;
});
