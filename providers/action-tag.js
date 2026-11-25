/**
 * Provider 共用的 JSON Action envelope 检测。
 *
 * 动作集合是开放的，不能像旧 XML 标签方案那样依赖内置/插件名字清单。
 * 这里直接复用解析层对说明文字、Markdown 围栏、嵌套 params 以及字符串转义的
 * 处理，保持各 Provider 的动作判定一致。
 */
const { hasActionEnvelope } = require("../parse/json-candidate");

module.exports = {
    hasActionEnvelope,
};
