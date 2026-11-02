/**
XML Action 协议解析层

职责收敛为"协议"本身：
- 清洗模型回复（去掉 markdown 围栏）；
- 交给快速解析器或通用 XML 解析器；
- 校验委托给动作表（内置动作 → actions/，插件动作 → plugins/registry）。

动作的具体校验规则不再写在本文件里。为了保持 1.1.0 的公开面，
tryExtractWriteManually / tryExtractScreenshotManually / normalizeScreenshotTargets / ACTION_NAMES
仍然从这里导出，但实现已上提到各自的动作定义（meta.fastPath）。
*/

const { XMLParser } = require("fast-xml-parser");
const { getText } = require("./xml-text");
const { FENCE } = require("./xml-chars");

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: false,
});

// ------------------------------------------------------------
// 惰性依赖：actions / plugins 都不能在模块加载期 require，
// 否则 actions → parse/xml-parse → actions 会形成循环依赖。
// ------------------------------------------------------------

let builtinActionsModule = null;

function getBuiltinActionsApi() {
    if (builtinActionsModule === null) {
        try {
            // eslint-disable-next-line global-require
            builtinActionsModule = require("../actions");
        } catch (error) {
            builtinActionsModule = false;
        }
    }
    return builtinActionsModule || null;
}

function getBuiltinActionDefinition(name) {
    const api = getBuiltinActionsApi();
    return api ? api.getBuiltinAction(name) : null;
}

function getBuiltinFastPaths() {
    const api = getBuiltinActionsApi();
    return api ? api.getBuiltinFastPaths() : [];
}

function getBuiltinActionNames() {
    const api = getBuiltinActionsApi();
    return api ? api.getBuiltinActionNames() : [];
}

let pluginRegistryResolver = null;

function getPluginRegistry() {
    if (pluginRegistryResolver === null) {
        try {
            // eslint-disable-next-line global-require
            pluginRegistryResolver = require("../plugins/registry").getRegistrySafe;
        } catch (error) {
            pluginRegistryResolver = false;
        }
    }
    if (!pluginRegistryResolver) {
        return null;
    }
    try {
        return pluginRegistryResolver();
    } catch (error) {
        return null;
    }
}

/**
插件动作的校验入口。返回 null 表示这不是一个已注册的插件动作（交给内置动作表）。
*/
function getPluginEntry(actionName) {
    const registry = getPluginRegistry();
    if (!registry || typeof registry.hasAction !== "function" || !registry.hasAction(actionName)) {
        return null;
    }
    return {
        action: actionName,
        plugin: registry.getActionPluginName(actionName),
        validate(node) {
            return registry.validateAction(actionName, node);
        },
    };
}

// ------------------------------------------------------------
// 清洗
// ------------------------------------------------------------

function cleanXML(response) {
    if (!response || typeof response !== "string") {
        throw new Error("returned empty response");
    }
    let text = response.trim();
    if (text.startsWith(FENCE + "xml")) {
        text = text.substring(FENCE.length + 3).trimStart();
    } else if (text.startsWith(FENCE)) {
        text = text.substring(FENCE.length).trimStart();
    }
    if (text.endsWith(FENCE)) {
        text = text.substring(0, text.length - FENCE.length).trimEnd();
    }
    return text.trim();
}

// ------------------------------------------------------------
// 兼容导出：实现已上提到动作定义
// ------------------------------------------------------------

function tryExtractWriteManually(text) {
    const definition = getBuiltinActionDefinition("write");
    if (!definition || typeof definition.meta.fastPath !== "function") {
        return null;
    }
    return definition.meta.fastPath(text);
}

/**
动作定义解析：内置动作表优先，其次是插件注册表。
screenshot 自 v1.1.0 起是内置插件，因此这里必须两个来源都能查到。
*/
function getAnyActionDefinition(name) {
    const builtin = getBuiltinActionDefinition(name);
    if (builtin) {
        return builtin;
    }
    const registry = getPluginRegistry();
    if (!registry || typeof registry.getActionDefinition !== "function") {
        return null;
    }
    try {
        return registry.getActionDefinition(name) || null;
    } catch (error) {
        return null;
    }
}

function tryExtractScreenshotManually(text) {
    const definition = getAnyActionDefinition("screenshot");
    if (!definition || typeof definition.meta.fastPath !== "function") {
        return null;
    }
    return definition.meta.fastPath(text);
}

// 归一化 screenshot 子目标：可能是单个对象、对象数组，或为空（旧写法）。
// 这是协议层的节点归一化，与具体执行者（内置插件）无关，因此留在 parse 层。
function normalizeScreenshotTargets(node) {
    const raw = node && node["target"];
    if (raw === undefined || raw === null) {
        return [];
    }
    if (Array.isArray(raw)) {
        return raw;
    }
    return [raw];
}

// ------------------------------------------------------------
// 校验
// ------------------------------------------------------------

/**
内置动作校验。找不到动作时抛 "Unknown XML Action: xxx"。
具体规则（含错误文案）在 actions/*.js 的 validate 里。
*/
function validateAction(action, node) {
    const api = getBuiltinActionsApi();
    if (!api) {
        throw new Error("Unknown XML Action: " + action);
    }
    api.validateBuiltinAction(action, node);
}

// ------------------------------------------------------------
// 快速解析器
// ------------------------------------------------------------

/**
内置动作的手写快速解析器（write / screenshot）。
命中后仍然走统一校验，与迁移前的行为一致。
*/
function tryBuiltinFastPaths(text) {
    for (const item of getBuiltinFastPaths()) {
        let parsed = null;
        try {
            parsed = item.parse(text);
        } catch (error) {
            continue;
        }
        if (!parsed || typeof parsed !== "object") {
            continue;
        }
        const actionName = parsed.action || item.action;
        validateAction(actionName, parsed.node);
        return { action: actionName, node: parsed.node };
    }
    return null;
}

// 插件的自定义快速解析器（可选）：用于 CDATA 嵌套或浏览器会破坏的写法。
function tryPluginFastPaths(text) {
    const registry = getPluginRegistry();
    if (!registry || typeof registry.getFastPaths !== "function") {
        return null;
    }
    let fastPaths = [];
    try {
        fastPaths = registry.getFastPaths();
    } catch (error) {
        return null;
    }
    for (const item of fastPaths) {
        let parsed = null;
        try {
            parsed = item.parse(text);
        } catch (error) {
            continue;
        }
        if (!parsed || typeof parsed !== "object") {
            continue;
        }
        const actionName = parsed.action || item.action;
        const entry = getPluginEntry(actionName);
        if (!entry) {
            continue;
        }
        const checked = entry.validate(parsed.node);
        if (!checked.ok) {
            throw new Error(checked.error || "Invalid " + actionName + " action");
        }
        return { action: actionName, node: parsed.node, plugin: entry.plugin };
    }
    return null;
}

// ------------------------------------------------------------
// 主入口
// ------------------------------------------------------------

function extractXML(response) {
    const text = cleanXML(response);
    const builtinFastPath = tryBuiltinFastPaths(text);
    if (builtinFastPath) {
        return builtinFastPath;
    }
    const pluginFastPath = tryPluginFastPaths(text);
    if (pluginFastPath) {
        return pluginFastPath;
    }
    let parsed;
    try {
        parsed = parser.parse(text);
    } catch (error) {
        throw new Error("Invalid XML: " + error.message);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid XML");
    }
    const actionNames = Object.keys(parsed);
    if (actionNames.length === 0) {
        throw new Error("No XML Action found");
    }
    if (actionNames.length !== 1) {
        throw new Error("Exactly one XML Action is required, but received " + actionNames.length);
    }
    const action = actionNames[0];
    let node = parsed[action];
    // 处理多个同名 action 的情况（如 <read/><read/><read/>）
    // fast-xml-parser 会将多个同名标签解析为数组
    if (Array.isArray(node)) {
        throw new Error(
            "Multiple " +
                action +
                " actions found (" +
                node.length +
                "), only one XML Action is allowed per response"
        );
    }
    const pluginEntry = getPluginEntry(action);
    if (pluginEntry) {
        const checked = pluginEntry.validate(node);
        if (!checked.ok) {
            throw new Error(checked.error || "Invalid " + action + " action");
        }
        return {
            action,
            node,
            plugin: pluginEntry.plugin,
        };
    }
    validateAction(action, node);
    return {
        action,
        node,
    };
}

const api = {
    extractXML,
    getText,
    tryExtractWriteManually,
    tryExtractScreenshotManually,
    normalizeScreenshotTargets,
};

// ACTION_NAMES 由内置动作表派生（保持"数组"这一公开面，但不再是手写副本）。
Object.defineProperty(api, "ACTION_NAMES", {
    enumerable: true,
    get() {
        return getBuiltinActionNames();
    },
});

module.exports = api;
