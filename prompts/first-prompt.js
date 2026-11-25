const { SYSTEM_PROMPT } = require("./system-prompt");
const { getSystemPromptVariant } = require("./system-prompt-variants");
const { buildPluginPromptSection } = require("./plugin-prompt");
const { buildSkillPromptSection } = require("./skill-prompt");

function projectLabel(workspace) {
    const text = String(workspace || "").trim();
    if (!text) {
        return "当前目录";
    }
    const parts = text.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "当前目录";
}

function getFirstPrompt(currentWorkspace, task, options = {}) {
    let pluginSection = "";
    try {
        pluginSection = buildPluginPromptSection(options.registry, {
            task: task,
            maxPromptChars: options.maxPromptChars,
            protocol: options.protocol,
        });
    } catch (error) {
        pluginSection = "";
    }
    const pluginBlock = pluginSection ? "\n\n" + pluginSection : "";

    let skillSection = "";
    try {
        skillSection = buildSkillPromptSection(options.skills, {
            maxSkills: options.maxSkills,
        });
    } catch (error) {
        skillSection = "";
    }
    const skillBlock = skillSection ? "\n\n" + skillSection : "";

    const providerHint =
        typeof options.providerHint === "string" ? options.providerHint.trim() : "";
    const providerBlock = providerHint ? "\n\n输出格式（本平台要求）\n\n" + providerHint : "";

    const systemPrompt =
        options.systemPromptVariant === undefined
            ? SYSTEM_PROMPT
            : getSystemPromptVariant(options.systemPromptVariant);

    return `${systemPrompt}${pluginBlock}${skillBlock}${providerBlock}

项目：${projectLabel(currentWorkspace)}（本机目录，动作路径相对它）

用户任务

${task}

先输出一个 read 动作查看项目结构，然后按协议继续。`;
}

module.exports = {
    getFirstPrompt,
    projectLabel,
};
