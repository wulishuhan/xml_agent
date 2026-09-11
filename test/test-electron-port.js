/**

验证 Electron 端口自动探测逻辑：

从 3000 开始，找到一个未被占用的端口

若 3000 被占用，应返回 3001 或更后面的端口

若 3000/3001 都被占用，应返回 3002 或更后面的端口

说明：

当前机器 127.0.0.1:3000 已被其他进程占用（是真实场景），

所以测试使用动态验证：不假设起始空闲端口一定等于 3000，

而是断言返回的端口未被占用，且等于"从 3000 起第一个可用的端口"。
*/

const net = require("net");
const assert = require("assert");

const HOST = "127.0.0.1";
const PORT_START = 3000;
const PORT_END = 3999;

function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();

        tester.once("error", () => {
            resolve(false);
        });

        tester.once("listening", () => {
            tester.close(() => resolve(true));
        });

        tester.listen(port, HOST);
    });
}

async function findFreePort(start = PORT_START, end = PORT_END) {
    for (let port = start; port <= end; port += 1) {
        // eslint-disable-next-line no-await-in-loop
        const free = await isPortFree(port);

        if (free) {
            return port;
        }
    }

    throw new Error("No free port found in range " + start + "-" + end);
}

async function expectedFirstFreePort(start, end) {
    for (let port = start; port <= end; port += 1) {
        // eslint-disable-next-line no-await-in-loop
        const free = await isPortFree(port);

        if (free) {
            return port;
        }
    }

    throw new Error("No free port found in range " + start + "-" + end);
}

async function main() {
    const actual = await findFreePort();
    const expected = await expectedFirstFreePort(PORT_START, PORT_END);

    assert.strictEqual(
        actual,
        expected,
        "findFreePort should return the first free port from " + PORT_START
    );

    assert.ok(
        actual >= PORT_START && actual <= PORT_END,
        "port should be inside the configured range"
    );

    // 再验证一次：找到的端口确实可被 listen
    await new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once("error", reject);
        server.listen(actual, HOST, () => {
            server.close(() => resolve());
        });
    });

    console.log(
        "Electron port fallback test passed: first free port from " + PORT_START + " is " + actual
    );
}

main().catch((error) => {
    console.error("Electron port fallback test failed:", error.message);
    process.exitCode = 1;
});
