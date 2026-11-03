/**
Runtime —— 系统的执行核心与安全边界。

LLM 不直接操作电脑：所有操作都必须经过 XML Action，由本模块按动作表执行。
本模块现在只负责四件事：
1. Workspace 与路径沙箱（resolvePath）；
2. 查表执行内置动作（actions/ 里的定义对象）与插件动作（plugins/registry）；
3. 登记并结束本会话启动的子进程（processes/registry），让"停止"真的能停下命令；
4. 对外保持既有调用面（run / actionHandlers / 各动作同名方法）。

动作的具体实现（含错误文案）都在 actions/*.js 里，见 actions/index.js 的动作表。
*/

const fs = require("fs");
const path = require("path");
const { getBuiltinAction, getBuiltinActions } = require("./actions");
const { getRegistrySafe } = require("./plugins/registry");
const { createProcessRegistry } = require("./processes/registry");
const logger = require("./logger");

class Runtime {
    constructor(workspace = null, execScope = "workspace") {
        this.workspace = null;
        this.execScope = execScope || "workspace";
        // 本会话启动的子进程登记表。Agent.stop() 通过 killAllProcesses()
        // 结束这里登记的所有进程（前台命令 + --background 后台进程）。
        this.processes = createProcessRegistry();
        if (workspace) {
            this.setWorkspace(workspace);
        }
    }

    /**
     * 登记一个由动作启动的子进程。动作把自己的 child 交给这里，
     * 停止会话时才能按进程树结束它，而不是留下孤儿进程。
     */
    trackProcess(child, meta) {
        return this.processes.track(child, meta);
    }

    /**
     * 结束本会话启动的所有子进程。返回结束的数量。
     * Agent.stop() 会先调它，再关 provider —— 命令不结束，主循环就退不出来。
     */
    killAllProcesses(reason) {
        return this.processes.killAll(reason === undefined ? "stopped" : reason);
    }

    /** 当前仍存活的子进程快照（供状态展示与排查）。 */
    listProcesses() {
        return this.processes.list();
    }

    get runningProcessCount() {
        return this.processes.activeCount;
    }

    setWorkspace(workspace) {
        if (!workspace || typeof workspace !== "string") {
            throw new Error("Workspace path is required");
        }
        const resolved = path.resolve(workspace);
        if (!fs.existsSync(resolved)) {
            throw new Error("Workspace does not exist: " + resolved);
        }
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            throw new Error("Workspace is not a directory: " + resolved);
        }
        this.workspace = resolved;
        return this.workspace;
    }

    getWorkspace() {
        if (!this.workspace) {
            throw new Error("Workspace has not been configured");
        }
        return this.workspace;
    }

    resolvePath(filePath) {
        const workspace = this.getWorkspace();
        if (!filePath || typeof filePath !== "string") {
            throw new Error("Path is required");
        }
        // 如果 execScope 为 all，允许绝对路径（但需做基本安全检查）
        if (this.execScope === "all") {
            if (path.isAbsolute(filePath)) {
                // 简单的安全检查：不允许包含 .. 跳转到根目录之外
                const normalized = path.normalize(filePath);
                if (normalized.startsWith("..")) {
                    throw new Error("Unsafe absolute path");
                }
                return filePath;
            }
        }
        if (path.isAbsolute(filePath)) {
            throw new Error("Absolute paths are not allowed in workspace mode");
        }
        const fullPath = path.resolve(workspace, filePath);
        const workspacePrefix = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;
        if (fullPath !== workspace && !fullPath.startsWith(workspacePrefix)) {
            throw new Error("Path escapes workspace");
        }
        return fullPath;
    }

    /**
    内置动作执行上下文。插件动作拿到的能力门面在此之上更受限制
    （见 plugins/capabilities.js），内置动作属于"箱内代码"，可以直接用 Runtime。
    */
    createBuiltinContext() {
        return {
            runtime: this,
            workspace: this.getWorkspace(),
            resolvePath: (target) => this.resolvePath(target),
            execScope: this.execScope,
            logger,
        };
    }

    async run(action) {
        if (!action || typeof action !== "object") {
            throw new Error("Action is required");
        }
        this.getWorkspace();
        const actionName = action.action;
        const node = action.node;
        if (!actionName || typeof actionName !== "string") {
            throw new Error("Action name is required");
        }
        logger.debug("Runtime Action:", actionName);
        return await this.invokeActionByName(actionName, node);
    }

    /**
    统一的动作分发：内置动作表优先，其次是插件注册表。
    screenshot 自 v1.1.0 起走插件分支，因此这里不再需要区分调用方。
    */
    async invokeActionByName(actionName, node) {
        const definition = getBuiltinAction(actionName);
        if (definition) {
            // 兼容同步/异步 run：await 一个非 Promise 值不会有任何副作用。
            return await definition.run(node, this.createBuiltinContext());
        }
        const pluginResult = await this.runPluginAction(actionName, node);
        if (pluginResult) {
            return pluginResult;
        }
        throw new Error("Unknown action: " + actionName);
    }

    /**
    插件动作执行 host：把 workspace 与越界保护传给 registry，
    插件因此天然继承 Runtime 的路径沙箱，而不是自己碰 fs。
    */
    createPluginHost() {
        return {
            workspace: this.getWorkspace(),
            resolvePath: (target) => this.resolvePath(target),
            execScope: this.execScope,
        };
    }

    /**
    调用插件动作。不是插件动作时返回 null（便于调用方判断）。
    */
    async runPluginAction(actionName, node) {
        const registry = getRegistrySafe();
        if (!registry || !registry.hasAction(actionName)) {
            return null;
        }
        return await registry.invokeAction(actionName, node, this.createPluginHost());
    }

    // --------------------------------------------------------
    // 兼容层：既有调用方直接调 runtime.read(...) / runtime.screenshot(...) 仍可用。
    // 新代码请统一走 run({ action, node })。
    // --------------------------------------------------------

    read(node) {
        return this.invokeActionByName("read", node);
    }

    write(node) {
        return this.invokeActionByName("write", node);
    }

    execute(node) {
        return this.invokeActionByName("exec", node);
    }

    screenshot(node) {
        return this.invokeActionByName("screenshot", node);
    }

    answer(node) {
        return this.invokeActionByName("answer", node);
    }

    done(node) {
        return this.invokeActionByName("done", node);
    }

    /**
    动作名 → 处理函数。测试与外部工具会用到，因此保留。
    内容 = 内置动作表 + 已注册的插件动作（screenshot 就在后者里）。
    */
    get actionHandlers() {
        const handlers = {};
        for (const name of getBuiltinActions().keys()) {
            handlers[name] = (node) => this.invokeActionByName(name, node);
        }
        const registry = getRegistrySafe();
        if (registry && registry.actions) {
            for (const name of registry.actions.keys()) {
                if (!handlers[name]) {
                    handlers[name] = (node) => this.invokeActionByName(name, node);
                }
            }
        }
        return handlers;
    }
}

function createRuntime(workspace, execScope) {
    return new Runtime(workspace, execScope);
}

const legacyRuntime = createRuntime();

function setWorkspace(workspace) {
    return legacyRuntime.setWorkspace(workspace);
}

function getWorkspace() {
    return legacyRuntime.getWorkspace();
}

function run(action) {
    return legacyRuntime.run(action);
}

function killAllProcesses(reason) {
    return legacyRuntime.killAllProcesses(reason);
}

function listProcesses() {
    return legacyRuntime.listProcesses();
}

module.exports = {
    Runtime,
    createRuntime,
    run,
    setWorkspace,
    getWorkspace,
    killAllProcesses,
    listProcesses,
};
