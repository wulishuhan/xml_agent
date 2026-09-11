/**

验证 webui/server.js 的 startServer({ port }) 支持动态端口：

显式传入 port 时应监听该 port

不传时使用 DEFAULT_PORT（进程环境变量或 3000）

注意：当前机器 3000 已被占用，因此显式传入一个空闲端口进行验证。
*/

const net = require("net");
const assert = require("assert");
const path = require("path");
const http = require("http");

const projectRoot = path.join(__dirname, "..");
const server = require(path.join(projectRoot, "webui", "server.js"));

function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();

        tester.once("error", () => resolve(false));
        tester.once("listening", () => tester.close(() => resolve(true)));

        tester.listen(port, "127.0.0.1");
    });
}

async function findFreePort(start, end) {
    for (let port = start; port <= end; port += 1) {
        // eslint-disable-next-line no-await-in-loop
        const free = await isPortFree(port);

        if (free) {
            return port;
        }
    }

    throw new Error("No free port found");
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
    const chosen = await findFreePort(3100, 3199);
    const instance = server.startServer({ port: chosen });

    await new Promise((resolve, reject) => {
        if (instance.listening) return resolve();
        instance.once("listening", resolve);
        instance.once("error", reject);
    });

    const actualPort = instance.address().port;
    assert.strictEqual(actualPort, chosen, "server should listen on the requested port");

    const res = await httpGet("http://127.0.0.1:" + actualPort + "/api/sessions");
    assert.strictEqual(res.statusCode, 200, "/api/sessions should respond 200");

    const parsed = JSON.parse(res.body);
    assert.ok(Array.isArray(parsed.sessions), "should return sessions array");

    await server.shutdown();

    console.log("webui/server.js dynamic port test passed: listened on " + actualPort);
}

main().catch(async (error) => {
    console.error("webui/server.js dynamic port test failed:", error.message);
    try {
        await server.shutdown();
    } catch (e) {
        // ignore
    }
    process.exitCode = 1;
});
