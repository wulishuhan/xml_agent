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

const xmlFirst = require("./xml/first-prompt");
const xmlVariants = require("./xml/system-prompt-variants");
const xmlError = require("./xml/error-prompt");

function firstModule(protocol) {
    return normalizeProtocol(protocol) === "json" ? jsonFirst : xmlFirst;
}
function variantsModule(protocol) {
    return normalizeProtocol(protocol) === "json" ? jsonVariants : xmlVariants;
}
function errorModule(protocol) {
    return normalizeProtocol(protocol) === "json" ? jsonError : xmlError;
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

module.exports = {
    getFirstPromptForProtocol,
    getErrorPromptForProtocol,
    getSystemPromptVariantForProtocol,
    pickSystemPromptVariantForProtocol,
    systemPromptVariantCountFor,
};
