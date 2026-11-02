/**
配置单一来源（single source of truth）

问题背景：同一批默认值/环境变量名此前散落在多处，已经产生了实际漂移——
- `config/agent-config.js` 里 `browser.browserType` 默认是 edge（2024 年的一次提交），
  而 `electron/settings.js` / `webui/browser-settings.js` 的"浏览器设置"默认是 chrome；
- agent/runtime/session 三段默认值在 `config/agent-config.js` 与 `webui/agent-config-api.js`
  各写一遍，改了前者设置面板不会跟着变；
- `DEFAULT_CDP_URLS` 在 `electron/settings.js` 与 `webui/browser-settings.js` 各写一遍；
- 每个环境变量名至少在两处出现（本文件与 agent-config-api 的 applyToRuntime）。

本模块把它们收敛到一处：
- FIELDS：字段声明（默认值 / 类型 / 校验 / 环境变量名 / 错误文案）
- buildConfig(env)：默认值 + 环境变量覆盖 + 校验（agent-config.js 只是它的投影）
- validatePartial(partial)：设置面板用的"只校验传入字段"
- exportEnv(config, env)：applyToRuntime 用，把配置写回同名环境变量
- 浏览器设置相关：DEFAULT_CDP_URLS / normalizeBrowserSettings / resolveCdpUrl 等
  （桌面版 settings.json 与 Web 版 webui-browser.json 共用）

本模块不 require 任何项目内模块，纯函数，便于单测。
*/

const path = require("path");

// ------------------------------------------------------------
// 浏览器类型与 CDP 默认端口
// ------------------------------------------------------------

const BROWSER_TYPES = ["chrome", "edge"];

// Chrome / Edge 各用独立端口，避免互相占用。
const DEFAULT_CDP_URLS = Object.freeze({
    chrome: "http://127.0.0.1:9222",
    edge: "http://127.0.0.1:9223",
});

const DEFAULT_TARGET_URLS = Object.freeze({});
// provider 的默认访问地址现在由各自模块声明（providers/<name>.js 的 meta.targetUrl），
// 这里的 browser.targetUrls 只作为"用户覆盖表"（留空表示全部使用 provider 默认值）。

// 默认浏览器类型：edge（用户可在设置里切换为 chrome）。
// 运行期兜底（CLI 直接跑）与桌面版/Web 版的"浏览器设置"默认值都取这一个常量，
// 因此不会再出现"config 默认 edge、设置面板默认 chrome"那种分裂。
const DEFAULT_BROWSER_TYPE = "edge";

function normalizeBrowserType(value) {
    const text = String(value || "")
        .trim()
        .toLowerCase();
    if (text === "edge" || text === "msedge" || text === "microsoft-edge") {
        return "edge";
    }
    return "chrome";
}

// ------------------------------------------------------------
// 字段声明
// ------------------------------------------------------------

const INT = "int";
const FLOAT = "float";
const BOOL = "bool";
const STRING = "string";
const BROWSER_TYPE = "browserType";
const ANY = "any";

/**
字段声明：
- path      嵌套路径（a.b）
- default   默认值
- type      int / float / bool / string / browserType / any
- env       可覆盖它的环境变量（数组表示按顺序应用，后者优先）
- min/max   数值范围
- message   校验失败文案（设置面板直接展示，保持原文）
- parseEnv  自定义环境变量解析（返回 undefined 表示忽略该值）
*/
const FIELDS = [
    {
        path: "agent.maxSteps",
        default: 100,
        type: INT,
        min: 1,
        env: ["AGENT_MAX_STEPS"],
        message: "agent.maxSteps must be a positive integer",
    },
    {
        path: "agent.maxProviderErrors",
        default: 3,
        type: INT,
        min: 1,
        env: ["AGENT_MAX_PROVIDER_ERRORS"],
        message: "agent.maxProviderErrors must be a positive integer",
    },
    {
        path: "runtime.maxFileSize",
        default: 5 * 1024 * 1024,
        type: INT,
        min: 1,
        env: ["RUNTIME_MAX_FILE_SIZE"],
        message: "runtime.maxFileSize must be a positive integer",
    },
    {
        path: "runtime.maxReadSize",
        default: 2 * 1024 * 1024,
        type: INT,
        min: 1,
        env: ["RUNTIME_MAX_READ_SIZE"],
        message: "runtime.maxReadSize must be a positive integer",
    },
    {
        path: "runtime.maxExecTimeout",
        default: 300000,
        type: INT,
        min: 1,
        env: ["RUNTIME_MAX_EXEC_TIMEOUT"],
        message: "runtime.maxExecTimeout must be a positive integer",
    },
    {
        path: "runtime.maxExecOutputSize",
        default: 1024 * 1024,
        type: INT,
        min: 1,
        env: ["RUNTIME_MAX_EXEC_OUTPUT_SIZE"],
        message: "runtime.maxExecOutputSize must be a positive integer",
    },
    {
        // 会话记录存 ~/.xml-agent/webui-sessions/<id>.json，达到上限需先删除旧会话。
        path: "session.maxSessions",
        default: 100,
        type: INT,
        min: 1,
        env: ["WEBUI_MAX_SESSIONS"],
        message: "session.maxSessions must be a positive integer",
    },
    {
        path: "session.maxDiskBytes",
        default: 200 * 1024 * 1024,
        type: INT,
        min: 1,
        env: ["WEBUI_MAX_DISK_BYTES"],
        message: "session.maxDiskBytes must be a positive integer",
    },
    {
        // 达到该比例时前端提示用户清理。
        path: "session.warnThreshold",
        default: 0.8,
        type: FLOAT,
        exclusiveMin: 0,
        max: 1,
        env: ["WEBUI_WARN_THRESHOLD"],
        message: "session.warnThreshold must be a number in (0, 1]",
    },
    {
        path: "plugins.enabled",
        default: true,
        type: BOOL,
        env: ["XML_AGENT_PLUGINS"],
        parseEnv(raw) {
            const text = String(raw || "")
                .trim()
                .toLowerCase();
            return ["0", "false", "off", "no"].indexOf(text) === -1;
        },
        message: "plugins.enabled must be a boolean",
    },
    {
        // 插件动作文档注入首轮提示词的字符预算。
        path: "plugins.maxPromptChars",
        default: 8000,
        type: INT,
        min: 1,
        env: ["XML_AGENT_PLUGIN_MAX_PROMPT_CHARS"],
        message: "plugins.maxPromptChars must be a positive integer",
    },
    {
        // 额外插件目录；XML_AGENT_PLUGIN_DIRS（path.delimiter 分隔）由 registry 追加。
        path: "plugins.dirs",
        default: [],
        type: ANY,
        message: "plugins.dirs must be an array",
    },
    {
        // 插件状态/配置/权限的存储根目录，留空表示 ~/.xml-agent。
        path: "plugins.storeRoot",
        default: "",
        type: STRING,
        env: ["XML_AGENT_STORE_ROOT"],
        message: "plugins.storeRoot must be a string",
    },
    {
        path: "browser.autoStart",
        default: true,
        type: BOOL,
        env: ["BROWSER_AUTO_START"],
        message: "browser.autoStart must be a boolean",
    },
    {
        path: "browser.startTimeout",
        default: 30000,
        type: INT,
        min: 1,
        env: ["BROWSER_START_TIMEOUT"],
        message: "browser.startTimeout must be a positive number",
    },
    {
        path: "browser.retryInterval",
        default: 1000,
        type: INT,
        min: 1,
        env: ["BROWSER_RETRY_INTERVAL"],
        message: "browser.retryInterval must be a positive number",
    },
    {
        path: "browser.cdpUrl",
        // 跟随默认浏览器类型：默认 edge 时回退到 Edge 的独立端口，避免默认浏览器与端口错位。
        default: DEFAULT_CDP_URLS[DEFAULT_BROWSER_TYPE],
        type: STRING,
        env: ["BROWSER_CDP_URL"],
        message: "browser.cdpUrl must be a string",
    },
    {
        path: "browser.browserType",
        default: DEFAULT_BROWSER_TYPE,
        type: BROWSER_TYPE,
        // 后者优先：桌面版/Web 版按所选浏览器写 XML_AGENT_BROWSER_TYPE。
        env: ["BROWSER_TYPE", "XML_AGENT_BROWSER_TYPE"],
        message: "browser.browserType must be 'chrome' or 'edge'",
    },
    {
        path: "browser.chromePath",
        default: "",
        type: STRING,
        env: ["BROWSER_CHROME_PATH"],
        message: "browser.chromePath must be a string",
    },
    {
        path: "browser.edgePath",
        default: "",
        type: STRING,
        env: ["BROWSER_EDGE_PATH"],
        message: "browser.edgePath must be a string",
    },
    {
        path: "browser.reuseExistingPage",
        default: false,
        type: BOOL,
        env: ["BROWSER_REUSE_PAGE"],
        message: "browser.reuseExistingPage must be a boolean",
    },
    {
        path: "browser.focusCdpPage",
        default: true,
        type: BOOL,
        env: ["BROWSER_FOCUS_CDP_PAGE"],
        message: "browser.focusCdpPage must be a boolean",
    },
    {
        path: "browser.targetUrls",
        default: DEFAULT_TARGET_URLS,
        type: ANY,
        message: "browser.targetUrls must be an object",
    },
    {
        path: "browser.headless",
        default: false,
        type: BOOL,
        env: ["BROWSER_HEADLESS"],
        message: "browser.headless must be a boolean",
    },
];

// 设置面板（/api/agent/config）只管理这三块，浏览器与插件配置各有专门入口。
const UI_BLOCKS = ["agent", "runtime", "session"];

// ------------------------------------------------------------
// 路径读写
// ------------------------------------------------------------

function getPath(target, dottedPath) {
    const parts = String(dottedPath).split(".");
    let current = target;
    for (const part of parts) {
        if (!current || typeof current !== "object") {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

function setPath(target, dottedPath, value) {
    const parts = String(dottedPath).split(".");
    let current = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        if (!current[part] || typeof current[part] !== "object") {
            current[part] = {};
        }
        current = current[part];
    }
    current[parts[parts.length - 1]] = value;
    return target;
}

function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.slice();
    }
    if (value && typeof value === "object") {
        return JSON.parse(JSON.stringify(value));
    }
    return value;
}

// ------------------------------------------------------------
// 默认值
// ------------------------------------------------------------

/**
组装默认配置（每次返回全新对象，调用方可以随意修改）。
*/
function buildDefaults() {
    const config = {};
    for (const field of FIELDS) {
        setPath(config, field.path, cloneValue(field.default));
    }
    return config;
}

/**
设置面板用的默认值（只含 agent / runtime / session 三块）。
*/
function defaultsForUI() {
    const defaults = buildDefaults();
    const result = {};
    for (const block of UI_BLOCKS) {
        result[block] = cloneValue(defaults[block] || {});
    }
    return result;
}

function listFields() {
    return FIELDS.slice();
}

function listEnvFields() {
    return FIELDS.filter((field) => Array.isArray(field.env) && field.env.length > 0);
}

// ------------------------------------------------------------
// 环境变量
// ------------------------------------------------------------

function parseBooleanEnv(raw) {
    const text = String(raw || "")
        .trim()
        .toLowerCase();
    if (text === "true" || text === "1") {
        return true;
    }
    if (text === "false" || text === "0") {
        return false;
    }
    return undefined;
}

/**
把环境变量解析成字段值。返回 undefined 表示"非法或空 → 保留默认值"
（与迁移前的行为一致：非法环境变量被静默忽略）。
*/
function parseEnvValue(field, raw) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof field.parseEnv === "function") {
        return field.parseEnv(raw);
    }
    if (field.type === INT) {
        const value = parseInt(raw, 10);
        if (isNaN(value)) {
            return undefined;
        }
        if (field.min !== undefined && value < field.min) {
            return undefined;
        }
        if (field.max !== undefined && value > field.max) {
            return undefined;
        }
        return value;
    }
    if (field.type === FLOAT) {
        const value = parseFloat(raw);
        if (isNaN(value)) {
            return undefined;
        }
        if (field.exclusiveMin !== undefined && value <= field.exclusiveMin) {
            return undefined;
        }
        if (field.min !== undefined && value < field.min) {
            return undefined;
        }
        if (field.max !== undefined && value > field.max) {
            return undefined;
        }
        return value;
    }
    if (field.type === BOOL) {
        const value = parseBooleanEnv(raw);
        return value === undefined ? undefined : value;
    }
    if (field.type === BROWSER_TYPE) {
        return normalizeBrowserType(raw);
    }
    if (typeof raw === "string" && raw !== "") {
        return raw;
    }
    return undefined;
}

/**
就地应用环境变量覆盖。同一字段的多个环境变量按声明顺序应用（后者优先）。
*/
function applyEnvOverrides(config, env) {
    const source = env || {};
    for (const field of listEnvFields()) {
        for (const name of field.env) {
            const value = parseEnvValue(field, source[name]);
            if (value !== undefined) {
                setPath(config, field.path, value);
            }
        }
    }
    return config;
}

/**
把"用户提供的配置片段"应用到一个活配置对象（通常是 agentConfig 单例），
可选同时写回同名环境变量。

只处理**实际出现**的字段，因此不会用默认值覆盖用户显式设置的环境变量
（与迁移前的 applyToRuntime 语义一致）。返回被应用的字段路径列表。
*/
function applyProvided(config, options = {}) {
    const target = options.target && typeof options.target === "object" ? options.target : {};
    const env = options.env;
    const applied = [];
    if (!config || typeof config !== "object") {
        return applied;
    }
    for (const field of FIELDS) {
        if (UI_BLOCKS.indexOf(field.path.split(".")[0]) === -1) {
            continue;
        }
        const value = getPath(config, field.path);
        if (value === undefined || value === null) {
            continue;
        }
        setPath(target, field.path, value);
        if (env && Array.isArray(field.env) && field.env.length > 0) {
            env[field.env[0]] = String(value);
        }
        applied.push(field.path);
    }
    return applied;
}

// ------------------------------------------------------------
// 校验
// ------------------------------------------------------------

function validateValue(field, value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (field.type === INT) {
        const number = Number(value);
        if (!Number.isInteger(number)) {
            return field.message;
        }
        if (field.min !== undefined && number < field.min) {
            return field.message;
        }
        if (field.max !== undefined && number > field.max) {
            return field.message;
        }
        return null;
    }
    if (field.type === FLOAT) {
        const number = Number(value);
        if (isNaN(number)) {
            return field.message;
        }
        if (field.exclusiveMin !== undefined && number <= field.exclusiveMin) {
            return field.message;
        }
        if (field.min !== undefined && number < field.min) {
            return field.message;
        }
        if (field.max !== undefined && number > field.max) {
            return field.message;
        }
        return null;
    }
    if (field.type === BOOL) {
        return typeof value === "boolean" ? null : field.message;
    }
    if (field.type === BROWSER_TYPE) {
        return BROWSER_TYPES.indexOf(value) === -1 ? field.message : null;
    }
    if (field.type === STRING) {
        return typeof value === "string" ? null : field.message;
    }
    if (field.type === ANY) {
        if (field.path === "plugins.dirs" && !Array.isArray(value)) {
            return field.message;
        }
        if (
            field.path === "browser.targetUrls" &&
            (!value || typeof value !== "object" || Array.isArray(value))
        ) {
            return field.message;
        }
        return null;
    }
    return null;
}

/**
全量校验：返回错误数组（空数组表示通过）。
*/
function validateConfig(config) {
    const errors = [];
    if (!config || typeof config !== "object") {
        return ["Invalid config object"];
    }
    for (const field of FIELDS) {
        const error = validateValue(field, getPath(config, field.path));
        if (error) {
            errors.push(error);
        }
    }
    return errors;
}

/**
部分校验：只校验传入配置里实际存在的字段，供设置面板使用。
*/
function validatePartial(partial) {
    const errors = [];
    if (!partial || typeof partial !== "object") {
        return ["Invalid config object"];
    }
    for (const field of FIELDS) {
        if (UI_BLOCKS.indexOf(field.path.split(".")[0]) === -1) {
            continue;
        }
        const value = getPath(partial, field.path);
        if (value === undefined) {
            continue;
        }
        const error = validateValue(field, value);
        if (error) {
            errors.push(error);
        }
    }
    return errors;
}

/**
构建运行期配置：默认值 + 环境变量覆盖 + 校验（校验失败直接抛错，与迁移前一致）。
*/
function buildConfig(env) {
    const config = applyEnvOverrides(buildDefaults(), env);
    const errors = validateConfig(config);
    if (errors.length > 0) {
        const error = new Error(errors[0]);
        error.errors = errors;
        throw error;
    }
    return config;
}

// ------------------------------------------------------------
// 浏览器设置（桌面版 settings.json 与 Web 版 webui-browser.json 共用）
// ------------------------------------------------------------

function normalizeCdpUrl(value, fallback) {
    if (typeof value !== "string" || !value.trim()) {
        return fallback;
    }
    const trimmed = value.trim();
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return fallback;
        }
        return trimmed;
    } catch (error) {
        return fallback;
    }
}

function normalizeBoolean(value, defaultValue) {
    if (value === undefined || value === null) {
        return defaultValue;
    }
    if (typeof value === "boolean") {
        return value;
    }
    const text = String(value).trim().toLowerCase();
    if (text === "true" || text === "1") {
        return true;
    }
    if (text === "false" || text === "0") {
        return false;
    }
    return defaultValue;
}

/**
构造 cdpUrls：
- 显式提供 cdpUrls 时逐字段合并到默认端口之上；
- 否则若存在旧字段 cdpUrl，把它视为"当前所选浏览器类型"的端口（迁移）；
- 其余情况使用默认端口。
*/
function buildCdpUrls(rawSettings, browserType) {
    const raw = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
    const provided = raw.cdpUrls && typeof raw.cdpUrls === "object" ? raw.cdpUrls : null;
    const urls = {
        chrome: DEFAULT_CDP_URLS.chrome,
        edge: DEFAULT_CDP_URLS.edge,
    };
    if (provided) {
        urls.chrome = normalizeCdpUrl(provided.chrome, DEFAULT_CDP_URLS.chrome);
        urls.edge = normalizeCdpUrl(provided.edge, DEFAULT_CDP_URLS.edge);
        return urls;
    }
    const legacy = normalizeCdpUrl(raw.cdpUrl, "");
    if (legacy) {
        urls[browserType] = legacy;
    }
    return urls;
}

/**
浏览器设置文件的默认值（桌面版会在此基础上补 focusCdpPage）。
*/
function browserSettingsDefaults() {
    return {
        browserType: DEFAULT_BROWSER_TYPE,
        chromePath: "",
        cdpUrls: {
            chrome: DEFAULT_CDP_URLS.chrome,
            edge: DEFAULT_CDP_URLS.edge,
        },
        cdpUrl: DEFAULT_CDP_URLS[DEFAULT_BROWSER_TYPE],
        autoStartChrome: true,
        headless: false,
    };
}

/**
归一化浏览器设置（桌面版与 Web 版共用；字段完全一致的那部分）。
*/
function normalizeBrowserSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const browserType = normalizeBrowserType(source.browserType || DEFAULT_BROWSER_TYPE);
    const cdpUrls = buildCdpUrls(source, browserType);
    return {
        browserType,
        chromePath: typeof source.chromePath === "string" ? source.chromePath : "",
        cdpUrls,
        // cdpUrl 始终反映当前所选浏览器类型的端口，供旧代码读取。
        cdpUrl: cdpUrls[browserType],
        autoStartChrome: normalizeBoolean(source.autoStartChrome, true),
        headless: normalizeBoolean(source.headless, false),
    };
}

/**
解析指定浏览器类型的 CDP URL：优先 cdpUrls[type]，缺失时回退该类型的默认端口。
*/
function resolveCdpUrl(settings, browserType) {
    const type = normalizeBrowserType(browserType);
    const urls = settings && settings.cdpUrls ? settings.cdpUrls : {};
    return normalizeCdpUrl(urls[type], DEFAULT_CDP_URLS[type]);
}

function getProfileDirName(browserType) {
    return normalizeBrowserType(browserType) === "edge"
        ? "edge-agent-profile"
        : "chrome-agent-profile";
}

function getPluginDirsEnv(env) {
    const raw = (env || {}).XML_AGENT_PLUGIN_DIRS;
    if (!raw) {
        return [];
    }
    return String(raw)
        .split(path.delimiter)
        .map((item) => item.trim())
        .filter(Boolean);
}

module.exports = {
    BROWSER_TYPES,
    DEFAULT_BROWSER_TYPE,
    DEFAULT_CDP_URLS,
    DEFAULT_TARGET_URLS,
    UI_BLOCKS,
    FIELDS,
    getPath,
    setPath,
    buildDefaults,
    defaultsForUI,
    listFields,
    listEnvFields,
    applyEnvOverrides,
    applyProvided,
    validateConfig,
    validatePartial,
    validateValue,
    buildConfig,
    normalizeBrowserType,
    normalizeCdpUrl,
    normalizeBoolean,
    buildCdpUrls,
    browserSettingsDefaults,
    normalizeBrowserSettings,
    resolveCdpUrl,
    getProfileDirName,
    getPluginDirsEnv,
};
