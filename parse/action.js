/**
动作协议解析路由

协议（xml / json / wenyan）共用同一个执行层（runtime + actions），区别只在"如何把模型回复
解析成 { action, params } 信封"。本模块按协议名分发到对应解析器。

- xml    → parse/xml-action.js 的 extractXmlAction（fast-xml-parser + 节点归一化）
- json   → parse/json-action.js 的 extractAction（裸 JSON / json 围栏 + ajv 校验）
- wenyan → parse/wenyan-action.js 的 extractWenyanAction（实验协议：单字动词 + 「」正文）

协议名归一化：非法值一律退回 "xml"（默认协议），保证旧调用方与未配置的新会话行为一致。
wenyan 为实验分支协议，只在显式 --protocol wenyan 时启用，不影响默认行为。
*/

const { extractAction: extractJsonAction } = require("./json-action");
const { extractXmlAction } = require("./xml-action");
const { extractWenyanAction } = require("./wenyan-action");

const SUPPORTED_PROTOCOLS = ["xml", "json", "wenyan"];
const DEFAULT_PROTOCOL = "xml";

/** 协议 → 解析器，用显式映射，未知值退回默认（xml）。 */
const PARSERS = {
    xml: extractXmlAction,
    json: extractJsonAction,
    wenyan: extractWenyanAction,
};

function normalizeProtocol(value) {
    const text = String(value || "").trim().toLowerCase();
    return SUPPORTED_PROTOCOLS.indexOf(text) !== -1 ? text : DEFAULT_PROTOCOL;
}

/** 按协议解析模型回复为 { action, params }（或抛错）。 */
function extractActionForProtocol(response, protocol) {
    const resolved = normalizeProtocol(protocol);
    return PARSERS[resolved](response);
}

module.exports = {
    normalizeProtocol,
    extractActionForProtocol,
    SUPPORTED_PROTOCOLS,
    DEFAULT_PROTOCOL,
};
