/**

测试 AgentSession 与 conversationId 的联动逻辑（不真正启动浏览器）：

构造 AgentSession 时可以指定 conversationId

收到 agent 的 provider.conversation 事件时，session.conversationId 会更新并 emit conversation

getInfo() 会返回 conversationId

Agent 传入 conversationId 时，会通过构造参数传递给 Session

本测试用 mock 的方式替换 Agent，避免依赖浏览器环境。
*/

const assert = require("assert");
const path = require("path");
const Module = require("module");

const projectRoot = path.join(__dirname, "..");

/**

在 require agent-session 之前，拦截对 ../../agent-core 的 require，

用我们的 MockAgent 替换真正的 Agent，从而让 Session 不真的连接浏览器。
*/
function installMockAgent() {
    const originalResolve = Module._resolveFilename;
    const originalLoad = Module._load;

    const mockPath = path.join(projectRoot, "mock_agent_core.js");

    class MockAgent {
        constructor(options = {}) {
            this.workspace = options.workspace;
            this.providerName = options.provider;
            this.task = options.task;
            this.conversationId = options.conversationId || null;
            this.currentConversationId = this.conversationId;
            this.status = "created";
            this.answer = null;
            this.error = null;
            this.step = 0;
            this.history = [];
            this.runtime = { getWorkspace: () => this.workspace };
            this.listeners = new Map();
        }

        on(event, handler) {
            if (!this.listeners.has(event)) {
                this.listeners.set(event, []);
            }

            this.listeners.get(event).push(handler);
            return this;
        }

        emit(event, payload) {
            const handlers = this.listeners.get(event) || [];

            for (const handler of handlers) {
                handler(payload);
            }

            return true;
        }

        async run() {
            this.status = "completed";

            // 模拟：Agent 在第一步发送后拿到了新的 conversationId
            const newConversationId = "mocked-conversation-id";

            this.currentConversationId = newConversationId;

            this.emit("event", {
                type: "provider.conversation",
                provider: this.providerName,
                conversationId: newConversationId,
            });

            this.emit("event", {
                type: "agent.completed",
                status: this.status,
                steps: 1,
                answer: "ok",
                conversationId: newConversationId,
            });

            return {
                status: this.status,
                workspace: this.workspace,
                provider: this.providerName,
                task: this.task,
                step: 1,
                answer: "ok",
                conversationId: newConversationId,
                error: null,
                history: this.history,
            };
        }

        async stop() {
            this.status = "stopped";
            return true;
        }
    }

    Module._resolveFilename = function (request, parent, isMain, options) {
        if (
            request === "../../agent-core" &&
            parent &&
            typeof parent.filename === "string" &&
            parent.filename.endsWith(path.join("webui", "session", "agent-session.js"))
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
            Agent: MockAgent,
        },
    };

    return function restore() {
        Module._resolveFilename = originalResolve;
        Module._load = originalLoad;
        delete require.cache[mockPath];
    };
}

async function main() {
    const restore = installMockAgent();

    let AgentSession;

    try {
        // eslint-disable-next-line global-require
        ({ AgentSession } = require(
            path.join(projectRoot, "webui", "session", "agent-session.js")
        ));
    } finally {
        restore();
    }

    assert.ok(AgentSession, "AgentSession should be loaded with MockAgent");

    // 1. 新建 session 时可以指定 conversationId
    const s1 = new AgentSession({
        workspace: "/tmp/ws",
        provider: "deepseek",
        task: "hello",
        conversationId: "abc-123",
    });

    assert.strictEqual(s1.conversationId, "abc-123", "Session should keep initial conversationId");

    // 2. 从 provider.conversation 事件同步
    const conversationEvents = [];
    s1.on("conversation", (info) => conversationEvents.push(info));

    s1.handleAgentEvent({
        type: "provider.conversation",
        provider: "deepseek",
        conversationId: "def-456",
    });

    assert.strictEqual(s1.conversationId, "def-456", "Session should update conversationId");
    assert.strictEqual(conversationEvents.length, 1, "should emit conversation event once");
    assert.strictEqual(conversationEvents[0].conversationId, "def-456");

    // 3. getInfo 包含 conversationId
    const info = s1.getInfo();

    assert.strictEqual(info.conversationId, "def-456", "getInfo should expose conversationId");

    // 4. 未指定 conversationId 的 session，初始应为 null
    const s2 = new AgentSession({
        workspace: "/tmp/ws",
        provider: "chatgpt",
        task: "hi",
    });

    assert.strictEqual(s2.conversationId, null, "Session should default conversationId to null");

    // 5. start 时把 conversationId 透传给 Agent，run 完成后回填
    s2.start();

    // 等待异步 run 完成
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(
        s2.conversationId,
        "mocked-conversation-id",
        "Session should receive conversationId from Agent run"
    );

    console.log("AgentSession conversationId test passed:");
    console.log(" - initial conversationId kept");
    console.log(" - provider.conversation event updates session");
    console.log(" - getInfo exposes conversationId");
    console.log(" - default conversationId is null");
    console.log(" - Agent run result syncs conversationId back to session");
}

main().catch((error) => {
    console.error("AgentSession conversationId test failed:", error.message);
    process.exitCode = 1;
});
