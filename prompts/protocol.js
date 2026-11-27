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

const wenyanFirst = require("./wenyan/first-prompt");
const wenyanVariants = require("./wenyan/system-prompt-variants");
const wenyanError = require("./wenyan/error-prompt");
const wenyanRuntime = require("./wenyan/runtime-prompt");
const wenyanDone = require("./wenyan/done-prompt");
const wenyanSendError = require("./wenyan/send-error-prompt");

// 显式映射：xml / json 保持原样，未知协议由 normalizeProtocol 退回 xml。
const MODULES = {
    xml: {
        first: xmlFirst,
        variants: xmlVariants,
        error: xmlError,
        runtime: xmlRuntime,
        done: xmlDone,
        sendError: xmlSendError,
        errorFn: "getXmlErrorPrompt",
    },
    json: {
        first: jsonFirst,
        variants: jsonVariants,
        error: jsonError,
        runtime: jsonRuntime,
        done: jsonDone,
        sendError: jsonSendError,
        errorFn: "getJsonErrorPrompt",
    },
    wenyan: {
        first: wenyanFirst,
        variants: wenyanVariants,
        error: wenyanError,
        runtime: wenyanRuntime,
        done: wenyanDone,
        sendError: wenyanSendError,
        errorFn: "getWenyanErrorPrompt",
    },
};

function moduleFor(protocol) {
    return MODULES[normalizeProtocol(protocol)];
}
function firstModule(protocol) {
    return moduleFor(protocol).first;
}
function variantsModule(protocol) {
    return moduleFor(protocol).variants;
}
function errorModule(protocol) {
    return moduleFor(protocol).error;
}
function runtimeModule(protocol) {
    return moduleFor(protocol).runtime;
}

function getFirstPromptForProtocol(workspace, task, options = {}, protocol) {
    return firstModule(protocol).getFirstPrompt(
        workspace,
        task,
        // 插件用法示例必须按协议渲染，否则 XML 会话会看到 JSON 示例（反之亦然）。
        Object.assign({}, options, { protocol: normalizeProtocol(protocol) })
    );
}

/** 按协议取错误提示词；每个协议模块的导出名由 MODULES.errorFn 指定。 */
function getErrorPromptForProtocol(error, options = {}, protocol) {
    const mod = errorModule(protocol);
    const fn = mod[MODULES[normalizeProtocol(protocol)].errorFn];
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
    return moduleFor(protocol).done.getDonePrompt();
}

/** 发送失败续接提示：措辞里带协议格式要求，必须按协议路由。 */
function getSendErrorPromptForProtocol(error, options = {}, protocol) {
    return moduleFor(protocol).sendError.getSendErrorPrompt(error, options);
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
