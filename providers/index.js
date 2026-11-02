/**
Provider 门面

调用方（agent-core / 测试 / 未来的插件）只需要理解这几个函数：
- createProvider(name, options)      创建实例（会做契约校验）
- listProviders()                    列出全部 provider（内置 + 插件），可直接 JSON 化
- getProviderMeta(name)              取单个 provider 的元数据
- resolveTargetUrl(name, overrides)  解析访问地址（配置覆盖 > provider 默认）
- normalizeConversationId(name, raw) URL/纯 id → conversationId

实现全在 ./registry.js。
*/

const registry = require("./registry");

const listProviders = registry.list;
const getProviderMeta = registry.get;
const createProvider = registry.create;
const resolveTargetUrl = registry.resolveTargetUrl;
const normalizeConversationId = registry.normalizeConversationId;

module.exports = {
    listProviders,
    getProviderMeta,
    createProvider,
    resolveTargetUrl,
    normalizeConversationId,
    registry,
};
