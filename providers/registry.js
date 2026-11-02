/**
Provider 注册表与契约

在此之前，"有哪些模型后端"这件事散落在四处：
- `providers/index.js` 的硬编码映射表；
- `config/agent-config.js` 的 `browser.targetUrls`（访问地址）；
- `webui/server.js` 与 `webui/frontend/src/services/agent-api.js` 各自写的
  "URL → conversationId" 正则（而且两处不一致：GLM 的 `/s/<id>` 只有 provider 自己认识）；
- 前端 `App.vue` 里硬编码的 4 个 `<option>`。

本模块把它们收敛成"provider 定义"：元数据（id / 显示名 / 默认地址 / 会话 id 正则 /
是否支持图片）+ 工厂函数。于是：
- `createProvider(name, options)` 只查表；
- 新增一个 provider（内置或插件）不需要改 server / 前端 / config；
- 会话 id 解析用 provider 自己声明的正则 —— 谁最懂自己的 URL，谁声明。

内置 provider 的元数据放在各自的模块里导出（`module.exports.meta`），
插件 provider 由 `plugins/registry.js` 的 `ctx.providers.register(name, factory, meta)` 收集。
*/

// 未声明正则时的兜底（保持 1.0.x 行为：非 deepseek 一律按 /c/<id> 解析）。
const DEFAULT_CONVERSATION_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");

// 真实 provider 至少要能 start / send / close；uploadImages 可选。
const REQUIRED_METHODS = ["start", "send", "close"];
const OPTIONAL_METHODS = ["uploadImages", "getConversationIdFromUrl", "ensurePageAlive"];

function contractError(message) {
    const error = new Error(message);
    error.code = "PROVIDER_CONTRACT";
    return error;
}

// ------------------------------------------------------------
// 定义归一化
// ------------------------------------------------------------

function toPattern(value) {
    if (value instanceof RegExp) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        try {
            return new RegExp(value.trim());
        } catch (error) {
            return null;
        }
    }
    return null;
}

/**
归一化一个 provider 定义（内置与插件共用同一套规则）。
*/
function normalizeDefinition(raw, options = {}) {
    const name = options.name || (raw && raw.id) || "";
    if (!raw || typeof raw !== "object") {
        throw contractError("provider 定义必须是对象：" + String(name));
    }
    const id = String(raw.id || options.name || "")
        .trim()
        .toLowerCase();
    if (!/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/.test(id)) {
        throw contractError("provider id 非法：" + JSON.stringify(id));
    }
    const create = raw.create || raw.factory;
    if (typeof create !== "function") {
        throw contractError("provider " + id + " 缺少 create(options) 工厂函数");
    }
    return {
        id,
        label: String(raw.label || raw.name || id),
        defaultTargetUrl: String(raw.defaultTargetUrl || raw.targetUrl || ""),
        conversationIdPattern: toPattern(raw.conversationIdPattern),
        supportsImages: raw.supportsImages !== false,
        source: options.source || raw.source || "builtin",
        plugin: raw.plugin || null,
        create,
    };
}

// ------------------------------------------------------------
// 契约校验
// ------------------------------------------------------------

/**
校验一个 provider 实例是否符合契约。返回缺失的方法名数组（空数组表示符合）。
*/
function findMissingMethods(instance) {
    if (!instance || typeof instance !== "object") {
        return REQUIRED_METHODS.slice();
    }
    return REQUIRED_METHODS.filter((name) => typeof instance[name] !== "function");
}

/**
不符合契约直接抛错，并给出可读的缺失清单。
*/
function assertProviderInstance(instance, id) {
    const missing = findMissingMethods(instance);
    if (missing.length > 0) {
        throw contractError(
            "provider " + (id || "") + " 不符合契约，缺少方法：" + missing.join(", ")
        );
    }
    return instance;
}

/**
校验一个类/工厂：要求其原型（或产出结果）具备必需方法。
用于注册期尽早失败，而不是等 Agent 跑到一半才炸。
*/
function assertProviderFactory(factory, id) {
    if (typeof factory !== "function") {
        throw contractError("provider " + (id || "") + " 的工厂必须是函数");
    }
    const prototype = factory.prototype;
    if (prototype && typeof prototype === "object") {
        const missing = REQUIRED_METHODS.filter((name) => typeof prototype[name] !== "function");
        if (missing.length > 0) {
            throw contractError(
                "provider " + (id || "") + " 的类不符合契约，缺少方法：" + missing.join(", ")
            );
        }
    }
    return factory;
}

// ------------------------------------------------------------
// 内置 provider
// ------------------------------------------------------------

const BUILTIN_DEFINITIONS = [
    // 顺序即前端下拉框顺序（也是 /api/providers 的 defaultId），与 1.0.x 的排列保持一致。
    // 每个 provider 模块自己导出 meta（含默认访问地址与会话 id 正则）。
    require("./chatgpt"),
    require("./qwen"),
    require("./deepseek"),
    require("./glm"),
].map((module, index) => {
    const meta = module.meta;
    if (!meta) {
        throw contractError("内置 provider 模块缺少 meta 导出（index " + index + "）");
    }
    return normalizeDefinition(meta, { source: "builtin" });
});

const builtinMap = new Map();
for (const definition of BUILTIN_DEFINITIONS) {
    if (builtinMap.has(definition.id)) {
        throw contractError("内置 provider id 重复：" + definition.id);
    }
    builtinMap.set(definition.id, definition);
}

// ------------------------------------------------------------
// 插件 provider（延迟读取，避免与 plugins/registry 形成循环依赖）
// ------------------------------------------------------------

let pluginRegistryResolver = null;

function getPluginProviderMap() {
    if (pluginRegistryResolver === null) {
        try {
            // eslint-disable-next-line global-require
            pluginRegistryResolver = require("../plugins/registry").getRegistrySafe;
        } catch (error) {
            pluginRegistryResolver = false;
        }
    }
    if (!pluginRegistryResolver) {
        return new Map();
    }
    try {
        const registry = pluginRegistryResolver();
        return (registry && registry.providers) || new Map();
    } catch (error) {
        return new Map();
    }
}

function listPluginDefinitions() {
    const result = [];
    for (const entry of getPluginProviderMap().values()) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        if (builtinMap.has(entry.name)) {
            // 插件不允许覆盖内置 provider（加载期插件侧已拦截，这里再兜一层）
            continue;
        }
        try {
            result.push(
                normalizeDefinition(
                    Object.assign({ id: entry.name }, entry.meta || {}, {
                        create: entry.factory,
                        plugin: entry.plugin,
                    }),
                    { name: entry.name, source: "plugin" }
                )
            );
        } catch (error) {
            // 单个插件 provider 定义非法不影响其它 provider
        }
    }
    return result;
}

// ------------------------------------------------------------
// 查询与创建
// ------------------------------------------------------------

function get(id) {
    const name = String(id || "")
        .trim()
        .toLowerCase();
    if (!name) {
        return null;
    }
    if (builtinMap.has(name)) {
        return builtinMap.get(name);
    }
    const pluginDefinition = listPluginDefinitions().filter((item) => item.id === name)[0];
    return pluginDefinition || null;
}

/**
列出全部 provider（内置优先，插件在后）。
conversationIdPattern 以字符串形式给出，便于直接 JSON 化给前端。
*/
function list() {
    const all = Array.from(builtinMap.values()).concat(listPluginDefinitions());
    return all.map((definition) => ({
        id: definition.id,
        label: definition.label,
        defaultTargetUrl: definition.defaultTargetUrl,
        supportsImages: definition.supportsImages,
        source: definition.source,
        plugin: definition.plugin,
        conversationIdPattern: definition.conversationIdPattern
            ? definition.conversationIdPattern.source
            : null,
    }));
}

function listIds() {
    return Array.from(builtinMap.keys());
}

/**
创建 provider 实例。未知 id 抛错（与迁移前 createProvider 的行为一致）。
*/
function create(name, options = {}) {
    const definition = get(name);
    if (!definition) {
        throw new Error("Unknown provider: " + name);
    }
    const instance = definition.create(options);
    return assertProviderInstance(instance, definition.id);
}

/**
解析 provider 的访问地址：用户配置覆盖优先，其次是 provider 自己声明的默认地址。
*/
function resolveTargetUrl(id, overrides) {
    const definition = get(id);
    const override = overrides && id ? overrides[id] : undefined;
    if (typeof override === "string" && override.trim()) {
        return override.trim();
    }
    return definition ? definition.defaultTargetUrl : "";
}

/**
把用户输入（纯 id 或完整会话 URL）规范化为 conversationId。
- 非 URL 形式：原样返回（视为纯 id）；
- URL 形式：用该 provider 声明的正则提取，取不到返回 null（表示新会话）。
*/
function normalizeConversationId(providerId, raw) {
    if (raw === undefined || raw === null) {
        return null;
    }
    const trimmed = String(raw).trim();
    if (!trimmed) {
        return null;
    }
    const looksLikeUrl =
        trimmed.indexOf("http://") === 0 ||
        trimmed.indexOf("https://") === 0 ||
        trimmed.indexOf("/") !== -1;
    if (!looksLikeUrl) {
        return trimmed;
    }
    const definition = get(providerId);
    const pattern =
        (definition && definition.conversationIdPattern) || DEFAULT_CONVERSATION_PATTERN;
    const match = trimmed.match(pattern);
    return match ? match[1] : null;
}

module.exports = {
    DEFAULT_CONVERSATION_PATTERN,
    REQUIRED_METHODS,
    OPTIONAL_METHODS,
    normalizeDefinition,
    findMissingMethods,
    assertProviderInstance,
    assertProviderFactory,
    get,
    list,
    listIds,
    create,
    resolveTargetUrl,
    normalizeConversationId,
};
