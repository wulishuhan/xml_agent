const crypto = require("crypto");
const { EventEmitter } = require("events");
const { Agent } = require("../../agent-core");

class AgentSession extends EventEmitter {
    constructor({ workspace, provider = "chatgpt", task }) {
        super();

        if (!workspace) {
            throw new Error("Workspace is required");
        }

        if (!task) {
            throw new Error("Task is required");
        }

        this.id = crypto.randomUUID();
        this.workspace = workspace;
        this.provider = provider;
        this.task = task;

        this.agent = null;
        this.output = [];
        this.status = "created";
        this.exitCode = null;
        this.error = null;

        this.createdAt = Date.now();
        this.startedAt = null;
        this.finishedAt = null;
    }

    addOutput(type, content, event = null) {
        const record = {
            id: crypto.randomUUID(),
            type,
            content,
            timestamp: Date.now(),
        };

        if (event) {
            record.event = event;
        }

        this.output.push(record);
        this.emit("output", record);

        return record;
    }

    handleAgentEvent(event) {
        const content = this.formatEvent(event);

        if (content !== null) {
            this.addOutput(event.type.includes("error") ? "stderr" : "stdout", content, event);
        }

        this.emit("agent.event", event);
    }

    formatEvent(event) {
        switch (event.type) {
            case "agent.started":
                return "🚀 Agent started";

            case "step.started":
                return "Agent step " + event.step;

            case "provider.starting":
                return "Starting provider: " + event.provider;

            case "provider.started":
                return "Provider started: " + event.provider;

            case "provider.request":
                return "Provider request (step " + event.step + ")";

            case "provider.response":
                return "Provider response received (" + event.length + " chars)";

            case "provider.error":
                return "Provider error (" + event.count + "/" + event.max + "): " + event.error;

            case "provider.closed":
                return "Provider closed: " + event.provider;

            case "provider.close_error":
                return "Provider close error: " + event.error;

            case "action.parsed":
                return "XML action parsed: " + event.action;

            case "action.parse_error":
                return "XML parse error: " + event.error;

            case "runtime.result":
                return (
                    "Runtime action: " + event.action + "\n" + JSON.stringify(event.result, null, 2)
                );

            case "answer":
                return event.content;

            case "agent.stopped":
                return "⏹ Agent stopped by user";

            case "agent.completed":
                return "Agent completed with status: " + event.status;

            case "agent.error":
                return "Agent error: " + event.error;

            default:
                return null;
        }
    }

    start() {
        if (this.agent || this.status === "running") {
            throw new Error("Agent session is already running");
        }

        this.status = "running";
        this.startedAt = Date.now();
        this.finishedAt = null;
        this.exitCode = null;
        this.error = null;

        this.agent = new Agent({
            workspace: this.workspace,
            provider: this.provider,
            task: this.task,
        });

        this.agent.on("event", (event) => {
            this.handleAgentEvent(event);
        });

        this.addOutput("system", "🚀 Starting agent...");

        this.run().catch(() => {
            // run() already records the error and updates the session state.
        });

        return this;
    }

    async run() {
        if (!this.agent) {
            throw new Error("Agent has not been created");
        }

        try {
            const result = await this.agent.run();

            if (this.status !== "stopped") {
                this.status = result.status === "error" ? "error" : "completed";
            }

            this.exitCode = this.status === "error" ? 1 : 0;
            this.finishedAt = Date.now();

            this.emit("finished", this.getInfo());

            return result;
        } catch (error) {
            if (this.status !== "stopped") {
                this.error = error.message;
                this.status = "error";
                this.exitCode = 1;

                this.addOutput("stderr", "Agent process error: " + error.message);

                this.emit("session.error", error);
            }

            this.finishedAt = Date.now();
            this.emit("finished", this.getInfo());

            throw error;
        } finally {
            this.agent = null;
        }
    }

    async stop() {
        if (!this.agent || this.status !== "running") {
            throw new Error("Agent is not running");
        }

        const stopped = await this.agent.stop();

        if (!stopped) {
            return false;
        }

        this.status = "stopped";
        this.finishedAt = Date.now();

        this.addOutput("system", "⏹ Agent stopped by user");

        return true;
    }

    isRunning() {
        return this.status === "running" && this.agent !== null;
    }

    getOutput() {
        return this.output;
    }

    getInfo() {
        return {
            id: this.id,
            workspace: this.workspace,
            provider: this.provider,
            task: this.task,
            status: this.status,
            running: this.isRunning(),
            pid: null,
            exitCode: this.exitCode,
            outputLength: this.output.length,
            createdAt: this.createdAt,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            error: this.error,
        };
    }
}

module.exports = { AgentSession };
