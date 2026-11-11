const crypto = require("crypto");
const { EventEmitter } = require("events");
const { Agent } = require("../../agent-core");
const { getRegistrySafe } = require("../../plugins/registry");
const contextBudget = require("./context-budget");

/**
上下文预算的采样间隔（步）。
measure 是 O(记录数)、2000 条约 30ms，每步都算会变成 O(n²)；
每 5 步采一次，阈值判断的滞后最多 5 步，对「快满了」这种趋势判断足够。
*/
const CONTEXT_CHECK_EVERY = 5;
class AgentSession extends EventEmitter {
    constructor({
        workspace,
        provider = "chatgpt",
        task,
        conversationId = null,
        images = [],
        execScope = "workspace",
    }) {
        super();
        if (!workspace) {
            throw new Error("Workspace is required");
        }
        // 允许 task 为空，用于创建"New Session"占位会话
        this.id = crypto.randomUUID();
        this.workspace = workspace;
        this.provider = provider;
        this.task = task || "";
        // provider 页面的会话 id（DeepSeek/ChatGPT/Qwen URL 中的 id）
        // 有值表示"继续已有会话"，无值表示"新会话"
        this.conversationId = conversationId || null;
        // 用户随任务附带的图片（相对 workspace 或绝对路径）。
        // 进程重启后不会重新上传，因此仅作为运行时状态保留在内存。
        this.images = Array.isArray(images) ? images.slice() : [];
        // exec 权限控制：workspace 限制在当前工作区，all 无限制
        this.execScope = execScope || "workspace";
        this.agent = null;
        this.plugins = getRegistrySafe();
        this.output = [];
        this.status = "created";
        this.exitCode = null;
        this.error = null;
        this.createdAt = Date.now();
        this.startedAt = null;
        this.finishedAt = null;
        // 记录本 session 内运行的次数（同一会话可多次运行，复用同一个 session）。
        this.runCount = 0;
        // 上下文窗口：默认 1M，可用 XML_AGENT_CONTEXT_LIMIT 覆盖
        this.contextLimit = contextBudget.normalizeLimit(process.env.XML_AGENT_CONTEXT_LIMIT);
        this.contextLevel = "normal";
        this.contextCheckedAt = 0;
        this.contextCache = null;
    }
    /**
从持久化数据恢复一个已经存在的会话实例。
只恢复可在进程重启后还原的状态；运行时字段（agent 等）不恢复。
恢复后的会话不会处于 running 状态（进程已重启，进程内的 Agent 已丢失）。
*/
    restore(data) {
        if (!data) {
            return this;
        }
        if (typeof data.id === "string" && data.id) {
            this.id = data.id;
        }
        if (Array.isArray(data.output)) {
            this.output = data.output;
        }
        if (typeof data.status === "string") {
            this.status = data.status;
        }
        if (data.conversationId) {
            this.conversationId = data.conversationId;
        }
        if (typeof data.exitCode !== "undefined") {
            this.exitCode = data.exitCode;
        }
        if (typeof data.error !== "undefined") {
            this.error = data.error;
        }
        if (typeof data.createdAt === "number") {
            this.createdAt = data.createdAt;
        }
        if (typeof data.startedAt === "number") {
            this.startedAt = data.startedAt;
        }
        if (typeof data.finishedAt === "number") {
            this.finishedAt = data.finishedAt;
        }
        if (typeof data.runCount === "number") {
            this.runCount = data.runCount;
        }
        if (typeof data.task === "string") {
            this.task = data.task;
        }
        if (typeof data.execScope === "string") {
            this.execScope = data.execScope;
        }
        // 进程重启后，之前处于 running 的会话实际上已经中断
        if (this.status === "running") {
            this.status = "interrupted";
            this.finishedAt = this.finishedAt || Date.now();
            this.exitCode = this.exitCode === null ? 1 : this.exitCode;
        }
        return this;
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
        // 每步动作执行完是一轮上下文的自然边界：在这里采样预算占用，
        // 跨过提醒阈值时向下游广播一次（不是每步都推）。
        if (event.type === "runtime.result") {
            this.checkContextBudget(event.step);
        }
        // provider.conversation 事件用于同步 provider 页面的会话 id，
        // 不写入控制台，只更新 session 状态并广播给前端。
        if (event.type === "provider.conversation") {
            if (event.conversationId && event.conversationId !== this.conversationId) {
                this.conversationId = event.conversationId;
                this.emit("conversation", {
                    id: this.id,
                    conversationId: this.conversationId,
                });
            }
        }
        // 重要：runtime.result 里已经携带了 answer 的完整内容，
        // 如果再把 answer 事件也写入 output，就会出现两条重复记录。
        // 这里只广播事件，不再重复写入 output。
        if (event.type === "answer") {
            this.emit("agent.event", event);
            return;
        }
        const content = this.formatEvent(event);
        if (content !== null) {
            this.addOutput(event.type.includes("error") ? "stderr" : "stdout", content, event);
        }
        this.emit("agent.event", event);
    }
    formatEvent(event) {
        const builtin = this.formatBuiltinEvent(event);
        if (builtin !== null && builtin !== undefined) {
            return builtin;
        }
        // 插件注册的事件格式器（可选）
        if (this.plugins && typeof this.plugins.formatEvent === "function") {
            const custom = this.plugins.formatEvent(event.type, event);
            if (custom) {
                return custom;
            }
        }
        // 兜底：未知事件也要有一条控制台记录，而不是静默消失。
        return this.summarizeEvent(event);
    }

    /**
    未知事件的通用渲染：类型 + 精简后的 JSON 摘要。
    插件新增的任何事件都会走这里，因此前端/控制台不会再出现"这一步空白"。
    */
    summarizeEvent(event) {
        const detail = {};
        for (const key of Object.keys(event)) {
            if (key === "type" || key === "timestamp") {
                continue;
            }
            detail[key] = event[key];
        }
        let text = "";
        try {
            text = JSON.stringify(detail);
        } catch (error) {
            text = "";
        }
        if (text && text.length > 400) {
            text = text.substring(0, 400) + "...(truncated)";
        }
        return event.type + (text && text !== "{}" ? " " + text : "");
    }

    formatBuiltinEvent(event) {
        switch (event.type) {
            case "agent.started":
                return "🚀 Agent started";
            case "step.started":
                return "Agent step " + event.step;
            case "provider.starting":
                return "Starting provider: " + event.provider;
            case "provider.started":
                return "Provider started: " + event.provider;
            case "provider.conversation":
                return "Provider conversation id: " + event.conversationId;
            case "provider.request":
                return "Provider request (step " + event.step + ")";
            case "provider.response":
                return "Provider response received (" + event.length + " chars)";
            case "provider.retry":
                return (
                    "Provider retry (" +
                    event.count +
                    "/" +
                    event.max +
                    ") after " +
                    event.delay +
                    "ms: " +
                    event.error
                );
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
            case "images.uploaded":
                return "Images uploaded to model (" + event.uploadCount + "/" + event.count + ")";
            case "images.upload_skipped":
                return "Images upload skipped: " + event.reason;
            case "images.upload_error":
                return "Images upload error: " + event.error;
            case "images.missing":
                return "Images missing (" + event.count + "): " + event.paths.join(", ");
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
        if (!this.task || !this.task.trim()) {
            throw new Error("Task is required before starting agent");
        }
        this.status = "running";
        this.startedAt = Date.now();
        this.finishedAt = null;
        this.exitCode = null;
        this.error = null;
        this.runCount += 1;
        // 新一轮的 step 从 0 重新数，采样节流的游标也要跟着归零，
        // 否则续跑后的头几步会因为「step 比上次小」被跳过
        this.contextCheckedAt = 0;
        this.agent = new Agent({
            workspace: this.workspace,
            provider: this.provider,
            task: this.task,
            conversationId: this.conversationId,
            images: this.images,
            execScope: this.execScope,
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
    /**
在同一个 session 内继续一次新的运行。
复用相同的 session id / conversationId，因此侧边栏不会新增会话。
追加新的运行输出（history 会累积多次回复）。
仅允许在非运行状态调用。
*/
    resume(task, images) {
        if (this.isRunning()) {
            throw new Error("Agent session is already running");
        }
        if (typeof task === "string" && task.trim()) {
            this.task = task.trim();
        }
        if (Array.isArray(images)) {
            this.images = images.slice();
        }
        return this.start();
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
            // 从 result 中同步 conversationId
            if (result.conversationId && result.conversationId !== this.conversationId) {
                this.conversationId = result.conversationId;
                this.emit("conversation", {
                    id: this.id,
                    conversationId: this.conversationId,
                });
            }
            this.exitCode = this.status === "error" ? 1 : 0;
            this.finishedAt = Date.now();
            // 收尾强制采样：界面上看到的必须是最终占用，不是最后一次间隔采样的旧值
            this.checkContextBudget(0, true);
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
            this.checkContextBudget(0, true);
            this.emit("finished", this.getInfo());
            throw error;
        } finally {
            this.agent = null;
            if (this.plugins && typeof this.plugins.emitHook === "function") {
                try {
                    this.plugins.emitHook("session.finished", this.getInfo());
                } catch (error) {
                    // 插件钩子不允许影响会话收尾
                }
            }
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
    /**
    当前上下文占用（相对 provider 的窗口）。
    带缓存：记录条数没变就直接返回上次结果，避免 getInfo / 接口轮询时反复全量扫描。
    */
    getContextUsage() {
        const cached = this.contextCache;
        if (cached && cached.length === this.output.length) {
            return cached.usage;
        }
        const usage = contextBudget.measure({
            info: { task: this.task, images: this.images },
            output: this.output,
            limit: this.contextLimit,
        });
        this.contextCache = { length: this.output.length, usage };
        return usage;
    }
    /**
    采样一次占用，跨阈值时广播。
    force=true 用于收尾（停止 / 出错 / 正常结束），保证界面上看到的是最终值。
    返回本次的 usage，被节流跳过时返回 null。
    */
    checkContextBudget(step, force = false) {
        try {
            if (!force) {
                const current = Number(step) || 0;
                if (
                    this.contextCheckedAt &&
                    current - this.contextCheckedAt < CONTEXT_CHECK_EVERY
                ) {
                    return null;
                }
                this.contextCheckedAt = current;
            }
            const usage = this.getContextUsage();
            if (force || usage.level !== this.contextLevel) {
                this.contextLevel = usage.level;
                this.emit("context", Object.assign({ id: this.id }, usage));
            }
            return usage;
        } catch (error) {
            // 预算估算只是个提示功能，任何异常都不该影响会话本身
            return null;
        }
    }
    getInfo() {
        return {
            id: this.id,
            conversationId: this.conversationId,
            workspace: this.workspace,
            provider: this.provider,
            task: this.task,
            images: this.images.slice(),
            execScope: this.execScope,
            status: this.status,
            running: this.isRunning(),
            pid: null,
            exitCode: this.exitCode,
            outputLength: this.output.length,
            runCount: this.runCount,
            createdAt: this.createdAt,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            error: this.error,
        };
    }
}
module.exports = { AgentSession };
