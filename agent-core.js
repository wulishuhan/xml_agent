const { createProvider } = require("./providers");
const {
    getFirstPrompt,
    getXmlErrorPrompt,
    getDonePrompt,
    getRuntimeErrorPrompt,
    getRuntimeOkPrompt,
    getSendErrorPrompt,
} = require("./prompts/index");
const { createRuntime } = require("./runtime");
const { buildWorkspaceManifest } = require("./workspace/manifest");
const { createHistory, createHistoryRecord } = require("./workspace/history");
const { extractXML } = require("./parse/xml-parse");
const { EventEmitter } = require("events");
const agentConfig = require("./config/agent-config");

// 辅助：延迟函数
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class Agent extends EventEmitter {
    constructor(options = {}) {
        super();

        if (!options.workspace) {
            throw new Error("Workspace is required");
        }

        if (!options.task) {
            throw new Error("Task is required");
        }

        this.workspace = options.workspace;
        this.providerName = options.provider || "chatgpt";
        this.task = options.task;

        // 可选：provider 页面 URL 中的会话 ID。
        // 有值时，Provider 会直接打开该会话的 URL；无值时表示新会话。
        this.conversationId = options.conversationId || null;

        // 运行时从 provider 同步到的最新会话 ID（消息发送后回填）
        this.currentConversationId = this.conversationId;

        this.maxSteps = options.maxSteps ?? agentConfig.agent.maxSteps;
        this.maxProviderErrors = options.maxProviderErrors ?? agentConfig.agent.maxProviderErrors;

        this.history = createHistory();
        this.runtime = createRuntime(this.workspace);
        this.provider = null;
        this.step = 0;
        this.status = "created";
        this.answer = null;
        this.error = null;
        this.stopRequested = false;
    }

    emitEvent(type, data = {}) {
        const event = {
            type,
            timestamp: new Date().toISOString(),
            ...data,
        };

        this.emit("event", event);
        this.emit(type, event);

        return event;
    }

    /**

从 provider 同步 conversationId。

只在发生变化时 emit 事件，避免刷屏。
*/
    syncConversationId() {
        if (!this.provider) {
            return null;
        }

        const cid = this.provider.currentConversationId || null;

        if (!cid) {
            return null;
        }

        if (cid !== this.currentConversationId) {
            this.currentConversationId = cid;

            this.emitEvent("provider.conversation", {
                provider: this.providerName,
                conversationId: cid,
            });
        }

        return cid;
    }

    async run() {
        if (this.status !== "created") {
            throw new Error("Agent can only be run once");
        }

        this.status = "running";
        this.answer = null;
        this.error = null;
        this.stopRequested = false;

        try {
            const currentWorkspace = this.runtime.getWorkspace();
            const manifest = buildWorkspaceManifest(currentWorkspace);

            this.emitEvent("agent.started", {
                workspace: currentWorkspace,
                provider: this.providerName,
                task: this.task,
                conversationId: this.conversationId,
            });

            this.provider = createProvider(this.providerName, {
                autoStart: agentConfig.browser.autoStart,
                startTimeout: agentConfig.browser.startTimeout,
                retryInterval: agentConfig.browser.retryInterval,
                cdpUrl: agentConfig.browser.cdpUrl,
                chromePath: agentConfig.browser.chromePath,
                targetUrl: agentConfig.browser.targetUrls[this.providerName],
                reuseExistingPage: agentConfig.browser.reuseExistingPage,
                conversationId: this.conversationId,
            });

            this.emitEvent("provider.starting", {
                provider: this.providerName,
            });

            await this.provider.start();

            if (this.stopRequested || this.status !== "running") {
                return this.getResult();
            }

            this.emitEvent("provider.started", {
                provider: this.providerName,
            });

            // 启动后尝试同步一次会话 ID（如果页面已在某个 conversation 中）
            this.syncConversationId();

            let prompt = getFirstPrompt(currentWorkspace, manifest, this.task);

            const providerErrorState = {
                count: 0,
                max: this.maxProviderErrors,
            };

            while (this.step < this.maxSteps && this.status === "running") {
                this.step++;

                this.emitEvent("step.started", {
                    step: this.step,
                });

                const stepResult = await this.runStep({
                    prompt,
                    providerErrorState,
                });

                if (stepResult.stop) {
                    break;
                }

                prompt = stepResult.prompt;
            }

            if (this.status === "running") {
                this.status = this.step >= this.maxSteps ? "max_steps" : "completed";
            }

            await this.closeProvider();

            this.emitEvent("agent.completed", {
                status: this.status,
                steps: this.step,
                answer: this.answer,
                conversationId: this.currentConversationId,
            });

            return this.getResult();
        } catch (error) {
            this.error = error;

            if (this.status !== "stopped" && !this.stopRequested) {
                this.status = "error";

                await this.closeProvider();

                this.emitEvent("agent.error", {
                    error: error.message,
                });
            } else {
                await this.closeProvider();
            }

            throw error;
        }
    }

    async runStep({ prompt, providerErrorState }) {
        let response;

        try {
            this.emitEvent("provider.request", {
                step: this.step,
            });

            response = await this.provider.send(prompt);

            if (this.status !== "running" || this.stopRequested) {
                return {
                    stop: true,
                    prompt: null,
                };
            }

            providerErrorState.count = 0;

            // 每次响应后尝试同步 conversationId，让上层及时感知新会话 ID
            this.syncConversationId();

            this.emitEvent("provider.response", {
                step: this.step,
                length: response ? response.length : 0,
            });
        } catch (error) {
            if (this.status === "stopped" || this.stopRequested) {
                return {
                    stop: true,
                    prompt: null,
                };
            }

            providerErrorState.count++;

            // 指数退避延迟，最多30秒
            const delay = Math.min(1000 * Math.pow(2, providerErrorState.count - 1), 30000);
            this.emitEvent("provider.retry", {
                step: this.step,
                error: error.message,
                count: providerErrorState.count,
                max: providerErrorState.max,
                delay,
            });
            await sleep(delay);

            this.emitEvent("provider.error", {
                step: this.step,
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
                prompt: getSendErrorPrompt(error),
            };
        }

        let action;

        try {
            action = extractXML(response);

            this.emitEvent("action.parsed", {
                step: this.step,
                action: action.action,
            });
        } catch (error) {
            this.emitEvent("action.parse_error", {
                step: this.step,
                error: error.message,
            });

            return {
                stop: false,
                prompt: getXmlErrorPrompt(error),
            };
        }

        let result;

        try {
            result = this.runtime.run(action);
        } catch (error) {
            result = {
                ok: false,
                action: "runtime_error",
                error: error.message,
            };
        }

        this.history.push(createHistoryRecord(this.step, action, result));

        this.emitEvent("runtime.result", {
            step: this.step,
            action: result.action,
            result,
        });

        if (result.action === "answer" && result.ok) {
            this.answer = result.content;

            this.emitEvent("answer", {
                step: this.step,
                content: result.content,
            });

            return {
                stop: false,
                prompt: getDonePrompt(),
            };
        }

        if (result.action === "done") {
            return {
                stop: true,
                prompt: null,
            };
        }

        if (result.ok === false) {
            return {
                stop: false,
                prompt: getRuntimeErrorPrompt(result),
            };
        }

        return {
            stop: false,
            prompt: getRuntimeOkPrompt(result),
        };
    }

    async stop() {
        if (this.status !== "running") {
            return false;
        }

        this.stopRequested = true;
        this.status = "stopped";

        this.emitEvent("agent.stopped", {
            step: this.step,
        });

        await this.closeProvider();

        return true;
    }

    async closeProvider() {
        if (!this.provider) {
            return;
        }

        const provider = this.provider;
        this.provider = null;

        try {
            // 关闭前再尝试同步一次 conversationId，避免丢失最后的会话信息
            const cid = provider.currentConversationId;

            if (cid && cid !== this.currentConversationId) {
                this.currentConversationId = cid;

                this.emitEvent("provider.conversation", {
                    provider: this.providerName,
                    conversationId: cid,
                });
            }

            await provider.close();

            this.emitEvent("provider.closed", {
                provider: this.providerName,
            });
        } catch (error) {
            this.emitEvent("provider.close_error", {
                provider: this.providerName,
                error: error.message,
            });
        }
    }

    getResult() {
        return {
            status: this.status,
            workspace: this.workspace,
            provider: this.providerName,
            task: this.task,
            step: this.step,
            answer: this.answer,
            conversationId: this.currentConversationId,
            error: this.error ? this.error.message : null,
            history: this.history,
        };
    }
}

module.exports = {
    Agent,
};
