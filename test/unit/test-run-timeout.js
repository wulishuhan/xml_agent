/**
整轮运行超时单测

背景：主循环原来只有 `step < maxSteps`（默认 100）一个出口。浏览器 provider
每步 13–20s，算下来单任务最坏能跑半小时以上，而 UI 上没有任何兜底——
既不会报错，也不会自己停。

这里钉住三件事：
1. 未设置上限（0）时永远不超时；
2. 超过墙钟上限后主循环退出，状态记为 timeout，而不是 completed；
3. 超时会发 agent.timeout 事件，前端/日志能看见原因。

运行：node test/unit/test-run-timeout.js
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Agent } = require("../../agent-core");

let pass = 0;
let total = 0;

async function check(name, fn) {
    total += 1;
    try {
        await fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

/** 只做最小契约的 provider：默认每步返回一个必然失败但不致命的 read。 */
function makeProvider(script = ['<read path="not-exist.txt"/>']) {
    let index = 0;

    return {
        name: "Fake",
        currentConversationId: null,
        async start() {},
        async close() {},
        async send() {
            const reply = script[Math.min(index, script.length - 1)];
            index += 1;

            return reply;
        },
    };
}

function makeAgent(options) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-timeout-"));

    return new Agent(
        Object.assign(
            {
                workspace,
                task: "timeout check",
                provider: "fake",
                createProvider: () => makeProvider(),
            },
            options
        )
    );
}

async function main() {
    await check("未设置上限时 isRunTimeoutExceeded 永远为 false", async () => {
        const agent = makeAgent({ runTimeoutMs: 0 });

        assert.strictEqual(agent.isRunTimeoutExceeded(Date.now() + 10 ** 9), false);
    });

    await check("默认上限来自配置（30 分钟）", async () => {
        const agent = makeAgent({});

        assert.strictEqual(agent.runTimeoutMs, 30 * 60 * 1000);
    });

    await check("超时后状态为 timeout 且不再继续跑", async () => {
        const agent = makeAgent({ runTimeoutMs: 1, maxSteps: 100 });
        const events = [];
        agent.on("event", (event) => events.push(event));

        const result = await agent.run();

        assert.strictEqual(result.status, "timeout");
        assert.strictEqual(agent.step, 1, "should stop right after the first step");
        assert.ok(
            events.some((event) => event.type === "agent.timeout"),
            "should emit agent.timeout"
        );
    });

    await check("未超时的普通运行仍以 completed 结束", async () => {
        const agent = makeAgent({
            runTimeoutMs: 60 * 1000,
            maxSteps: 5,
            createProvider: () => makeProvider(["<answer><![CDATA[ok]]></answer>", "<done/>"]),
        });

        const result = await agent.run();

        assert.strictEqual(result.status, "completed");
        assert.strictEqual(result.step, 2);
    });

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
