/**
注册表共用的常量与工具函数。
拆出来的各 mixin 都从这里取，避免常量在多处重复定义。
*/

const os = require("os");
const path = require("path");

const sdk = require("../sdk");

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
        if (typeof timer.unref === "function") {
            timer.unref();
        }
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
    runWithTimeout,
};
