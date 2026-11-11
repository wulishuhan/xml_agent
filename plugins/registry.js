/**
Plugin Registry

职责（对应 docs/PLUGIN_DESIGN.md §4.6）：
1. 发现：扫描 plugins/builtin/* 与 ~/.xml-agent/plugins/*；
2. 校验：plugin.json、apiVersion、engines、权限声明、动作名冲突；
3. 加载：调用 setup(ctx)，收集注册项（staging），成功后才提交到全局目录；
4. 隔离：单个插件失败只标记 status:"error"，不影响其它插件与内置动作；
5. 执行：权限检查 → schema 校验 → 超时/取消 → run() → afterRun → 调用记录；
6. 持久化：plugins-state.json（启停）、plugins-config.json（配置）、permissions.json（授权）。

本模块不 require runtime / agent-core / xml-parse，避免循环依赖；
Runtime 在调用时把 workspace 与 resolvePath 通过 host 参数传进来。
*/

const path = require("path");

// 这个类曾经有 1300 行，按职责拆到 registry/ 下后以 mixin 挂回原型：
// 本文件只保留实例状态与构造，具体能力见各文件头部说明。
const mixins = [
    require("./registry/api"),
    require("./registry/catalog"),
    require("./registry/context"),
    require("./registry/invoke"),
    require("./registry/loader"),
    require("./registry/present"),
    require("./registry/settings"),
    require("./registry/storage"),
];

const {
    BUILTIN_DIR,
    DEFAULT_STORE_ROOT,
    DEFAULT_MAX_PROMPT_CHARS,
    DEFAULT_API_TIMEOUT_MS,
    STATE_FILE,
    CONFIG_FILE,
    PERMISSIONS_FILE,
    SECRETS_FILE,
    VALID_POLICIES,
    readPackageVersion,
} = require("./registry/shared");

class PluginRegistry {
    constructor(options = {}) {
        this.storeRoot = options.storeRoot || DEFAULT_STORE_ROOT;
        this.builtinDir = options.builtinDir || BUILTIN_DIR;
        this.extraDirs = Array.isArray(options.dirs) ? options.dirs.filter(Boolean) : [];
        this.agentVersion = options.agentVersion || readPackageVersion();
        this.enabled = options.enabled !== false;
        this.logger = options.logger || console;
        // 插件接口的单次执行上限：handler 永不 resolve 时不能挂死 HTTP 连接
        this.apiTimeoutMs =
            Number.isFinite(Number(options.apiTimeoutMs)) && Number(options.apiTimeoutMs) > 0
                ? Math.trunc(Number(options.apiTimeoutMs))
                : DEFAULT_API_TIMEOUT_MS;
        this.maxPromptChars =
            Number.isFinite(Number(options.maxPromptChars)) && Number(options.maxPromptChars) > 0
                ? Math.trunc(Number(options.maxPromptChars))
                : DEFAULT_MAX_PROMPT_CHARS;
        this.loaded = false;
        this.plugins = new Map();
        this.actions = new Map();
        this.hooks = new Map();
        this.providers = new Map();
        this.eventFormatters = new Map();
        // 状态/配置/权限/密钥文件的读取缓存（按 mtime + size 失效，见 registry/storage.js）
        this._fileCache = new Map();
        this.ui = { panels: [], settings: [], actions: [] };
        this.errors = [];
        // 宿主注入的服务：WebUI 启动后把 SessionManager 放进来，插件才能通过
        // ctx.sessions 读写会话记忆（CLI 模式下为空，插件退化为只操作磁盘）。
        this.hostSessions = null;
    }

    /** 注入会话管理器（WebUI 启动时调用；不注入不算错误，只是能力受限）。 */
    setHostSessions(manager) {
        this.hostSessions = manager || null;
        return this;
    }

    get userDirs() {
        return [path.join(this.storeRoot, "plugins")].concat(this.extraDirs);
    }
}

for (const mixin of mixins) {
    Object.assign(PluginRegistry.prototype, mixin);
}

let singleton = null;

function defaultOptions() {
    let pluginConfig = {};
    try {
        // eslint-disable-next-line global-require
        pluginConfig = require("../config/agent-config").plugins || {};
    } catch (error) {
        pluginConfig = {};
    }
    const env = process.env;
    let enabled = pluginConfig.enabled !== false;
    if (env.XML_AGENT_PLUGINS !== undefined) {
        enabled =
            ["0", "false", "off", "no"].indexOf(String(env.XML_AGENT_PLUGINS).toLowerCase()) === -1;
    }
    const dirs = [];
    if (Array.isArray(pluginConfig.dirs)) {
        dirs.push(...pluginConfig.dirs.filter(Boolean));
    }
    if (env.XML_AGENT_PLUGIN_DIRS) {
        dirs.push(
            ...String(env.XML_AGENT_PLUGIN_DIRS)
                .split(path.delimiter)
                .map((item) => item.trim())
                .filter(Boolean)
        );
    }
    return {
        enabled,
        storeRoot: pluginConfig.storeRoot || DEFAULT_STORE_ROOT,
        dirs,
        maxPromptChars: pluginConfig.maxPromptChars,
        apiTimeoutMs: pluginConfig.apiTimeoutMs,
    };
}

function createRegistry(options = {}) {
    return new PluginRegistry(options);
}

function getRegistry() {
    if (!singleton) {
        const registry = createRegistry(defaultOptions());
        registry.load();
        singleton = registry;
    }
    return singleton;
}

/**
安全取单例：插件系统出任何意外都不能让 Agent 主流程崩掉。
*/
function getRegistrySafe() {
    try {
        return getRegistry();
    } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
            console.warn("[plugins] registry 初始化失败：" + ((error && error.message) || error));
        }
        return null;
    }
}

function resetRegistry() {
    singleton = null;
}

function setRegistryForTests(registry) {
    singleton = registry;
}

module.exports = {
    PluginRegistry,
    createRegistry,
    getRegistry,
    getRegistrySafe,
    resetRegistry,
    setRegistryForTests,
    defaultOptions,
    BUILTIN_DIR,
    DEFAULT_STORE_ROOT,
    DEFAULT_MAX_PROMPT_CHARS,
    STATE_FILE,
    CONFIG_FILE,
    PERMISSIONS_FILE,
    SECRETS_FILE,
    VALID_POLICIES,
};
