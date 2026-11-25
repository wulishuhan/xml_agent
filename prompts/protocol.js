/**
提示词协议路由

两套协议的提示词分放在 prompts/xml/ 与 prompts/json/ 两个文件夹：
- 首轮系统提示词 / 措辞变体 / 格式纠错提示词，各协议一套；
- 插件 / 技能 / 运行时 / 发送失败 / done 等共用提示词仍在 prompts/ 根目录。

顶层 prompts/index.js 的既有导出保持为 JSON 版（历史调用方与指纹测试依赖），
本模块提供按协议名分发的新入口，供 agent-core / agent/step 使用。

签名统一为：
- getFirstPromptForProtocol(workspace, task, options, protocol)
- getErrorPromptForProtocol(error, options, protocol)
- getSystemPromptVariantForProtocol(index, protocol)
- pickSystemPromptVariantForProtocol(protocol)
- SYSTEM_PROMPT_VARIANT_COUNT_FOR(protocol)
*/

const { normalizeProtocol } = require("../parse/action");

const jsonFirst = require("./json/first-prompt");
const jsonVariants = require("./json/system-prompt-variants");
const jsonError = require("./json/error-prompt");
const jsonRuntime = require("./json/runtime-prompt");
const jsonDone = require("./json/done-prompt");
const jsonSendError = require("./json/send-error-prompt");

const xmlFirst = require("./xml/first-prompt");
const xmlVariants = require("./xml/system-prompt-variants");
const xmlError = require("./xml/error-prompt");
const xmlRuntime = require("./xml/runtime-prompt");
const xmlDone = require("./xml/done-prompt");
const xmlSendError = require("./xml/send-error-prompt");

function firstModule(protocol) {
    return normalizeProtocol(protocol) === "json" ? jsonFirst : xmlFirst;
}
function variantsModule(protocol) {
    return normalizeProtocol(protocol) === "json" ? jsonVariants : xmlVariants;
}
function errorModule(protocol) {
    return normalizeProtocol(protocol) === "json" ? jsonError : xmlError;
}
function runtimeModule(protocol) {
    return normalizeProtocol(protocol) === "json" ? jsonRuntime : xmlRuntime;
}

function getFirstPromptForProtocol(workspace, task, options = {}, protocol) {
    return firstModule(protocol).getFirstPrompt(workspace, task, options);
}

/** 返回 { prompt, exportName } —— exportName 是对应模块里错误提示词的导出函数名。 */
function getErrorPromptForProtocol(error, options = {}, protocol) {
    const mod = errorModule(protocol);
    const fn =
        typeof mod.getJsonErrorPrompt === "function"
            ? mod.getJsonErrorPrompt
            : mod.getXmlErrorPrompt;
    return fn(error, options);
}

function getSystemPromptVariantForProtocol(index, protocol) {
    return variantsModule(protocol).getSystemPromptVariant(index);
}

function pickSystemPromptVariantForProtocol(protocol) {
    return variantsModule(protocol).pickSystemPromptVariant();
}

function systemPromptVariantCountFor(protocol) {
    return variantsModule(protocol).SYSTEM_PROMPT_VARIANT_COUNT;
}

/** 每轮执行结果回贴提示：措辞里带协议格式示例，必须按协议路由。 */
function getRuntimeOkPromptForProtocol(result, options = {}, protocol) {
    return runtimeModule(protocol).getRuntimeOkPrompt(result, options);
}
function getRuntimeErrorPromptForProtocol(result, options = {}, protocol) {
    return runtimeModule(protocol).getRuntimeErrorPrompt(result, options);
}

/** 收尾提示：要求模型单独回一个结束动作，格式必须跟当前协议一致。 */
function getDonePromptForProtocol(protocol) {
    return normalizeProtocol(protocol) === "json"
        ? jsonDone.getDonePrompt()
        : xmlDone.getDonePrompt();
}

/** 发送失败续接提示：措辞里带协议格式要求，必须按协议路由。 */
function getSendErrorPromptForProtocol(error, options = {}, protocol) {
    return normalizeProtocol(protocol) === "json"
        ? jsonSendError.getSendErrorPrompt(error, options)
        : xmlSendError.getSendErrorPrompt(error, options);
}

module.exports = {
    getFirstPromptForProtocol,
    getErrorPromptForProtocol,
    getRuntimeOkPromptForProtocol,
    getRuntimeErrorPromptForProtocol,
    getDonePromptForProtocol,
    getSendErrorPromptForProtocol,
    getSystemPromptVariantForProtocol,
    pickSystemPromptVariantForProtocol,
    systemPromptVariantCountFor,
};
