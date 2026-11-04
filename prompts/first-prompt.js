const { SYSTEM_PROMPT } = require("./system-prompt");
const { buildPluginPromptSection } = require("./plugin-prompt");

function getFirstPrompt(currentWorkspace, manifest, task, options = {}) {
    // 插件动作文档自动生成；没有任何启用的插件动作时返回空字符串，
    // 此时首轮提示词与 1.0.x 完全一致（保持提示词稳定）。
    let pluginSection = "";
    try {
        pluginSection = buildPluginPromptSection(options.registry, {
            task: task,
            maxPromptChars: options.maxPromptChars,
        });
    } catch (error) {
        pluginSection = "";
    }
    const pluginBlock = pluginSection ? "\n\n" + pluginSection : "";

    // provider 声明的输出格式约束（例如 Gemini 会吞掉裸 XML 标签，
    // 必须把动作放进代码块）。没有声明时提示词与原来完全一致。
    const providerHint =
        typeof options.providerHint === "string" ? options.providerHint.trim() : "";
    const providerBlock = providerHint
        ? "\n\n============================================================\n" +
          "输出格式（本平台强制要求）\n" +
          "============================================================\n\n" +
          providerHint
        : "";

    let prompt = `
${SYSTEM_PROMPT}${pluginBlock}${providerBlock}

============================================================
Workspace
============================================================

${currentWorkspace}

============================================================
Workspace Manifest
============================================================

${manifest.join("\n")}

============================================================
用户任务
============================================================

${task}

============================================================
现在开始工作
============================================================

请严格按照 XML Action 协议执行。

如果需要查看项目，先使用 read。

如果任务最终需要回答用户，
完成分析后必须使用：

<answer><![CDATA[
你的最终答案
]]></answer>

最后使用：

<done/>
`;
    return prompt;
}

module.exports = {
    getFirstPrompt,
};
