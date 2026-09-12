/**

端到端测试：验证 conversationId 从 API 到 Session 的完整链路（不启动浏览器）。

目标：

使用 mock 的 AgentSession（不真正连接浏览器）启动 WebUI server

通过 HTTP 调用 POST /api/run，携带 conversationId

验证返回的 session 中包含该 conversationId

再次调用 POST /api/run 相同 provider + conversationId 时，应复用已有 session

不携带 conversationId 时，应创建新 session

GET /api/sessions 返回的列表中应包含 conversationId 字段

做法：

用 Module._resolveFilename 拦截 webui/session/session-manager.js 对 ./agent-session 的引用，

换成 mock AgentSession，让 server 不真正调用 Playwright。

使用 webui/server.js 导出的 app 与 sessionManager。

注意：

startServer 不接受 port=0，所以这里使用环境变量 PORT 指定一个固定但可能空闲的端口。

如果端口被占用会失败，因此直接使用一个高位端口（如 34567），并在启动失败时输出真实原因。
*/

const assert = require("assert");
const http = require("http");
const path = require("path");
const net = require("net");
const Module = require("module");

const projectRoot = path.join(__dirname, "..");

function installMockAgentSession() {
    const originalResolve = Module._resolveFilename;
    const mockPath = path.join(projectRoot, "mock_agent_session_e2e.js");

    const { EventEmitter } = require("events");

    let counter = 0;

    class MockAgentSession extends EventEmitter {
        constructor({ workspace, provider = "chatgpt", task, conversationId = null }) {
            super();

            counter += 1;

            this.id = "e2e-session-" + counter;
            this.workspace = workspace;
            this.provider = provider;
            this.task = task;
            this.conversationId = conversationId || null;
            this.status = "created";
            this.output = [];
        }

        start() {
            this.status = "running";

            setImmediate(() => {
                this.status = "completed";
                this.emit("finished", this.getInfo());
            });

            return this;
        }

        stop() {
            this.status = "stopped";
            return Promise.resolve(true);
        }

        isRunning() {
            return this.status === "running";
        }

        getOutput() {
            return this.output;
        }

        getInfo() {
            return {
                id: this.id,
                conversationId: this.conversationId,
                workspace: this.workspace,
                provider: this.provider,
                task: this.task,
                status: this.status,
                running: this.isRunning(),
                pid: null,
                exitCode: null,
                outputLength: this.output.length,
                createdAt: Date.now(),
                startedAt: null,
                finishedAt: null,
                error: null,
            };
        }
    }

    Module._resolveFilename = function (request, parent, isMain, options) {
        if (
            request === "./agent-session" &&
            parent &&
            typeof parent.filename === "string" &&
            parent.filename.endsWith(path.join("webui", "session", "session-manager.js"))
        ) {
            return mockPath;
        }

        return originalResolve.call(this, request, parent, isMain, options);
    };

    require.cache[mockPath] = {
        id: mockPath,
        filename: mockPath,
        loaded: true,
        exports: {
            AgentSession: MockAgentSession,
        },
    };

    return function restore() {
        Module._resolveFilename = originalResolve;
        delete require.cache[mockPath];
    };
}

function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();

        tester.once("error", () => resolve(false));
        tester.once("listening", () => tester.close(() => resolve(true)));

        tester.listen(port, "127.0.0.1");
    });
}

async function findFreePort(start = 32000, end = 32999) {
    for (let port = start; port <= end; port += 1) {
        // eslint-disable-next-line no-await-in-loop
        const free = await isPortFree(port);

        if (free) {
            return port;
        }
    }

    throw new Error("No free port found in range " + start + "-" + end);
}

function httpPostJson(url, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const urlObj = new URL(url);

        const req = http.request(
            {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                },
            },
            (res) => {
                let respBody = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => (respBody += chunk));
                res.on("end", () => {
                    let parsed = null;

                    try {
                        parsed = JSON.parse(respBody);
                    } catch (e) {
                        parsed = null;
                    }

                    resolve({
                        statusCode: res.statusCode,
                        body: respBody,
                        json: parsed,
                    });
                });
            }
        );

        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("request timeout")));
        req.write(data);
        req.end();
    });
}

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);

        const req = http.get(
            {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname,
            },
            (res) => {
                let respBody = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => (respBody += chunk));
                res.on("end", () => {
                    let parsed = null;

                    try {
                        parsed = JSON.parse(respBody);
                    } catch (e) {
                        parsed = null;
                    }

                    resolve({
                        statusCode: res.statusCode,
                        body: respBody,
                        json: parsed,
                    });
                });
            }
        );

        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("request timeout")));
    });
}

async function main() {
    const port = await findFreePort(32000, 32999);

    // webui/server.js 在 require 时会读取 process.env.PORT，
    // 通过环境变量传入我们选好的空闲端口，避免与用户正在运行的 webui 冲突。
    process.env.PORT = String(port);

    const restore = installMockAgentSession();

    let server;
    let sessionManager;

    try {
        const serverModule = require(path.join(projectRoot, "webui", "server.js"));

        sessionManager = serverModule.sessionManager;

        server = serverModule.startServer({ port });

        await new Promise((resolve, reject) => {
            if (server.listening) return resolve();
            server.once("listening", resolve);
            server.once("error", reject);
        });
    } finally {
        restore();
    }

    const actualPort = server.address().port;
    const base = "http://127.0.0.1:" + actualPort;

    const workspace = projectRoot;

    // 1. 携带 conversationId 创建 session
    const res1 = await httpPostJson(base + "/api/run", {
        workspace,
        provider: "deepseek",
        task: "e2e conv",
        conversationId: "conv-e2e-1",
    });

    assert.strictEqual(res1.statusCode, 200, "/api/run first should return 200");
    assert.ok(res1.json && res1.json.sessionId, "should return sessionId");

    const firstSessionId = res1.json.sessionId;
    const firstSession = sessionManager.get(firstSessionId);

    assert.ok(firstSession, "session should exist");
    assert.strictEqual(firstSession.conversationId, "conv-e2e-1", "session keeps conversationId");

    // 2. 再次携带相同 provider + conversationId，应复用已有 session
    const res2 = await httpPostJson(base + "/api/run", {
        workspace,
        provider: "deepseek",
        task: "e2e conv again",
        conversationId: "conv-e2e-1",
    });

    assert.strictEqual(res2.statusCode, 200, "/api/run second should return 200");
    assert.ok(res2.json && res2.json.reused === true, "second call should mark reused");
    assert.strictEqual(
        res2.json.sessionId,
        firstSessionId,
        "second call should reuse the same sessionId"
    );

    // 3. 不携带 conversationId，应创建新 session
    const res3 = await httpPostJson(base + "/api/run", {
        workspace,
        provider: "deepseek",
        task: "e2e no conv",
    });

    assert.strictEqual(res3.statusCode, 200, "/api/run without conversationId should return 200");
    assert.ok(res3.json && res3.json.sessionId, "should return a new sessionId");
    assert.notStrictEqual(res3.json.sessionId, firstSessionId, "should create a new session");

    const thirdSession = sessionManager.get(res3.json.sessionId);

    assert.ok(thirdSession, "third session should exist");
    assert.strictEqual(thirdSession.conversationId, null, "third session has no conversationId");

    // 4. GET /api/sessions 应包含 conversationId 字段
    const resList = await httpGetJson(base + "/api/sessions");

    assert.strictEqual(resList.statusCode, 200, "/api/sessions should return 200");
    assert.ok(resList.json && Array.isArray(resList.json.sessions), "should return sessions array");

    const found = resList.json.sessions.find((s) => s.id === firstSessionId);

    assert.ok(found, "first session should appear in list");
    assert.strictEqual(
        found.conversationId,
        "conv-e2e-1",
        "listed session should expose conversationId"
    );

    console.log("Conversation e2e test passed:");
    console.log(" - /api/run passes conversationId to session");
    console.log(" - same provider + conversationId reuses session");
    console.log(" - missing conversationId creates new session");
    console.log(" - /api/sessions exposes conversationId");

    await new Promise((resolve) => {
        server.close(() => resolve());
    });
}

main().catch(async (error) => {
    console.error("Conversation e2e test failed:", error.message);
    process.exitCode = 1;

    try {
        const serverModule = require(path.join(projectRoot, "webui", "server.js"));
        await serverModule.shutdown();
    } catch (e) {
        // ignore
    }
});
