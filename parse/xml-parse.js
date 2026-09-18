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
};
