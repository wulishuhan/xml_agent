function getRuntimeOkPrompt(result) {
  return `
上一轮 Runtime 已经执行完成。

Runtime 返回：

${JSON.stringify(result, null, 2)}

请根据这个真实结果继续完成用户任务。

如果还需要读取文件：

使用 <read>

如果需要修改文件：

使用 <write>

如果需要运行命令：

使用 <exec>

如果已经可以回答用户：

使用：

<answer><![CDATA[
最终答案
]]></answer>

如果已经完成并且不需要回答：

使用：

<done/>

只输出一个 XML Action。
`;
}

function getRuntimeErrorPrompt(result) {
  return `
Runtime 执行失败。

下面是 Runtime 的真实返回结果：

${JSON.stringify(result, null, 2)}

请分析这个错误。

如果可以修复：

1. 修复问题
2. 必要时再次执行验证

如果不能修复：

使用 <answer> 告诉用户真实错误。

不要编造 Runtime 结果。

只输出一个 XML Action。
`;
}

module.exports = {
  getRuntimeOkPrompt,
  getRuntimeErrorPrompt,
};
