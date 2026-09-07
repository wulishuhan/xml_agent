
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
const {
    createHistory,
    createHistoryRecord,
} = require("./workspace/history");
const { EventEmitter } = require("events");
const agentConfig = require("./config/agent-config");

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

        this.maxSteps =
            options.maxSteps || agentConfig.agent.maxSteps;
        this.maxProviderErrors =
            options.maxProviderErrors ||
            agentConfig.agent.maxProviderErrors;

        this.history = createHistory();
        this.runtime = createRuntime(this.workspace);
        this.provider = null;
        this.step = 0;
        this.status = "created";
        this.answer = null;
        this.error = null;
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

    async run() {
        if (this.status === "running") {
            throw new Error("Agent is already running");
        }

        this.status = "running";
        this.answer = null;
        this.error = null;

        try {
            const currentWorkspace = this.runtime.getWorkspace();
            const manifest =
                buildWorkspaceManifest(currentWorkspace);

            this.emitEvent("agent.started", {
                workspace: currentWorkspace,
                provider: this.providerName,
                task: this.task,
            });

            this.provider = createProvider(this.providerName, {
                autoStart: agentConfig.browser.autoStart,
                startTimeout: agentConfig.browser.startTimeout,
                retryInterval: agentConfig.browser.retryInterval,
                chromePath: agentConfig.browser.chromePath,
                targetUrl:
                    agentConfig.browser.targetUrls[this.providerName],
            });

            this.emitEvent("provider.starting", {
                provider: this.providerName,
            });

            await this.provider.start();

            this.emitEvent("provider.started", {
                provider: this.providerName,
            });

            let prompt = getFirstPrompt(
                currentWorkspace,
                manifest,
                this.task
            );

            const providerErrorState = {
                count: 0,
                max: this.maxProviderErrors,
            };

            while (this.step < this.maxSteps) {
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
                this.status =
                    this.step >= this.maxSteps
                        ? "max_steps"
                        : "completed";
            }

            await this.closeProvider();

            this.emitEvent("agent.completed", {
                status: this.status,
                steps: this.step,
                answer: this.answer,
            });

            return this.getResult();
        } catch (error) {
            this.error = error;
            this.status = "error";

            await this.closeProvider();

            this.emitEvent("agent.error", {
                error: error.message,
            });

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

            providerErrorState.count = 0;

            this.emitEvent("provider.response", {
                step: this.step,
                length: response ? response.length : 0,
            });
        } catch (error) {
            providerErrorState.count++;

            this.emitEvent("provider.error", {
                step: this.step,
                error: error.message,
                count: providerErrorState.count,
                max: providerErrorState.max,
            });

            if (
                providerErrorState.count >=
                providerErrorState.max
            ) {
                return {
                    stop: true,
                    prompt: null,
                };
            }

            return {
                stop: false,
                prompt: getSendErrorPrompt(error),
            };
        }

        let action;

        try {
            action = require("./parse/xml-parse").extractXML(
                response
            );

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

        this.history.push(
            createHistoryRecord(
                this.step,
                action,
                result
            )
        );

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
            error: this.error
                ? this.error.message
                : null,
            history: this.history,
        };
    }

}

module.exports = {
    Agent,
};
