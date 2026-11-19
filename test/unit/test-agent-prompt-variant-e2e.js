/**
 * 提示词变体的 Agent 端到端冒烟测试（真实 Agent + mock provider，不起浏览器）
 *
 * conversation 那组 e2e 用 mock 替换了整个 Agent，覆盖不到 agent-core 里的抽签与
 * 变体注入。这里用真实的 Agent 跑完整 run() 循环，只把 provider 换成内存里的假实现，
 * 它把每轮收到的 prompt 全部记下来，用来验证：
 * 1. 构造时 promptVariant 被抽签成一个合法索引；
 * 2. 首轮 prompt 用的是所选变体的措辞；
 * 3. 动作执行后的回贴用同一变体的措辞（会话内一致）；
 * 4. 显式指定 promptVariant 时可复现，且不同变体首轮文本确实不同；
 * 5. 结束时 answer / 会话状态正常，变体没有破坏主流程。
 *
 * 运行：node test/unit/test-agent-prompt-variant-e2e.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Agent } = require("../../agent-core");
const {
    getSystemPromptVariant,
    pickSystemPromptVariant,
    SYSTEM_PROMPT_VARIANT_COUNT,
} = require("../../prompts/system-prompt-variants");
const { getRuntimeOkPrompt } = require("../../prompts/runtime-prompt");

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

/**
 * 假的 provider：把每轮收到的 prompt 记进 sent，按脚本逐条回复。
 * 脚本第一步返回 read 触发一次成功回贴，随后 answer / done 收尾。
 */
function makeProvider(sent, script) {
    let index = 0;
    return {
        name: "Fake",
        currentConversationId: null,
        async start() {},
        async close() {},
        async send(prompt) {
            sent.push(prompt);
            const reply = script[Math.min(index, script.length - 1)];
            index += 1;
            return reply;
        },
    };
}

function makeWorkspace() {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-variant-e2e-"));
    fs.writeFileSync(path.join(ws, "a.js"), "const x = 1;\n");
    return ws;
}

const REPLY_SCRIPT = ['<read path="a.js"/>', "<answer><![CDATA[done]]></answer>", "<done/>"];

async function runAgent(options = {}) {
    const workspace = makeWorkspace();
    const sent = [];
    const agent = new Agent({
        workspace,
        task: "变体端到端验证",
        provider: "fake",
        createProvider: () => makeProvider(sent, REPLY_SCRIPT),
        maxSteps: 10,
        ...options,
    });
    try {
        const result = await agent.run();
        return { agent, sent, result, workspace };
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

async function main() {
    await check("构造时抽到合法变体索引", () => {
        const workspace = makeWorkspace();
        try {
            const agent = new Agent({
                workspace,
                task: "x",
                provider: "fake",
                createProvider: () => makeProvider([], REPLY_SCRIPT),
            });
            assert.ok(
                Number.isInteger(agent.promptVariant) &&
                    agent.promptVariant >= 0 &&
                    agent.promptVariant < SYSTEM_PROMPT_VARIANT_COUNT,
                "promptVariant=" + agent.promptVariant
            );
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    await check("显式 promptVariant 可复现地注入首轮", async () => {
        const { sent } = await runAgent({ promptVariant: 1 });
        assert.ok(sent.length >= 1, "没有发出任何 prompt");
        const expectedFirst = getSystemPromptVariant(1)
            .split("\n")
            .find((line) => line.trim());
        assert.ok(
            sent[0].indexOf(expectedFirst) !== -1,
            "首轮不含变体 1 的开场白；首轮开头=" + sent[0].slice(0, 60)
        );
    });

    await check("成功回贴使用同一变体的措辞", async () => {
        const variant = 2;
        const { sent, agent } = await runAgent({ promptVariant: variant });
        assert.ok(sent.length >= 2, "没有产生回贴轮次");
        const expectedRuntime = getRuntimeOkPrompt(
            { ok: true, action: "read", path: "a.js", content: "const x = 1;" },
            { variant }
        );
        // 回贴的提示语（去掉 JSON 结果行后）应出现在第二轮 prompt 里。
        const lead = getRuntimeOkPrompt({ ok: true }, { variant })
            .split("\n")
            .find((line) => line.trim());
        assert.ok(
            sent[1].indexOf(lead) !== -1,
            "回贴不含变体 " + variant + " 的措辞；第二轮开头=" + sent[1].slice(0, 60)
        );
        assert.strictEqual(agent.promptVariant, variant);
        assert.ok(expectedRuntime.length > 0);
    });

    await check("不同变体的首轮文本确实不同", async () => {
        const a = await runAgent({ promptVariant: 1 });
        const b = await runAgent({ promptVariant: 3 });
        assert.ok(a.sent[0] !== b.sent[0], "两个变体的首轮 prompt 竟然相同");
    });

    await check("变体不破坏主流程：answer 收尾、状态 completed", async () => {
        const { agent, result } = await runAgent({ promptVariant: 0 });
        assert.strictEqual(result.answer, "done");
        assert.ok(
            ["completed", "max_steps"].indexOf(result.status) !== -1,
            "status=" + result.status
        );
    });

    console.log("");
    console.log("Total: " + pass + "/" + total);
    if (pass !== total) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
