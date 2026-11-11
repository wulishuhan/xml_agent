/**
注册表共用的常量与工具函数。
拆出来的各 mixin 都从这里取，避免常量在多处重复定义。
*/

const os = require("os");
const path = require("path");

const sdk = require("../sdk");
// 单向依赖：capabilities 只用内置模块，不会回头 require 注册表
const capabilities = require("../capabilities");

// 本文件在 plugins/registry/ 下，内置插件目录在上一层 plugins/builtin。
const BUILTIN_DIR = path.join(__dirname, "..", "builtin");
const DEFAULT_STORE_ROOT = path.join(os.homedir(), ".xml-agent");
// 插件私有数据放在与"插件安装目录"不同的根下：
// <storeRoot>/plugins/<name>/ 会被 load() 当成待加载插件扫描，
// 若那里只有 data/ 目录，启动时会报一条"缺少 plugin.json"的假故障。
const STORAGE_ROOT = "plugin-data";
const LEGACY_STORAGE_SEGMENT = "data";
const STATE_FILE = "plugins-state.json";
const CONFIG_FILE = "plugins-config.json";
const PERMISSIONS_FILE = "permissions.json";
const SECRETS_FILE = "secrets.json";
const DEFAULT_MAX_PROMPT_CHARS = 8000;
// 插件自定义 HTTP 接口（声明式面板的数据来源）单次执行上限
const DEFAULT_API_TIMEOUT_MS = 15000;
const VALID_POLICIES = ["allow", "deny", "ask"];

function readPackageVersion() {
    try {
        // eslint-disable-next-line global-require
        return require("../../package.json").version || "0.0.0";
    } catch (error) {
        return "0.0.0";
    }
}

function createScopedLogger(logger, pluginName) {
    const prefix = "[plugin:" + pluginName + "]";
    const base = logger || console;
    return {
        debug: (...args) => {
            if (typeof base.debug === "function") {
                base.debug(prefix, ...args);
            }
        },
        info: (...args) => {
            if (typeof base.info === "function") {
                base.info(prefix, ...args);
            }
        },
        warn: (...args) => {
            if (typeof base.warn === "function") {
                base.warn(prefix, ...args);
            }
        },
        error: (...args) => {
            if (typeof base.error === "function") {
                base.error(prefix, ...args);
            }
        },
    };
}

/**
执行 run() 并强制超时。超时会 abort signal，让插件有机会清理（fetch 会销毁请求）。

注意：这里的定时器**不能** unref。
它和普通的后台心跳不同——它是当前这一刻唯一的"进度保证"：一旦 unref，
当插件动作挂住、而进程里又没有别的活跃句柄（CLI 模式下 provider 已释放、
WebUI 请求已断开）时，事件循环空转，Node 会直接以 exit 0 退出：
既不触发超时，也不打印任何错误，调用方永远等不到结果。
*/
function runWithTimeout(factory, timeoutMs, controller) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            const error = sdk.createError("PLUGIN_TIMEOUT", "插件动作超时（" + timeoutMs + "ms）");
            try {
                controller.abort(error);
            } catch (abortError) {
                // ignore
            }
            reject(error);
        }, timeoutMs);
        Promise.resolve()
            .then(factory)
            .then(
                (value) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            );
    });
}

/**
摘要文件的写入口。

为什么要包一层：`ctx.fs` 只能写**当前会话**的 workspace，而会话记忆转移的目标
可能是另一个工作区的会话。真写到别人那儿，模型在新会话里根本 read 不到，
还会在无关目录里留下垃圾 —— 所以工作区不一致时直接抛错，
由 memory-transfer 降级成一条 warning（记录已经搬好，不该因此整体失败）。

两种调用场景，行为不同（这是有意的）：
- 动作路径（Runtime 调插件）：宿主知道"当前工作区"，于是绑定 workspaceFs，
  写入走插件沙箱，继承 Runtime 的越界保护（junction、真实路径都查过）；
  目标会话在别的工作区时拒绝，因为模型在新会话里 read 不到。
- 接口路径（HTTP 面板 / 脚本）：调用时没有"当前工作区"，只能按目标会话自己记录的
  workspace 解析。摘要路径的每一段都由 memory-digest 生成（固定目录 + 已白名单校验的
  会话 id），不含用户可控的穿越片段，因此用只拒绝对路径与 `..` 的轻量解析就够了 ——
  但绝不能让这条路径变成"任意路径写入"，所以这里仍然显式做前缀校验。
*/
function createDigestWriter(options = {}) {
    const boundWorkspace = options.workspace || null;
    const boundFs = options.workspaceFs || null;
    const normalize = (value) =>
        path
            .resolve(String(value || ""))
            .replace(/[\\/]+$/, "")
            .toLowerCase();

    return (relativePath, markdown, meta = {}) => {
        const relative = String(relativePath || "");
        if (!relative) {
            throw new Error("摘要路径为空");
        }
        // 绑定了工作区（动作路径）就必须一致；未绑定（接口路径）时用会话自己记录的那个
        if (
            boundWorkspace &&
            meta.workspace &&
            normalize(meta.workspace) !== normalize(boundWorkspace)
        ) {
            throw new Error(
                "目标会话的工作区（" +
                    meta.workspace +
                    "）与当前工作区（" +
                    boundWorkspace +
                    "）不同"
            );
        }
        if (boundFs) {
            const outcome = boundFs.writeText(relative, markdown, { maxBytes: 1024 * 1024 });
            return { path: outcome.path };
        }
        const targetWorkspace = normalize(meta.workspace || boundWorkspace || "");
        if (!targetWorkspace) {
            throw new Error("不知道摘要该写到哪个工作区（会话没有记录 workspace）");
        }
        const fsForTarget = capabilities.createWorkspaceFs({
            workspace: targetWorkspace,
            resolvePath: createWorkspaceResolver(targetWorkspace),
        });
        const outcome = fsForTarget.writeText(relative, markdown, { maxBytes: 1024 * 1024 });
        return { path: outcome.path };
    };
}

/**
只允许"工作区内的相对路径"的解析器。
刻意比 Runtime.resolvePath 轻：这里没有 Runtime 实例（接口调用不经过 agent 循环），
而调用方（memory-digest）生成的路径分量本身受控。仍然保留前缀校验，
避免以后有人把外部输入接到这里。
*/
function createWorkspaceResolver(workspace) {
    const root = path.resolve(workspace);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return (target) => {
        const text = String(target || "");
        if (!text) {
            throw new Error("路径不能为空");
        }
        if (path.isAbsolute(text)) {
            throw new Error("不允许绝对路径：" + text);
        }
        const full = path.resolve(root, text);
        if (full !== root && !full.startsWith(prefix)) {
            throw new Error("路径逃出工作区：" + text);
        }
        return full;
    };
}

module.exports = {
    BUILTIN_DIR,
    DEFAULT_STORE_ROOT,
    STORAGE_ROOT,
    LEGACY_STORAGE_SEGMENT,
    STATE_FILE,
    CONFIG_FILE,
    PERMISSIONS_FILE,
    SECRETS_FILE,
    DEFAULT_MAX_PROMPT_CHARS,
    DEFAULT_API_TIMEOUT_MS,
    VALID_POLICIES,
    readPackageVersion,
    createScopedLogger,
    createDigestWriter,
    createWorkspaceResolver,
    runWithTimeout,
};
