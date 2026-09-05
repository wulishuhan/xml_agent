function getSendErrorPrompt(error) {
    return `
上一轮 Agent 调用模型时发生错误。

错误信息：

${error.message}

请继续完成用户任务。

不要假设上一轮已经成功执行。
不要编造 Runtime 结果。

请重新输出一个 XML Action。
`;
}

module.exports = {
    getSendErrorPrompt,
};