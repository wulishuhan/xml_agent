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
const { listSkills: scanSkills } = require("./skills");
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
        // 整轮任务的墙钟上限。maxSteps 只管步数，浏览器 provider 每步十几秒，
        // 100 步能跑半小时以上，UI 上却没有任何兜底。0 表示不限制。
        this.runTimeoutMs = options.runTimeoutMs ?? agentConfig.agent.runTimeoutMs;
        // provider 工厂可注入，便于单测在不起浏览器的情况下驱动主循环。
        this.createProviderImpl = options.createProvider || createProvider;
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
        this.runDeadline = 0;
        // 运行期墙钟看门狗的句柄（见 armDeadlineWatchdog）
        this._deadlineTimer = null;
    }
    /** 墙钟上限是否已到（未设置上限时永远 false）。 */
    isRunTimeoutExceeded(now = Date.now()) {
        return Boolean(this.runDeadline) && now >= this.runDeadline;
    }

    /**
    墙钟看门狗：到点强制收摊，而不是等某一步自己回来。

    runDeadline 只在两步之间检查。如果某一步卡在 provider 调用里（浏览器那边
    CDP 调用挂住时不会触发它自己的超时），主循环根本没机会走到检查点，
    整轮就会远超上限。到点时直接把 provider 关掉，挂起的调用随即失败，
    runStep 看到状态已不是 running 就收敛，主循环退出并记为 timeout。
    */
    armDeadlineWatchdog() {
        this.clearDeadlineWatchdog();

        if (!(this.runTimeoutMs > 0)) {
            return;
        }

        this._deadlineTimer = setTimeout(() => {
            if (this.status !== "running") {
                return;
            }

            this.status = "timeout";
            this.emitEvent("agent.timeout", {
                step: this.step,
                runTimeoutMs: this.runTimeoutMs,
                hard: true,
            });

            if (this.provider && typeof this.provider.close === "function") {
                Promise.resolve()
                    .then(() => this.provider.close())
                    .catch(() => {});
            }
        }, this.runTimeoutMs);
        // 刻意不 unref：运行期间它是"必须活到点"的看门狗，
        // 正常结束时由 closeProvider 清掉。
    }

    clearDeadlineWatchdog() {
        if (this._deadlineTimer) {
            clearTimeout(this._deadlineTimer);
            this._deadlineTimer = null;
        }
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

    /**
     * 扫描工作区里的技能（builtin / user / workspace 三处合并）。
     * 扫描本身是只读的，出问题只降级成"没有技能提示"，不影响任务本身。
     */
    collectSkills(workspace) {
        try {
            return scanSkills({ workspace: workspace });
        } catch (error) {
            this.emitEvent("skills.scan.failed", { message: error.message });
            return [];
        }
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
            // 工作区里的技能清单：扫描失败不该让整轮任务起不来（只失去技能提示）。
            const skills = this.collectSkills(currentWorkspace);
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
            this.provider = this.createProviderImpl(
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
                skills: skills,
                // 少数平台（如 Gemini）的渲染器会把裸 XML 标签整块丢掉，
                // 需要 provider 自己声明"输出格式怎么适配"。
                providerHint:
                    typeof this.provider.getActionMarkupHint === "function"
                        ? this.provider.getActionMarkupHint()
                        : "",
            });
            const providerErrorState = {
                count: 0,
                max: this.maxProviderErrors,
            };
            this.runDeadline = this.runTimeoutMs > 0 ? Date.now() + this.runTimeoutMs : 0;
            this.armDeadlineWatchdog();
            while (this.step < this.maxSteps && this.status === "running") {
                // 每步开始前检查一次墙钟。单步本身由 provider 的 responseTimeout 兜底，
                // 这里防的是"每一步都成功、但整轮跑了半小时还没结束"。
                if (this.isRunTimeoutExceeded()) {
                    this.status = "timeout";
                    this.emitEvent("agent.timeout", {
                        step: this.step,
                        runTimeoutMs: this.runTimeoutMs,
                    });
                    break;
                }
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
                // 会话异常结束时同样收摊：后台进程不会因为 Agent 报错就自己退出，
                // 留下来就是占端口的孤儿进程。
                await this.killChildProcesses("error");
                await this.closeProvider();
                this.emitEvent("agent.error", {
                    error: error.message,
                });
            } else {
                await this.killChildProcesses("stopped");
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
        // 先结束子进程，再关浏览器：命令不结束的话，run() 会一直挂在
        // await runtime.run(action) 上，前台长命令甚至要等到 maxExecTimeout。
        // 这一步是"停止真的能停下"的关键，顺序不能反。
        await this.killChildProcesses("stopped");
        await this.closeProvider();
        return true;
    }

    /**
     * 结束本会话启动的所有子进程（前台命令 + --background 后台进程）。
     * 失败不影响停止流程本身。
     */
    async killChildProcesses(reason) {
        try {
            const count = await this.runtime.killAllProcesses(reason);
            if (count) {
                this.emitEvent("agent.processes_killed", {
                    count,
                    reason: reason || "stopped",
                });
            }
            return count;
        } catch (error) {
            this.emitEvent("agent.processes_kill_error", {
                error: error.message,
            });
            return 0;
        }
    }
    async closeProvider() {
        // 所有退出路径（正常 / 停止 / 报错 / 超时）都会走到这里
        this.clearDeadlineWatchdog();

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
