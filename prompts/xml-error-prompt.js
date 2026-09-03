function getXmlErrorPrompt(error) {
  let prompt = `你的上一条回复不是合法的 XML Action。

错误：

${error.message}

请不要解释。

请严格只输出一个合法 XML Action。

例如：

<read path="package.json"/>

或者：

<answer><![CDATA[
最终答案
]]></answer>

或者：

<done/>`;
  return prompt;
}

module.exports = {
  getXmlErrorPrompt,
};
