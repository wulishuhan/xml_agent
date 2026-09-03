function getDonePrompt() {
  return `
用户答案已经成功生成。

最终答案已经显示给用户。

现在结束 Agent 生命周期。

只输出：

<done/>
`;
}

module.exports = {
  getDonePrompt,
};
