const path = require("path");
const { SYSTEM_PROMPT } = require("./system-prompt");
const { buildPluginPromptSection } = require("./plugin-prompt");
const { buildSkillPromptSection } = require("./skill-prompt");

/**
清单字符上限。manifest.js 的 1200 条上限是"别把请求撑爆"的硬保护，
但 1200 条仍然能有 2 万多字符——对网页版对话来说，一条首消息里塞两万字目录
既慢又异常。这里再按字符收一次，超了就截断并写明"这不是全部"。
*/
const DEFAULT_MANIFEST_MAX_CHARS = 8000;

/**
取项目名而不是绝对路径。
首轮提示词会被网页平台当成"用户消息"读，里面出现 D:\\code\\... 这类本机路径
既没必要（动作全部走相对路径），也是"脚本在操作本机"的明显特征。
*/
function projectLabel(workspace) {
    const text = String(workspace || "").trim();
    if (!text) {
        return "当前目录";
    }
    const parts = text.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "当前目录";
}

/**
按字符上限裁剪清单，尽量切在行边界，并补一行说明。
*/
function clampManifest(manifest, maxChars) {
    const list = Array.isArray(manifest) ? manifest : [];
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MANIFEST_MAX_CHARS;
    const text = list.join("\n");
    if (text.length <= limit) {
        return text;
    }
    let cut = text.slice(0, limit);
    const lastBreak = cut.lastIndexOf("\n");
    if (lastBreak > limit * 0.6) {
        cut = cut.slice(0, lastBreak);
    }
    return (
        cut +
        "\n... (listing truncated, " +
        list.length +
        " entries in total; use read / exec to explore specific directories)"
    );
}

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

    // 工作区里可用技能的清单（只有模型真读得到的才会列出来）。
    // 没有任何技能时返回空字符串，提示词保持与旧版一致。
    let skillSection = "";
    try {
        skillSection = buildSkillPromptSection(options.skills, {
            maxSkills: options.maxSkills,
        });
    } catch (error) {
        skillSection = "";
    }
    const skillBlock = skillSection ? "\n\n" + skillSection : "";

    // provider 声明的输出格式约束（例如 Gemini 会吞掉裸 XML 标签，
    // 必须把动作放进代码块）。没有声明时提示词与原来完全一致。
    const providerHint =
        typeof options.providerHint === "string" ? options.providerHint.trim() : "";
    const providerBlock = providerHint ? "\n\n输出格式（本平台强制要求）\n\n" + providerHint : "";

    const manifestText = clampManifest(manifest, options.manifestMaxChars);
    const project = projectLabel(currentWorkspace);

    let prompt = `
${SYSTEM_PROMPT}${pluginBlock}${skillBlock}${providerBlock}

项目：${project}（本机目录，下面出现的路径都相对它）

Workspace Manifest

${manifestText}

用户任务

${task}

现在开始，第一步通常先 read 看结构。
`;
    return prompt;
}

module.exports = {
    getFirstPrompt,
    projectLabel,
    clampManifest,
    DEFAULT_MANIFEST_MAX_CHARS,
};
