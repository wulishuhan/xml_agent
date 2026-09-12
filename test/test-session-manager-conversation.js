/**

测试 SessionManager 的 conversationId 相关能力：

create 时可以指定 conversationId，并透传给 AgentSession

findByConversation 可以按 provider + conversationId 找到已有 session

没有匹配时返回 null

为了避免真正启动浏览器，这里用 monkey patch 的方式替换 SessionManager

内部的 AgentSession 构造函数，使用一个假的 Session。
*/

const assert = require("assert");
const path = require("path");
const Module = require("module");

const projectRoot = path.join(__dirname, "..");

function installMockAgentSession() {
    const originalResolve = Module._resolveFilename;
    const mockPath = path.join(projectRoot, "mock_agent_session.js");

    const { EventEmitter } = require("events");

    let counter = 0;

    class MockAgentSession extends EventEmitter {
        constructor({ workspace, provider = "chatgpt", task, conversationId = null }) {
            super();

            counter += 1;

            this.id = "mock-session-" + counter;
            this.workspace = workspace;
            this.provider = provider;
            this.task = task;
            this.conversationId = conversationId || null;
            this.status = "created";
            this.output = [];
        }

        start() {
            this.status = "running";
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

function main() {
    const restore = installMockAgentSession();

    let SessionManager;

    try {
        // eslint-disable-next-line global-require
        ({ SessionManager } = require(
            path.join(projectRoot, "webui", "session", "session-manager.js")
        ));
    } finally {
        restore();
    }

    assert.ok(SessionManager, "SessionManager should load with MockAgentSession");

    const manager = new SessionManager();

    // 1. create 时透传 conversationId
    const a = manager.create({
        workspace: "/tmp/ws",
        provider: "deepseek",
        task: "hello",
        conversationId: "conv-a",
    });

    assert.strictEqual(
        a.conversationId,
        "conv-a",
        "session should keep conversationId from create"
    );

    // 2. findByConversation 命中
    const found = manager.findByConversation("deepseek", "conv-a");

    assert.strictEqual(found, a, "findByConversation should return existing session");

    // 3. 未命中
    const notFound = manager.findByConversation("chatgpt", "conv-a");

    assert.strictEqual(notFound, null, "findByConversation should return null when no match");

    // 4. 无 conversationId 的 session 不参与查找
    const b = manager.create({
        workspace: "/tmp/ws",
        provider: "deepseek",
        task: "hello",
    });

    assert.strictEqual(b.conversationId, null, "session should default conversationId to null");

    const byNull = manager.findByConversation("deepseek", null);

    assert.strictEqual(byNull, null, "findByConversation should ignore null conversationId");

    // 5. get 能取到 session
    assert.strictEqual(manager.get(a.id), a, "get should return session by id");

    console.log("SessionManager conversationId test passed:");
    console.log(" - create passes conversationId to session");
    console.log(" - findByConversation finds existing session");
    console.log(" - findByConversation returns null when no match");
    console.log(" - session without conversationId is ignored by findByConversation");
}

try {
    main();
} catch (error) {
    console.error("SessionManager conversationId test failed:", error.message);
    process.exitCode = 1;
}
