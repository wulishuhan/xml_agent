const { SYSTEM_PROMPT } = require("./system-prompt");
const { getSystemPromptVariant } = require("./system-prompt-variants");
const { buildSkillPromptSection } = require("../skill-prompt");

// 实验协议：不注入插件动作示例（其 usage 均为 JSON/XML 写法，会带偏文言会话）。
// 技能说明按协议渲染，wenyan 下技能段措辞也文言化，并给出英文动作名到文言令的映射。

const DEFAULT_MANIFEST_MAX_CHARS = 8000;

function projectLabel(workspace) {
    const text = String(workspace || "").trim();
    if (!text) {
        return "当前目录";
    }
    const parts = text.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "当前目录";
}

function clampManifest(manifest, maxChars) {
    const list = Array.isArray(manifest) ? manifest : [];
    const limit =
        Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MANIFEST_MAX_CHARS;
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

function getFirstPrompt(currentWorkspace, task, options = {}) {
    let manifest = options.manifest;
    if (Array.isArray(task)) {
        const shiftedOptions = arguments[3] || {};
        manifest = task;
        task = arguments[2];
        options = shiftedOptions;
    }

    const pluginBlock = "";

    let skillSection = "";
    try {
        skillSection = buildSkillPromptSection(options.skills, {
            maxSkills: options.maxSkills,
            protocol: "wenyan",
        });
    } catch (error) {
        skillSection = "";
    }
    const skillBlock = skillSection ? "\n\n" + skillSection : "";

    const providerHint =
        typeof options.providerHint === "string" ? options.providerHint.trim() : "";
    const providerBlock = providerHint ? "\n\n输出格式（本平台强制要求）\n\n" + providerHint : "";

    const hasManifest = Array.isArray(manifest) && manifest.length > 0;
    const manifestText = hasManifest ? clampManifest(manifest, options.manifestMaxChars) : "";
    const manifestBlock = hasManifest ? "\n\nWorkspace Manifest\n\n" + manifestText : "";
    const project = projectLabel(currentWorkspace);

    const systemPrompt =
        options.systemPromptVariant === undefined
            ? SYSTEM_PROMPT
            : getSystemPromptVariant(options.systemPromptVariant);

    // 文言协议下，插件/技能说明里若有非文言示例也无妨——动作语法以本首条为准。
    const prompt = `
${systemPrompt}${pluginBlock}${skillBlock}${providerBlock}

项目：${project}（本机目录，下面出现的路径都相对它）${manifestBlock}

用户任务

${task}

首步宜 阅。
`;
    return prompt;
}

module.exports = {
    getFirstPrompt,
    projectLabel,
    clampManifest,
    DEFAULT_MANIFEST_MAX_CHARS,
};
