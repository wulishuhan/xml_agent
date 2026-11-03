/**
单步执行（agent/step.js）单测

用假 Agent 驱动，不碰浏览器、不碰真实 runtime：
覆盖「正常一轮 / 终止语义 / 发送失败重试 / 解析失败 / 动作失败」五条出口，
这五条正是 run() 主循环唯一需要区分的分支。
*/

const { runStep } = require("../../agent/step");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

/** 假 Agent：只实现 step.js 文档里约定的字段。 */
function makeAgent(overrides = {}) {
    const events = [];
    const agent = {
        step: 1,
        status: "running",
        stopRequested: false,
        answer: null,
        history: [],
        events,
        emitEvent(type, data = {}) {
            events.push({ type, data });
        },
        syncConversationId() {
            return null;
        },
        async uploadArtifacts(result) {
            return result;
        },
        resolveActionDefinition(name) {
            if (name === "answer") {
                return { meta: { terminal: "answer" } };
            }
            if (name === "done") {
                return { meta: { terminal: "end" } };
            }
            return { meta: { terminal: null } };
        },
        runtime: {
            async run() {
                return { ok: true, action: "read", content: "hello" };
            },
        },
        provider: {
            async send() {
                return '<read path="a.txt"/>';
            },
        },
        ...overrides,
    };
    return agent;
}

async function main() {
    // ------------------------------------------------------------
    // 1. 正常一轮：解析成功 → 执行成功 → 准备下一轮提示词
    // ------------------------------------------------------------
    {
        const agent = makeAgent();
        const result = await runStep(agent, {
            prompt: "PROMPT",
            providerErrorState: { count: 0, max: 3 },
        });

        check("正常一轮不终止", result.stop === false);
        check(
            "正常一轮给出下一轮提示词",
            typeof result.prompt === "string" && result.prompt.length > 0
        );
        check("历史被记录", agent.history.length === 1, "len=" + agent.history.length);
        check(
            "事件顺序完整",
            agent.events.map((item) => item.type).join(",") ===
                "provider.request,provider.response,action.parsed,runtime.result",
            agent.events.map((item) => item.type).join(",")
        );
    }

    // ------------------------------------------------------------
    // 2. 终止语义 answer：写入 answer 并给出收尾提示词
    // ------------------------------------------------------------
    {
        const agent = makeAgent({
            runtime: {
                async run() {
                    return { ok: true, action: "answer", content: "最终答案" };
                },
            },
            provider: {
                async send() {
                    return "<answer>最终答案</answer>";
                },
            },
        });

        const result = await runStep(agent, {
            prompt: "PROMPT",
            providerErrorState: { count: 0, max: 3 },
        });

        check("answer 不终止循环", result.stop === false);
        check("answer 被写入", agent.answer === "最终答案", String(agent.answer));
        check(
            "发出 answer 事件",
            agent.events.some((item) => item.type === "answer")
        );
    }

    // ------------------------------------------------------------
    // 3. 终止语义 end：直接停止
    // ------------------------------------------------------------
    {
        const agent = makeAgent({
            runtime: {
                async run() {
                    return { ok: true, action: "done" };
                },
            },
            provider: {
                async send() {
                    return "<done></done>";
                },
            },
        });

        const result = await runStep(agent, {
            prompt: "PROMPT",
            providerErrorState: { count: 0, max: 3 },
        });

        check("end 直接终止", result.stop === true);
        check("end 不再给提示词", result.prompt === null);
    }

    // ------------------------------------------------------------
    // 4. 发送失败：计数 +1，未达上限时继续
    // ------------------------------------------------------------
    {
        const state = { count: 0, max: 3 };
        const agent = makeAgent({
            provider: {
                async send() {
                    throw new Error("boom");
                },
            },
        });

        const result = await runStep(agent, { prompt: "PROMPT", providerErrorState: state });

        check("发送失败计数递增", state.count === 1, "count=" + state.count);
        check("未达上限不终止", result.stop === false);
        check("给出错误提示词", typeof result.prompt === "string" && result.prompt.length > 0);
        check(
            "发出重试事件",
            agent.events.some((item) => item.type === "provider.retry")
        );
    }

    // ------------------------------------------------------------
    // 5. 发送失败达到上限：抛出，交由 run() 收尾
    // ------------------------------------------------------------
    {
        const state = { count: 2, max: 3 };
        const agent = makeAgent({
            provider: {
                async send() {
                    throw new Error("boom");
                },
            },
        });

        let thrown = null;
        try {
            await runStep(agent, { prompt: "PROMPT", providerErrorState: state });
        } catch (error) {
            thrown = error;
        }

        check("达到上限抛错", thrown !== null);
        check(
            "错误信息包含失败次数",
            thrown && thrown.message.indexOf("3 consecutive times") !== -1,
            thrown && thrown.message
        );
    }

    // ------------------------------------------------------------
    // 6. 已停止：不再发送，直接返回终止
    // ------------------------------------------------------------
    {
        let sent = false;
        const agent = makeAgent({
            stopRequested: true,
            provider: {
                async send() {
                    sent = true;
                    return "<read/>";
                },
            },
        });

        const result = await runStep(agent, {
            prompt: "PROMPT",
            providerErrorState: { count: 0, max: 3 },
        });

        check("停止后仍发送（发送前判定在响应后）", sent === true);
        check("停止后返回终止", result.stop === true);
    }

    // ------------------------------------------------------------
    // 7. 解析失败：给出 XML 纠错提示词
    // ------------------------------------------------------------
    {
        const agent = makeAgent({
            provider: {
                async send() {
                    return "这不是 XML";
                },
            },
        });

        const result = await runStep(agent, {
            prompt: "PROMPT",
            providerErrorState: { count: 0, max: 3 },
        });

        check("解析失败不终止", result.stop === false);
        check(
            "解析失败给出纠错提示词",
            typeof result.prompt === "string" && result.prompt.length > 0
        );
        check(
            "发出解析错误事件",
            agent.events.some((item) => item.type === "action.parse_error")
        );
    }

    // ------------------------------------------------------------
    // 8. 动作执行抛错：折算为失败结果，仍走下一轮
    // ------------------------------------------------------------
    {
        const agent = makeAgent({
            runtime: {
                async run() {
                    throw new Error("runtime boom");
                },
            },
        });

        const result = await runStep(agent, {
            prompt: "PROMPT",
            providerErrorState: { count: 0, max: 3 },
        });

        check("动作抛错不终止", result.stop === false);
        check(
            "历史记录为 runtime_error",
            agent.history.length === 1 && agent.history[0].result.action === "runtime_error",
            JSON.stringify(
                agent.history[0] && agent.history[0].result && agent.history[0].result.action
            )
        );
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("FAILED: " + error.message);
    process.exit(1);
});
