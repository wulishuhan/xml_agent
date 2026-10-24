const { XMLParser } = require("fast-xml-parser");
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: false,
});
const CHAR_LT = String.fromCharCode(60);
const CHAR_GT = String.fromCharCode(62);
const CHAR_SLASH = String.fromCharCode(47);
const CHAR_BANG = String.fromCharCode(33);
const CHAR_LBRACK = String.fromCharCode(91);
const CHAR_RBRACK = String.fromCharCode(93);
const CHAR_DQUOTE = String.fromCharCode(34);
const CHAR_TICK = String.fromCharCode(96);
const FENCE = CHAR_TICK + CHAR_TICK + CHAR_TICK;
const ACTION_NAMES = ["read", "write", "exec", "answer", "done", "screenshot"];
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
function tryExtractWriteManually(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    const WRITE_OPEN_PREFIX = CHAR_LT + "write";
    const WRITE_CLOSE_TAG = CHAR_LT + CHAR_SLASH + "write" + CHAR_GT;
    if (trimmed.indexOf(WRITE_OPEN_PREFIX) !== 0) return null;
    if (!trimmed.endsWith(WRITE_CLOSE_TAG)) return null;
    const firstGt = trimmed.indexOf(CHAR_GT);
    if (firstGt === -1) return null;
    const openTag = trimmed.substring(0, firstGt + 1);
    const pathMarker = "path=" + CHAR_DQUOTE;
    const pathStart = openTag.indexOf(pathMarker);
    if (pathStart === -1) return null;
    const pathValueStart = pathStart + pathMarker.length;
    const pathValueEnd = openTag.indexOf(CHAR_DQUOTE, pathValueStart);
    if (pathValueEnd === -1) return null;
    const path = openTag.substring(pathValueStart, pathValueEnd);
    if (!path) return null;
    let content = trimmed.substring(firstGt + 1, trimmed.length - WRITE_CLOSE_TAG.length);
    content = content.trim();
    const CDATA_START = CHAR_LT + CHAR_BANG + CHAR_LBRACK + "CDATA" + CHAR_LBRACK;
    if (content.indexOf(CDATA_START) === 0) {
        content = content.substring(CDATA_START.length);
    }
    const CDATA_END = CHAR_RBRACK + CHAR_RBRACK + CHAR_GT;
    if (content.endsWith(CDATA_END)) {
        content = content.substring(0, content.length - CDATA_END.length);
    }
    if (!content.trim()) return null;
    return {
        action: "write",
        node: {
            "@_path": path,
            "#text": content,
        },
    };
}
// 手动解析自闭合的 screenshot 动作：<screenshot source="screen" path="a.png"/>
// 仅处理“无子节点”的旧写法；带 <target> 子节点的多目标写法交给完整 XML 解析器。
function tryExtractScreenshotManually(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    const OPEN = CHAR_LT + "screenshot";
    const GT = CHAR_GT;
    const SELF_CLOSE = CHAR_SLASH + GT;
    if (trimmed.indexOf(OPEN) !== 0) return null;
    if (
        !trimmed.endsWith(SELF_CLOSE) &&
        !trimmed.endsWith(CHAR_LT + CHAR_SLASH + "screenshot" + GT)
    ) {
        return null;
    }
    const firstGt = trimmed.indexOf(GT);
    if (firstGt === -1) return null;
    // 存在子节点（如 <target .../>）时不在手动解析里处理。
    const inner = trimmed.substring(firstGt + 1);
    if (inner && inner.trim() && inner.trim().indexOf(CHAR_LT) === 0) {
        return null;
    }
    let attrText = trimmed.substring(OPEN.length, firstGt);
    if (attrText.endsWith(CHAR_SLASH)) {
        attrText = attrText.substring(0, attrText.length - 1);
    }
    const node = {};
    const attrPattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = attrPattern.exec(attrText)) !== null) {
        node["@_" + match[1]] = match[2];
    }
    return {
        action: "screenshot",
        node: node,
    };
}
function getText(node) {
    if (node === undefined || node === null) return "";
    if (typeof node === "string") return node;
    if (typeof node === "number" || typeof node === "boolean") {
        return String(node);
    }
    if (typeof node === "object" && node["#text"] !== undefined) {
        return String(node["#text"]);
    }
    return "";
}
function validateScreenshotTarget(target, index) {
    const label = "screenshot target[" + index + "]";
    if (!target || typeof target !== "object") {
        throw new Error(label + " is invalid");
    }
    const source = target["@_source"];
    if (!source) {
        throw new Error(label + " requires source (browser_page | screen | window)");
    }
    if (source !== "browser_page" && source !== "screen" && source !== "window") {
        throw new Error(label + " source must be one of: browser_page, screen, window");
    }
    if (source === "window" && !target["@_windowTitle"] && !target["@_title"]) {
        throw new Error(label + " source=window requires windowTitle");
    }
}
// 归一化 screenshot 子目标：可能是单个对象、对象数组，或为空（旧写法）。
function normalizeScreenshotTargets(node) {
    const raw = node["target"];
    if (raw === undefined || raw === null) {
        return [];
    }
    if (Array.isArray(raw)) {
        return raw;
    }
    return [raw];
}
function validateScreenshot(node) {
    if (!node || typeof node !== "object") {
        throw new Error("screenshot action is invalid");
    }
    const targets = normalizeScreenshotTargets(node);
    // 多目标写法：<screenshot><target .../><target .../></screenshot>
    if (targets.length > 0) {
        targets.forEach(function (target, index) {
            validateScreenshotTarget(target, index);
        });
        if (targets.length > 8) {
            throw new Error(
                "screenshot supports at most 8 targets per action, got " + targets.length
            );
        }
        return;
    }
    // 旧写法：<screenshot source="..." path="..."/>
    const source = node["@_source"];
    if (!source) {
        throw new Error("screenshot requires source (browser_page | screen | window)");
    }
    if (source !== "browser_page" && source !== "screen" && source !== "window") {
        throw new Error("screenshot source must be one of: browser_page, screen, window");
    }
    if (source === "window" && !node["@_windowTitle"] && !node["@_title"]) {
        throw new Error("screenshot source=window requires windowTitle");
    }
}
function validateAction(action, node) {
    switch (action) {
        case "read":
            if (!node || typeof node !== "object") {
                throw new Error("read action is invalid");
            }
            if (!node["@_path"]) {
                throw new Error("read requires path");
            }
            return;
        case "write":
            if (!node || typeof node !== "object") {
                throw new Error("write action is invalid");
            }
            if (!node["@_path"]) {
                throw new Error("write requires path");
            }
            if (!getText(node)) {
                throw new Error("write content cannot be empty");
            }
            return;
        case "exec":
            if (!node || typeof node !== "object") {
                throw new Error("exec action is invalid");
            }
            if (!node["@_command"]) {
                throw new Error("exec requires command");
            }
            return;
        case "screenshot":
            validateScreenshot(node);
            return;
        case "answer":
            if (!getText(node).trim()) {
                throw new Error("answer content cannot be empty");
            }
            return;
        case "done":
            return;
        default:
            throw new Error("Unknown XML Action: " + action);
    }
}
function extractXML(response) {
    const text = cleanXML(response);
    const manualWrite = tryExtractWriteManually(text);
    if (manualWrite) {
        validateAction(manualWrite.action, manualWrite.node);
        return manualWrite;
    }
    const manualScreenshot = tryExtractScreenshotManually(text);
    if (manualScreenshot) {
        validateAction(manualScreenshot.action, manualScreenshot.node);
        return manualScreenshot;
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
    validateAction(action, node);
    return {
        action,
        node,
    };
}
module.exports = {
    extractXML,
    getText,
    tryExtractWriteManually,
    tryExtractScreenshotManually,
    normalizeScreenshotTargets,
    ACTION_NAMES,
};
