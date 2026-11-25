/**
XML Action 协议解析层（与 JSON 协议并行，共用执行层）

职责：把模型回复里的单个 XML 动作解析成统一的 { action, params } 信封，
交给与 JSON 协议完全相同的 runtime / actions 执行。

    <read path="package.json"/>            → { action: "read", params: { path: "package.json" } }
    <write path="a.js"><![CDATA[x]]></write> → { action: "write", params: { path: "a.js", content: "x" } }
    <edit path="a.js"><change>...</change></edit> → { action: "edit", params: { path, changes: [...] } }
    <screenshot><target .../></screenshot>  → { action: "screenshot", params: { targets: [...] } }
    <done/>                                 → { action: "done", params: {} }

这样两套协议共用同一份动作定义、同一份参数 schema、同一个 runtime，
XML 侧只多一层"节点 → params"的归一化。插件动作同样支持：属性按 @_ 前缀转 params，
子节点文本按 #text 归入 content，具体规则交给插件自己的 registry.validateAction 校验。

校验失败时抛出的错误文案与 JSON 侧保持一致（如 "Unknown action: xxx"），
便于 getXmlErrorPrompt 归类成人话。
*/

const { XMLParser } = require("fast-xml-parser");
const { FENCE } = require("./xml-chars");
const { getText, decodeXmlEntities, stripCdataLeadingNewline } = require("./xml-text");
const { validateParams } = require("./action-schema");

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: false,
});

// ------------------------------------------------------------
// 惰性依赖：避免 actions → parse → actions 的循环 require
// ------------------------------------------------------------

let builtinActionsModule = null;
function getBuiltinActionsApi() {
    if (builtinActionsModule === null) {
        try {
            builtinActionsModule = require("../actions");
        } catch (error) {
            builtinActionsModule = false;
        }
    }
    return builtinActionsModule || null;
}

let pluginRegistryModule = null;
function getPluginRegistry() {
    if (pluginRegistryModule === null) {
        try {
            pluginRegistryModule = require("../plugins/registry").getRegistrySafe();
        } catch (error) {
            pluginRegistryModule = false;
        }
    }
    return pluginRegistryModule || null;
}

// ------------------------------------------------------------
// 清洗：去 markdown 围栏
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
// 节点 → params 归一化
// ------------------------------------------------------------

/** 把 @_attr 转成 params 普通键，并解码 XML 实体（CDATA 文本不走这里）。 */
function attributes(node) {
    const result = {};
    if (!node || typeof node !== "object") {
        return result;
    }
    for (const key of Object.keys(node)) {
        if (key.startsWith("@_")) {
            result[key.slice(2)] = decodeXmlEntities(node[key]);
        }
    }
    return result;
}

/** 文本块：老写法首尾常带换行，剥掉；CDATA 里的首换行单独处理。 */
function blockText(value) {
    let text = getText(value);
    if (text.startsWith("\n") || text.startsWith("\r\n")) {
        text = text.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    }
    return text;
}

/**
edit 的 change 归一化。两种写法都支持：
  <edit path="a"><old>..</old><new>..</new></edit>          （单组直接并列）
  <edit path="a"><change><old>..</old><new>..</new></change> ...（多组）
两种都产出 changes: [{ old, new }, ...]。new 缺失表示非法（schemas 要求 new 字段存在）。
*/
function editChanges(node) {
    const raw = node && node.change;
    const items =
        raw === undefined || raw === null ? [node] : Array.isArray(raw) ? raw : [raw];
    const changes = [];
    for (const item of items) {
        if (!item || typeof item !== "object") {
            continue;
        }
        if (item.old === undefined && item.new === undefined) {
            continue;
        }
        const hasNew = item.new !== undefined && item.new !== null;
        changes.push({
            old: blockText(item.old),
            new: hasNew ? blockText(item.new) : "",
        });
    }
    return changes;
}

/** 布尔属性：XML 里是字符串 "true"/"false"。 */
function boolAttr(value) {
    return value === true || value === "true";
}

/**
screenshot 归一化。两种写法：
  <screenshot source="screen" path="a.png"/>              （旧：单目标属性在根）
  <screenshot><target source="..." path="..."/>...</screenshot>（新：多目标子节点）
统一产出 targets: [{ source, path, ... }, ...]。
*/
function screenshotTargets(node) {
    if (!node || typeof node !== "object") {
        return [];
    }
    const raw = node.target;
    let nodes;
    if (raw === undefined || raw === null) {
        // 旧写法：根节点的属性就是一个目标
        if (!node["@_source"]) {
            return [];
        }
        nodes = [node];
    } else {
        nodes = Array.isArray(raw) ? raw : [raw];
    }
    return nodes.map((item) => {
        const target = attributes(item);
        if (target.fullPage !== undefined) {
            target.fullPage = boolAttr(target.fullPage);
        }
        return target;
    });
}

/** 内置动作的 node → params 映射。返回 null 表示未知内置动作。 */
function builtinParams(action, node) {
    const attrs = attributes(node);
    switch (action) {
        case "read":
            return attrs;
        case "write":
            return { path: attrs.path, content: stripCdataLeadingNewline(getText(node)) };
        case "edit":
            return {
                path: attrs.path,
                all: boolAttr(attrs.all),
                changes: editChanges(node),
            };
        case "exec":
            return { command: attrs.command };
        case "answer":
            return { content: getText(node) };
        case "done":
            return {};
        default:
            return null;
    }
}

/** 插件动作：属性转 params，文本节点归入 content（多数插件按 params 取参）。 */
function pluginParams(node) {
    const result = attributes(node);
    const text = getText(node);
    if (text) {
        result.content = text;
    }
    return result;
}

// ------------------------------------------------------------
// 主入口
// ------------------------------------------------------------

function extractXmlAction(response) {
    const text = cleanXML(response);
    let parsed;
    try {
        parsed = parser.parse(text);
    } catch (error) {
        throw new Error("Invalid XML: " + error.message);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid XML");
    }
    const actionNames = Object.keys(parsed).filter((key) => !key.startsWith("?"));
    if (actionNames.length === 0) {
        throw new Error("No XML Action found");
    }
    if (actionNames.length !== 1) {
        throw new Error("Exactly one XML Action is required, but received " + actionNames.length);
    }

    const action = actionNames[0];
    let node = parsed[action];
    if (Array.isArray(node)) {
        throw new Error(
            "Multiple " +
                action +
                " actions found (" +
                node.length +
                "), only one XML Action is allowed per response"
        );
    }
    if (node === undefined || node === null) {
        node = {};
    }

    // 内置动作：归一化 params 后用同一份 schema 校验；screenshot 是内置插件，走插件分支。
    const builtin = getBuiltinActionsApi();
    const isBuiltin = builtin && builtin.hasBuiltinAction(action);
    let params;
    if (isBuiltin && action !== "screenshot") {
        params = builtinParams(action, node);
        if (params === null) {
            throw new Error("Unknown action: " + action);
        }
    } else {
        // 插件动作（screenshot 也在此列）：registry 负责校验。
        const registry = getPluginRegistry();
        if (!registry || !registry.hasAction(action)) {
            throw new Error("Unknown action: " + action);
        }
        params =
            action === "screenshot"
                ? { targets: screenshotTargets(node) }
                : pluginParams(node);
        const checked = registry.validateAction(action, params);
        if (!checked.ok) {
            throw new Error(checked.error || "Invalid " + action + " action");
        }
        params = checked.value;
        return { action, params, plugin: registry.getActionPluginName(action) };
    }

    // 内置动作的统一 schema 校验（与 JSON 侧完全一致）。
    const definition = builtin.getBuiltinAction(action);
    const checkedSchema = validateParams(definition.schema, params);
    if (!checkedSchema.ok) {
        throw new Error(checkedSchema.error);
    }
    try {
        if (typeof definition.validate === "function") {
            definition.validate(checkedSchema.value);
        }
    } catch (error) {
        throw new Error(error && error.message ? error.message : String(error));
    }
    return { action, params: checkedSchema.value };
}

module.exports = {
    extractXmlAction,
    cleanXML,
    attributes,
    editChanges,
    screenshotTargets,
};
