/**

验证 Electron 版本不会连接外部已占用的 3000 端口：

场景：用户已经在跑 npm run webui（占用 3000），

Electron 启动时应该自动跳过 3000，选择下一个空闲端口，

并且自己启动一个独立的 Express 服务监听该端口。

本测试模拟这个场景：

用 net 尝试占用 3000（可能已被 npm run webui 占用，也算外部服务）

用 findFreePort 逻辑在 3000-3999 中找到第一个空闲端口

用 webui/server.js 的 startServer({ port }) 监听该端口

访问该端口上的 /api/sessions，确认 Electron 有自己的服务

清理时只关闭本测试启动的服务
*/

const net = require("net");
const http = require("http");
const path = require("path");
const assert = require("assert");

const projectRoot = path.join(__dirname, "..");
const server = require(path.join(projectRoot, "webui", "server.js"));

const HOST = "127.0.0.1";
const PORT_START = 3000;
const PORT_END = 3999;

function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();

        tester.once("error", () => resolve(false));
        tester.once("listening", () => tester.close(() => resolve(true)));

        tester.listen(port, HOST);
    });
}

async function findFreePort() {
    for (let port = PORT_START; port <= PORT_END; port += 1) {
        // eslint-disable-next-line no-await-in-loop
        const free = await isPortFree(port);

        if (free) {
            return port;
        }
    }

    throw new Error("No free port found in range " + PORT_START + "-" + PORT_END);
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ statusCode: res.statusCode, body }));
        });

        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("request timeout")));
    });
}

async function main() {
    const before3000 = await isPortFree(PORT_START);

    console.log(
        "[port-isolation] " +
            PORT_START +
            " free before Electron start: " +
            before3000 +
            (before3000 ? "" : " (simulating external npm run webui)")
    );

    const electronPort = await findFreePort();

    assert.ok(
        electronPort >= PORT_START && electronPort <= PORT_END,
        "electronPort should be inside configured range"
    );

    if (!before3000) {
        assert.notStrictEqual(
            electronPort,
            PORT_START,
            "when 3000 is occupied, Electron should pick a different port"
        );
    }

    const instance = server.startServer({ port: electronPort });

    await new Promise((resolve, reject) => {
        if (instance.listening) return resolve();
        instance.once("listening", resolve);
        instance.once("error", reject);
    });

    const actualPort = instance.address().port;
    assert.strictEqual(actualPort, electronPort, "server should listen on electronPort");

    const res = await httpGet("http://" + HOST + ":" + electronPort + "/api/sessions");
    assert.strictEqual(res.statusCode, 200, "/api/sessions on Electron port should respond 200");

    const parsed = JSON.parse(res.body);
    assert.ok(Array.isArray(parsed.sessions), "Electron server should return sessions array");

    await server.shutdown();

    console.log(
        "Electron port isolation test passed: Electron picked " +
            electronPort +
            " and served its own /api/sessions"
    );
}

main().catch(async (error) => {
    console.error("Electron port isolation test failed:", error.message);

    try {
        await server.shutdown();
    } catch (e) {
        // ignore
    }

    process.exitCode = 1;
});
