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
const agentConfig = require("./config/agent-config");
const logger = require("./logger");

/**
Windows 保留设备名：CON / PRN / AUX / NUL / COM1-9 / LPT1-9。
这些名字在任意目录下都会被 Win32 解释成设备：写 CON 会被丢到控制台（不落盘），
读 CON 会等键盘输入。fs 不会报错，于是模型会看到"写入成功"但文件根本不存在。
*/
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;

/** 取真实路径（解开符号链接 / junction）。失败返回 null，交给后续 fs 自己报错。 */
function realPathOf(target) {
    try {
        const resolve = fs.realpathSync.native || fs.realpathSync;
        return resolve(target);
    } catch (error) {
        return null;
    }
}

/** 目标可能还不存在（新建文件），找到最近的已存在祖先再取真实路径。 */
function nearestExistingPath(target) {
    let current = target;
    for (;;) {
        if (fs.existsSync(current)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

/** child 是否位于 root 之内（两者都应是真实路径）。 */
function isInsidePath(root, child) {
    const relative = path.relative(root, child);
    if (!relative) {
        return true;
    }
    return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
}

/** Windows 专属：拒绝设备名与 NTFS 数据流写法（相对路径里出现冒号只可能是这两者）。 */
function assertWindowsSafeSegments(filePath) {
    if (process.platform !== "win32") {
        return;
    }
    const segments = String(filePath).split(/[\\/]+/);
    for (const segment of segments) {
        if (!segment || segment === "." || segment === "..") {
            continue;
        }
        if (segment.indexOf(":") !== -1) {
            throw new Error("Alternate data stream paths are not allowed: " + segment);
        }
        // Win32 会忽略设备名的扩展名与结尾点，CON.txt 同样是设备
        const base = segment
            .replace(/[. ]+$/, "")
            .split(".")[0]
            .trim();
        if (WINDOWS_RESERVED_NAMES.test(base)) {
            throw new Error("Windows reserved device name is not allowed: " + segment);
        }
    }
}

/**
动作级超时：跟随运行期配置的动作。

meta.timeoutMs 已被 sdk.defineAction 归一化（缺省 30s、上限 10 分钟），
但 exec 不能只吃这个静态值：它的命令级超时来自 agentConfig.runtime.maxExecTimeout
（RUNTIME_MAX_EXEC_TIMEOUT 可改），meta 里的 330000 只是默认配置下的对齐值。
用户把 maxExecTimeout 调到 10 分钟时，动作级兜底若仍按 330s 触发，
就会把还在正常跑的命令提前判死。
*/
const TIMEOUT_FOLLOWS_CONFIG = {
    exec: () => Number(agentConfig.runtime.maxExecTimeout) + 30000,
};

/** 动作的有效超时（毫秒），0 表示不限时。 */
function resolveActionTimeout(actionName, meta) {
    const raw = meta ? Number(meta.timeoutMs) : NaN;
    const base = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const follow = TIMEOUT_FOLLOWS_CONFIG[actionName];
    if (!follow) {
        return base;
    }
    const dynamic = Number(follow());
    if (!Number.isFinite(dynamic) || dynamic <= 0) {
        return base;
    }
    return Math.max(base, dynamic);
}

/** 超时错误要带上动作名与毫秒数：模型知道"哪个动作超时、等了多久"才会换个做法。 */
function createActionTimeoutError(actionName, timeoutMs) {
    const error = new Error("动作 " + actionName + " 超时（" + timeoutMs + "ms），已中止等待");
    error.code = "ACTION_TIMEOUT";
    error.action = actionName;
    error.timeoutMs = timeoutMs;
    return error;
}

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
        assertWindowsSafeSegments(filePath);
        // 字符串前缀只能证明"路径看起来在工作区里"。工作区内的一个 junction
        // （mklink /J，pnpm 与 git 仓库里都很常见）会让实际读写落到工作区之外，
        // 所以再按真实路径判一次：目标最近的已存在祖先必须仍在工作区的真实路径内。
        const realRoot = realPathOf(workspace);
        const anchor = nearestExistingPath(fullPath);
        if (realRoot && anchor) {
            const realAnchor = realPathOf(anchor);
            if (realAnchor && !isInsidePath(realRoot, realAnchor)) {
                throw new Error("Path escapes workspace (symlink)");
            }
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
    按 meta.timeoutMs 执行内置动作，超时即中止等待。

    为什么内置动作也需要兜底：插件动作在 plugins/registry/invoke.js 里已经有
    runWithTimeout 强制超时，内置动作却只有 exec 自己靠 child_process 的 timeout
    兜着 —— read / write / answer / done 的 meta.timeoutMs 从来没人读。
    某个动作挂住时（慢盘上的同步 fs、将来新增却忘了设超时的异步动作），
    整轮会一直卡到用户手动点停止。

    三条限制，写在这里免得后面误判：
    1. 同步动作打不断。定时器要等事件循环空出来才会跑，而 read / write 用的是
       fs.*Sync，它占着事件循环时定时器根本没机会触发。这层兜底的真实作用对象
       是异步动作（exec 及其后继）。
    2. 定时器不能 unref：动作挂住而进程里没有别的活跃句柄时，unref 会让 Node
       直接以 exit 0 退出，既不报错也不返回（同 plugins/registry/shared.js）。
    3. 超时后不主动结束子进程。exec 的命令级超时会先一步杀掉 child；这里再
       killAllProcesses 会把模型有意留在后台的服务（exec --background）一起带走。
    */
    async runBuiltinAction(actionName, definition, node) {
        const context = this.createBuiltinContext();
        const timeoutMs = resolveActionTimeout(actionName, definition.meta);
        if (!timeoutMs) {
            return await definition.run(node, context);
        }

        let timer = null;
        const work = Promise.resolve().then(() => definition.run(node, context));
        const deadline = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                logger.warn(
                    "Action timed out:",
                    actionName,
                    "after",
                    timeoutMs + "ms",
                    "(still running processes:",
                    this.processes.activeCount + ")"
                );
                reject(createActionTimeoutError(actionName, timeoutMs));
            }, timeoutMs);
        });
        try {
            // race 同时给 work 与 deadline 挂了结算回调，所以动作在超时之后才
            // 抛错也不会成为 unhandledRejection。
            return await Promise.race([work, deadline]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
    统一的动作分发：内置动作表优先，其次是插件注册表。
    screenshot 自 v1.1.0 起走插件分支，因此这里不再需要区分调用方。
    */
    async invokeActionByName(actionName, node) {
        const definition = getBuiltinAction(actionName);
        if (definition) {
            // 兼容同步/异步 run：await 一个非 Promise 值不会有任何副作用。
            const result = await this.runBuiltinAction(actionName, definition, node);
            // 内置动作同样把"是否改动 workspace"暴露到结果里，
            // 让 Trace / 审计对内置与插件动作口径一致（插件侧在 registry/invoke.js 里加）。
            if (result && typeof result === "object" && !Array.isArray(result)) {
                if (result.mutating === undefined) {
                    result.mutating = definition.meta ? definition.meta.mutating === true : false;
                }
            }
            return result;
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
    // 供单测直接校验超时换算（exec 跟着 maxExecTimeout 走，其余吃 meta 静态值）
    resolveActionTimeout,
    run,
    setWorkspace,
    getWorkspace,
    killAllProcesses,
    listProcesses,
};
