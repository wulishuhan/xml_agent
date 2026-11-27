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

/**
 * CDATA 内出现字面 `]]>` 时，XML 规范只允许用 `]]]]><![CDATA[>` 拆段表示。
 * 模型几乎不会主动这么写，直接解析会把 `const s = "]]>";` 截断并错位成
 * `const s = "";]]>` —— 静默改错 old 内容，导致 edit 永远找不到或匹配错位置。
 *
 * 这里在解析前把"后面不紧跟 '<' 的 ]]>" 自动拆成合法的两段 CDATA；
 * 真正的结束符后面必是 `</old>` / `</new>` 等标签（以 '<' 开头），不会被误判。
 * fast-xml-parser 会把相邻 CDATA 段拼回原文，得到正确的 `]]>`。
 */
function protectCdataClose(text) {
    const OPEN = "<![CDATA[";
    const CLOSE = "]]>";
    let out = "";
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf(OPEN, i);
        if (start === -1) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, start + OPEN.length);
        i = start + OPEN.length;
        let end = text.indexOf(CLOSE, i);
        while (end !== -1 && text.charAt(end + CLOSE.length) !== "<") {
            out += text.slice(i, end) + "]]]]><![CDATA[>";
            i = end + CLOSE.length;
            end = text.indexOf(CLOSE, i);
        }
        if (end === -1) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, end + CLOSE.length);
        i = end + CLOSE.length;
    }
    return out;
}

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
    return protectCdataClose(text.trim());
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
            const name = key.slice(2);
            const raw = decodeXmlEntities(node[key]);
            // XML 属性天生是字符串，但 schema 里 offset/limit 是 integer。
            // 不转的话 ajv 会把合法的分页读动作判成格式错误。
            if ((name === "offset" || name === "limit") &&
                typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
                result[name] = Number(raw.trim());
            } else {
                result[name] = raw;
            }
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
edit 的 change 归一化。容忍模型常见的三种写法：
  <edit path="a"><old>..</old><new>..</new></edit>              （单组直接并列）
  <edit path="a"><change><old>..</old><new>..</new></change> ...（多组）
  <edit path="a"><changes><change>...</change></changes></edit>  （套一层 changes）
字段名 oldText/newText 也按别名接受。

关键修复：
- 缺 <new> 时不再补 ""（那会被当成"合法删除"，静默删掉代码）；
  保留缺失让 schema 报 "required property 'new'"，与 JSON 协议行为一致。
- 根节点直接 <old>/<new> 与 <change> 混用时报错，不再静默丢弃其中一组。
*/
function editChanges(node) {
    if (!node || typeof node !== "object") {
        return [];
    }
    // <changes> 只是透明包装层：取其内部的 change 列表，或把整块当单个 change。
    let source = node;
    if (node.changes !== undefined && node.changes !== null && typeof node.changes === "object") {
        source = node.changes;
    }
    const hasWrapped = source.change !== undefined && source.change !== null;
    const hasDirect = source.old !== undefined || source.new !== undefined;
    if (hasWrapped && hasDirect) {
        throw new Error(
            "edit cannot mix direct <old>/<new> with <change> blocks in one <edit>; " +
                "use one style consistently (some changes would be silently dropped)"
        );
    }
    const items = hasWrapped
        ? Array.isArray(source.change)
            ? source.change
            : [source.change]
        : [source];
    const changes = [];
    for (const item of items) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const oldValue = item.old !== undefined ? item.old : item.oldText;
        const newValue = item.new !== undefined ? item.new : item.newText;
        if (oldValue === undefined && newValue === undefined) {
            continue;
        }
        const change = { old: blockText(oldValue) };
        // 只有 new 真的出现过才带上；缺失交给 schema 报错，杜绝静默删除。
        if (newValue !== undefined && newValue !== null) {
            change.new = blockText(newValue);
        }
        changes.push(change);
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
