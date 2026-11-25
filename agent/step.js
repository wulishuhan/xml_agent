/**
单步执行

一轮交互的完整闭环：发送 → 解析 JSON 动作 → 执行动作 → 决定下一步提示词。
它只做流程，不持有状态：所有状态（step / status / history / answer）都留在 Agent 上。

为什么单独成文件：这段逻辑有 4 个分支出口（发送失败重试、解析失败、动作失败、终止语义），
混在 Agent 的 run() 里会让主循环看不清。现在 run() 只负责循环与收尾。

依赖以 agent 实例传入，见函数头部注释中对字段的约定。
*/

const { nextDelay } = require("./retry");
const {
    getJsonErrorPrompt,
    getDonePrompt,
    getSendErrorPrompt,
    getRuntimeErrorPrompt,
    getRuntimeOkPrompt,
} = require("../prompts/index");
const { createHistoryRecord } = require("../workspace/history");
const { extractAction } = require("../parse/json-action");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
Agent 需要提供的字段/方法：
- emitEvent(type, data)              事件与插件钩子的唯一出口
- provider                           当前 provider（send 的实现方）
- status / stopRequested             停止判定
- syncConversationId()               会话 ID 变化时同步
- step                               当前步数（事件与历史用）
- runtime.run(action)                动作分发
- uploadArtifacts(result)            产物回传
- history                            历史记录数组
- resolveActionDefinition(name)      读 meta.terminal
- answer                             终止语义为 answer 时写入
*/
async function runStep(agent, { prompt, providerErrorState }) {
    let response;
    try {
        agent.emitEvent("provider.request", {
            step: agent.step,
        });
        response = await agent.provider.send(prompt);
        if (agent.status !== "running" || agent.stopRequested) {
            return {
                stop: true,
                prompt: null,
            };
        }
        providerErrorState.count = 0;
        agent.syncConversationId();
        agent.emitEvent("provider.response", {
            step: agent.step,
            length: response ? response.length : 0,
        });
    } catch (error) {
        // 状态已经不是 running（停止 / 超时看门狗把 provider 关了）时，
        // 不能再当成"provider 抖动"去重试 —— 那会把超时又拖成一串重试。
        if (agent.status !== "running" || agent.stopRequested) {
            return {
                stop: true,
                prompt: null,
            };
        }
        providerErrorState.count++;
        // 退避加抖动：不再精确落在 1s/2s/4s 上。
        const jitter = typeof agent.retryJitter === "number" ? agent.retryJitter : 0;
        let delay = nextDelay(providerErrorState.count, { jitter });
        // 疑似被限流的失败（空回复 / 发送未生效）额外拉长冷却，避免继续撞。
        const message = String(error.message || "");
        const throttled =
            error.code === "EMPTY_RESPONSE" ||
            /did not take effect|input box was not cleared/i.test(message);
        if (throttled) {
            const cooldown =
                typeof agent.throttleCooldownMs === "number" ? agent.throttleCooldownMs : 0;
            if (cooldown > 0) {
                delay = Math.max(
                    delay,
                    Math.round(cooldown * (1 + (Math.random() * 2 - 1) * jitter))
                );
            }
        }
        agent.emitEvent("provider.retry", {
            step: agent.step,
            error: message,
            count: providerErrorState.count,
            max: providerErrorState.max,
            delay,
            reason: throttled ? "throttle" : "error",
        });
        await sleep(delay);
        agent.emitEvent("provider.error", {
            step: agent.step,
            error: error.message,
            count: providerErrorState.count,
            max: providerErrorState.max,
        });
        if (providerErrorState.count >= providerErrorState.max) {
            throw new Error(
                "Provider failed " +
                    providerErrorState.count +
                    " consecutive times: " +
                    error.message
            );
        }
        return {
            stop: false,
            prompt: getSendErrorPrompt(error, { variant: agent.promptVariant ?? 0 }),
        };
    }

    let action;
    try {
        action = extractAction(response);
        agent.emitEvent("action.parsed", {
            step: agent.step,
            action: action.action,
            // 附带解析出的完整动作，便于在 Trace 中查看该 Action 的细节
            parsed: action,
        });
    } catch (error) {
        agent.emitEvent("action.parse_error", {
            step: agent.step,
            error: error.message,
        });
        return {
            stop: false,
            prompt: getJsonErrorPrompt(error, { variant: agent.promptVariant ?? 0 }),
        };
    }

    let result;
    try {
        result = await agent.runtime.run(action);
    } catch (error) {
        result = {
            ok: false,
            action: "runtime_error",
            error: error.message,
        };
    }

    // 动作产出的产物自动上传给模型，是否上传由 meta.collectImages 声明。
    result = await agent.uploadArtifacts(result);
    agent.history.push(createHistoryRecord(agent.step, action, result));
    agent.emitEvent("runtime.result", {
        step: agent.step,
        action: result.action,
        result,
    });

    // 停止请求可能落在动作执行中途（长命令被 killAllProcesses 结束）。
    // 这时不要再为主循环准备下一轮提示词，直接收敛。
    if (agent.stopRequested || agent.status !== "running") {
        return {
            stop: true,
            prompt: null,
        };
    }

    const definition = agent.resolveActionDefinition(result.action);
    // 终止语义由动作定义的 meta.terminal 决定，编排器不再认识具体动作名。
    const terminal = definition ? definition.meta.terminal : null;

    if (terminal === "answer" && result.ok) {
        agent.answer = result.content;
        agent.emitEvent("answer", {
            step: agent.step,
            content: result.content,
        });
        return {
            stop: false,
            prompt: getDonePrompt(),
        };
    }

    if (terminal === "end") {
        return {
            stop: true,
            prompt: null,
        };
    }

    // 回贴措辞跟随会话抽到的变体：会话内一致，会话间不同。
    // mock / 老调用方没有 promptVariant 时传 undefined，函数内部退回原文基准。
    const promptVariantOptions = { variant: agent.promptVariant };

    if (result.ok === false) {
        return {
            stop: false,
            prompt: getRuntimeErrorPrompt(result, promptVariantOptions),
        };
    }

    return {
        stop: false,
        prompt: getRuntimeOkPrompt(result, promptVariantOptions),
    };
}

module.exports = {
    runStep,
};
