// 回给模型的结果视图：插件动作可能返回很大的结果（例如 HTTP 响应体），
// registry 会提供 promptView 精简视图，完整结果只留在 Trace / 报告里。
function promptView(result) {
    if (result && typeof result === "object" && result.promptView) {
        return result.promptView;
    }
    return result;
}

function getRuntimeOkPrompt(result) {
    return `
上一轮 Runtime 已经执行完成。
Runtime 返回：
${JSON.stringify(promptView(result), null, 2)}
请根据这个真实结果继续完成用户任务。
如果还需要读取文件：
使用 <read>
如果需要修改已有文件里的几处：
使用 <edit>（old 必须与文件原文一致且唯一，出现多次就多写上下文或用 all="true"；<new> 留空表示删除）
例如：
<edit path="src/example.js"><old><![CDATA[const a = 1;]]></old><new><![CDATA[const a = 2;]]></new></edit>
如果需要新建文件或者整体重写：
使用 <write>
例如：
<write path="src/example.js"><![CDATA[
console.log("hello");
]]></write>
注意：之后请你进行语法和运行的验证，可以创建test文件进行验证然后使用 <exec> 进行验证，验证完成之后可以删除验证文件，避免语法错误，如果是文档则不需要验证。
完成之后再进行下一步。
如果需要运行命令：
使用 <exec>
如果需要截图（桌面/指定窗口/浏览器页面）：
使用 <screenshot>
例如：
<screenshot source="screen" path="screenshots/desktop.png"/>
<screenshot source="window" windowTitle="Visual Studio Code" path="screenshots/vscode.png"/>
<screenshot source="browser_page" url="https://example.com" path="screenshots/page.png"/>
注意：path 必须是相对 Workspace 的路径；省略时默认保存到 screenshots/screenshot-<时间戳>.png。
如果已经可以回答用户：
使用：
<answer><![CDATA[
最终答案
]]></answer>
注意：
本轮只能输出 <answer>。
输出 <answer> 后，不要同时输出 <done/>。
Agent 会在下一轮单独要求你输出 <done/>。
如果已经完成并且不需要回答：
使用：
<done/>只输出一个 XML Action。
`;
}
function getRuntimeErrorPrompt(result) {
    return `
Runtime 执行失败。
下面是 Runtime 的真实返回结果：
${JSON.stringify(promptView(result), null, 2)}
请分析这个错误。
如果可以修复：
- 修复问题
- 必要时再次执行验证

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
