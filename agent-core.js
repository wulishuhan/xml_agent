const path = require("path");
const { createProvider } = require("./providers");
// 用命名空间引用，避免 resolveBrowserPath() 这类同名方法在阅读时被误认为递归。
const providerOptions = require("./providers/options");
const { getFirstPrompt } = require("./prompts/index");
const { createRuntime } = require("./runtime");
const { createArtifactsChannel } = require("./agent/artifacts");
const { normalizePresetImages } = require("./agent/inputs");
const { runStep } = require("./agent/step");
const { getBuiltinAction } = require("./actions");
const { getRegistrySafe } = require("./plugins/registry");
const { buildWorkspaceManifest } = require("./workspace/manifest");
const { createHistory } = require("./workspace/history");
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
        // 可选：provider 页面 URL 中的会话 ID。
        this.conversationId = options.conversationId || null;
        this.currentConversationId = this.conversationId;
        // 可选：用户随任务附带的图片（相对 workspace 或绝对路径）。
        // 这些图片会在 provider 启动后、发送第一条 prompt 之前上传给模型。
        this.images = normalizePresetImages(options.images);
        // exec 权限控制：workspace 限制在当前工作区，all 无限制
        this.execScope = options.execScope || "workspace";
        this.maxSteps = options.maxSteps ?? agentConfig.agent.maxSteps;
        this.maxProviderErrors = options.maxProviderErrors ?? agentConfig.agent.maxProviderErrors;
        this.focusCdpPage =
            options.focusCdpPage !== undefined
                ? options.focusCdpPage
                : agentConfig.browser.focusCdpPage;
        // 浏览器类型（chrome/edge），未显式传入时使用配置。
        this.browserType = providerOptions.normalizeBrowserType(
            options.browserType !== undefined
                ? options.browserType
                : agentConfig.browser.browserType
        );
        this.history = createHistory();
        // 传递 execScope 给 Runtime
        this.runtime = createRuntime(this.workspace, this.execScope);
        // 产物回传通道：收集动作产物并上传给模型。
        // 依赖以回调形式注入，避免 artifacts 反向依赖 Agent 本体。
        this.artifacts = createArtifactsChannel({
            resolveActionDefinition: (name) => this.resolveActionDefinition(name),
            getProvider: () => this.provider,
            toAbsolutePath: (target) => this.toAbsolutePath(target),
            emit: (type, data) => this.emitEvent(type, data),
            getStep: () => this.step,
        });
        // 插件注册表：所有 Agent 事件都会转发给插件钩子（只观察，不影响主流程）。
        this.plugins = getRegistrySafe();
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
        // 插件钩子（hook 类插件的主要入口）。registry 内部已逐 handler 隔离异常，
        // 这里再兜一层：插件系统出的任何问题都不允许打断 Agent。
        if (this.plugins && typeof this.plugins.emitHook === "function") {
            try {
                this.plugins.emitHook(type, event);
            } catch (error) {
                // ignore
            }
        }
        return event;
    }
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
    /**
     * 当前浏览器应使用的可执行文件路径。
     * 解析规则（环境变量 > 配置 > 兜底）见 providers/options.js。
     */
    resolveBrowserPath() {
        return providerOptions.resolveBrowserPath(this.browserType);
    }

    /**
     * CDP 调试地址。主进程按 browserType 写入对应端口
     * （Chrome 默认 9222，Edge 默认 9223），避免两者共用同一端口。
     */
    resolveCdpUrl() {
        return providerOptions.resolveCdpUrl();
    }
    /**
     * 动作产出的、需要上传给模型看的图片路径（相对 workspace）。
     * 实现见 agent/artifacts.js：由动作定义的 meta.collectImages 决定，
     * 编排器不再按 action 名特判。
     */
    collectArtifactPaths(result) {
        return this.artifacts.collect(result);
    }

    /**
     * 动作定义解析：内置动作表优先，其次是插件注册表。
     * 用于读取终止语义（meta.terminal）与产物声明（meta.collectImages）。
     */
    resolveActionDefinition(actionName) {
        if (!actionName) {
            return null;
        }
        const builtin = getBuiltinAction(actionName);
        if (builtin) {
            return builtin;
        }
        if (this.plugins && typeof this.plugins.getActionDefinition === "function") {
            return this.plugins.getActionDefinition(actionName);
        }
        return null;
    }

    toAbsolutePath(relativeOrAbsolute) {
        if (path.isAbsolute(relativeOrAbsolute)) {
            return relativeOrAbsolute;
        }
        return path.resolve(this.workspace, relativeOrAbsolute);
    }
    /**
     * 动作成功后，把它产出的产物上传到当前对话，让模型下一轮"看到"内容。
     * 通道实现在 agent/artifacts.js：由 meta.collectImages 决定传什么，
     * 只对支持 uploadImages 的 provider 生效，失败不影响主流程。
     */
    async uploadArtifacts(result) {
        return this.artifacts.upload(result);
    }

    /**
     * 历史方法名（原语义只有截图需要回传，如今通道已泛化）。
     * 保留仅因为有既有调用方与测试按此名调用，新代码请用 uploadArtifacts。
     */
    async attachScreenshotToProvider(result) {
        return this.uploadArtifacts(result);
    }

    /**
     * 把用户随任务附带的图片上传给模型（第一条 prompt 之前执行）。
     * 实现见 agent/artifacts.js 的 uploadPreset。
     */
    async uploadPresetImages() {
        return this.artifacts.uploadPreset(this.images);
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
                browserType: this.browserType,
                task: this.task,
                conversationId: this.conversationId,
                images: this.images,
                execScope: this.execScope,
            });
            // 浏览器相关参数（CDP 地址、可执行文件、超时、访问地址）统一由
            // providers/options 装配：编排器不关心它们来自哪个环境变量或配置项。
            this.provider = createProvider(
                this.providerName,
                providerOptions.buildProviderOptions({
                    providerName: this.providerName,
                    browserType: this.browserType,
                    focusCdpPage: this.focusCdpPage,
                    conversationId: this.conversationId,
                })
            );
            this.emitEvent("provider.starting", {
                provider: this.providerName,
                browserType: this.browserType,
            });
            await this.provider.start();
            if (this.stopRequested || this.status !== "running") {
                return this.getResult();
            }
            this.emitEvent("provider.started", {
                provider: this.providerName,
                browserType: this.browserType,
            });
            this.syncConversationId();
            // 先把用户随任务附带的图片上传给模型，模型在第一条 prompt 时就能看到它们。
            await this.uploadPresetImages();
            if (this.stopRequested || this.status !== "running") {
                return this.getResult();
            }
            let prompt = getFirstPrompt(currentWorkspace, manifest, this.task, {
                registry: this.plugins,
            });
            const providerErrorState = {
                count: 0,
                max: this.maxProviderErrors,
            };
            while (this.step < this.maxSteps && this.status === "running") {
                this.step++;
                this.emitEvent("step.started", {
                    step: this.step,
                });
                const stepResult = await runStep(this, {
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
            browserType: this.browserType,
            task: this.task,
            images: this.images,
            execScope: this.execScope,
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
    // 导出面保持兼容：既有测试与调用方从这里取归一化函数。
    normalizeBrowserType: providerOptions.normalizeBrowserType,
    normalizePresetImages,
};
