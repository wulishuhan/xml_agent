const path = require("path");
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
        this.conversationId = options.conversationId || null;
        this.currentConversationId = this.conversationId;
        this.maxSteps = options.maxSteps ?? agentConfig.agent.maxSteps;
        this.maxProviderErrors = options.maxProviderErrors ?? agentConfig.agent.maxProviderErrors;
        this.focusCdpPage =
            options.focusCdpPage !== undefined
                ? options.focusCdpPage
                : agentConfig.browser.focusCdpPage;
        // 浏览器类型（chrome/edge），未显式传入时使用配置。
        this.browserType = normalizeBrowserType(
            options.browserType !== undefined
                ? options.browserType
                : agentConfig.browser.browserType
        );
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
解析当前浏览器应使用的可执行文件路径。
优先使用环境变量中由主进程按当前 browserType 写入的路径，
其次回退到 agentConfig。
*/
    resolveBrowserPath() {
        if (this.browserType === "edge") {
            const envEdge =
                process.env.BROWSER_EDGE_PATH ||
                process.env.EDGE_PATH ||
                process.env.XML_AGENT_EDGE_PATH;
            if (envEdge) {
                return envEdge;
            }
            return agentConfig.browser.edgePath || agentConfig.browser.chromePath || "";
        }
        const envChrome = process.env.BROWSER_CHROME_PATH || process.env.CHROME_PATH;
        if (envChrome) {
            return envChrome;
        }
        return agentConfig.browser.chromePath || "";
    }
    /**
解析 CDP URL。
优先使用主进程按 browserType 解析后写入环境变量的端口
（Chrome 默认 9222，Edge 默认 9223），避免两者共用同一端口。
*/
    resolveCdpUrl() {
        const envCdp = process.env.BROWSER_CDP_URL || process.env.XML_AGENT_CDP_URL;
        if (envCdp && String(envCdp).trim()) {
            return String(envCdp).trim();
        }
        return agentConfig.browser.cdpUrl;
    }
    /**
- 收集截图结果里所有可上传的图片路径（相对 workspace）。
- 兼容单图（result.path）与多图（result.paths / result.results）。
*/
    collectScreenshotPaths(result) {
        const relativePaths = [];
        if (Array.isArray(result.paths)) {
            for (const item of result.paths) {
                if (item && relativePaths.indexOf(item) === -1) {
                    relativePaths.push(item);
                }
            }
        }
        if (relativePaths.length === 0 && Array.isArray(result.results)) {
            for (const item of result.results) {
                if (item && item.ok && item.path && relativePaths.indexOf(item.path) === -1) {
                    relativePaths.push(item.path);
                }
            }
        }
        if (relativePaths.length === 0 && result.path) {
            relativePaths.push(result.path);
        }
        return relativePaths;
    }

    /**
- 截图成功后，把图片上传到当前对话，让大模型能在下一轮"看到"截图内容。
- 支持一次上传多张（多目标 screenshot 会返回多张成功图片）。
- 只对支持 uploadImages 的 provider 生效；失败不影响主流程，仅记录在结果里。
*/
    async attachScreenshotToProvider(result) {
        if (!result || result.action !== "screenshot" || !result.ok) {
            return result;
        }
        const relativePaths = this.collectScreenshotPaths(result);
        if (relativePaths.length === 0) {
            result.uploaded = false;
            return result;
        }
        if (!this.provider || typeof this.provider.uploadImages !== "function") {
            result.uploaded = false;
            return result;
        }
        const absolutePaths = relativePaths.map((relativePath) =>
            path.isAbsolute(relativePath)
                ? relativePath
                : path.resolve(this.workspace, relativePath)
        );
        try {
            const upload = await this.provider.uploadImages(absolutePaths);
            result.uploaded = upload && upload.ok !== false;
            result.uploadCount = upload && upload.count ? upload.count : 0;
            result.uploadedPaths = relativePaths;
            this.emitEvent("screenshot.uploaded", {
                step: this.step,
                path: relativePaths[0],
                paths: relativePaths,
                uploaded: result.uploaded,
                uploadCount: result.uploadCount,
            });
        } catch (error) {
            result.uploaded = false;
            result.uploadError = error.message;
            this.emitEvent("screenshot.upload_error", {
                step: this.step,
                path: relativePaths[0],
                paths: relativePaths,
                error: error.message,
            });
        }
        return result;
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
            });
            const cdpUrl = this.resolveCdpUrl();
            this.provider = createProvider(this.providerName, {
                autoStart: agentConfig.browser.autoStart,
                startTimeout: agentConfig.browser.startTimeout,
                retryInterval: agentConfig.browser.retryInterval,
                cdpUrl,
                // 保持旧字段 chromePath 兼容，同时显式传入 browserType。
                chromePath: this.resolveBrowserPath(),
                browserType: this.browserType,
                targetUrl: agentConfig.browser.targetUrls[this.providerName],
                reuseExistingPage: agentConfig.browser.reuseExistingPage,
                focusCdpPage: this.focusCdpPage,
                conversationId: this.conversationId,
            });
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
                // 附带解析出的完整动作，便于在 Trace 中查看该 Action 的细节
                parsed: action,
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
            result = await this.runtime.run(action);
        } catch (error) {
            result = {
                ok: false,
                action: "runtime_error",
                error: error.message,
            };
        }
        // 截图成功后把图片上传到当前对话，让大模型能在下一轮看到截图内容。
        result = await this.attachScreenshotToProvider(result);
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
            step: this.step,
            answer: this.answer,
            conversationId: this.currentConversationId,
            error: this.error ? this.error.message : null,
            history: this.history,
        };
    }
}
function normalizeBrowserType(value) {
    const text = String(value || "")
        .trim()
        .toLowerCase();
    if (text === "edge" || text === "msedge" || text === "microsoft-edge") {
        return "edge";
    }
    return "chrome";
}
module.exports = {
    Agent,
    normalizeBrowserType,
};
