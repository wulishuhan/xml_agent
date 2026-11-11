/**
插件提示词区块

系统提示词里的"内置动作文档"仍然是手写的（prompts/system-prompt.js），
插件动作的文档由本模块自动生成：注册项里的 meta.prompt 就是唯一来源。

两个关键约束（见 docs/PLUGIN_DESIGN.md §3.1 ②）：
1. 没有启用的插件动作时，本模块返回空字符串，首轮提示词与 1.0.x 逐字节一致；
2. 有插件动作时按字符预算裁剪，避免插件变多后把首轮提示词撑爆
   —— XML 协议类 Agent 的输出稳定性对提示词长度非常敏感。
*/

const { getRegistrySafe } = require("../plugins/registry");

const DEFAULT_MAX_PROMPT_CHARS = 8000;

const GROUP_TITLES = {
    network: "网络",
    workspace: "工作区",
    system: "系统",
    data: "数据",
    quality: "质量",
    session: "会话",
    plugin: "插件",
};

function groupTitle(group) {
    return GROUP_TITLES[group] || group;
}

/**
把插件动作渲染成提示词区块。
@param {object|null} registry 传入 undefined 时使用全局单例
@param {object} options { task, maxPromptChars }
@returns {string} 空字符串表示没有可用插件动作
*/
function buildPluginPromptSection(registry, options = {}) {
    const activeRegistry = registry === undefined ? getRegistrySafe() : registry;
    if (!activeRegistry || typeof activeRegistry.listPromptContributions !== "function") {
        return "";
    }
    let contributions = [];
    try {
        contributions = activeRegistry.listPromptContributions({ task: options.task });
    } catch (error) {
        return "";
    }
    if (!Array.isArray(contributions) || contributions.length === 0) {
        return "";
    }

    const maxChars = resolveMaxChars(activeRegistry, options);
    const sorted = contributions.slice().sort(compareContribution);

    const lines = [
        "============================================================",
        "插件能力（Plugin Actions）",
        "============================================================",
        "以下能力由插件提供，用法与内置 XML Action 完全一致：",
        "- 一次只能输出一个 XML Action，不要输出 Action 之外的说明。",
        "- 参数写错会被拒绝，错误信息里会列出允许的属性。",
        "",
    ];

    let used = lines.join("\n").length;
    let skipped = 0;
    let currentGroup = null;

    for (const item of sorted) {
        const block = renderContribution(item, currentGroup);
        if (used + block.length > maxChars) {
            skipped += 1;
            continue;
        }
        lines.push(block.trimEnd());
        used += block.length;
        currentGroup = item.group;
    }

    if (skipped > 0) {
        lines.push(
            "（另有 " +
                skipped +
                " 个插件动作因提示词预算未展示，说明太长；如确有必要可让用户提高 plugins.maxPromptChars。）"
        );
    }

    return lines.join("\n");
}

function resolveMaxChars(registry, options) {
    if (Number.isFinite(Number(options.maxPromptChars)) && Number(options.maxPromptChars) > 0) {
        return Math.trunc(Number(options.maxPromptChars));
    }
    if (registry && Number.isFinite(Number(registry.maxPromptChars))) {
        return Math.trunc(Number(registry.maxPromptChars));
    }
    return DEFAULT_MAX_PROMPT_CHARS;
}

function compareContribution(left, right) {
    const groupLeft = String(left.group || "");
    const groupRight = String(right.group || "");
    if (groupLeft !== groupRight) {
        return groupLeft.localeCompare(groupRight);
    }
    const priorityLeft = Number(left.priority) || 0;
    const priorityRight = Number(right.priority) || 0;
    if (priorityLeft !== priorityRight) {
        return priorityRight - priorityLeft;
    }
    return String(left.action).localeCompare(String(right.action));
}

function renderContribution(item, currentGroup) {
    const lines = [];
    if (item.group !== currentGroup) {
        lines.push("[" + groupTitle(item.group) + "]");
    }
    lines.push("- " + item.action + "（插件 " + item.plugin + "）");
    lines.push("  " + item.usage);
    if (item.note) {
        lines.push("  " + item.note);
    }
    lines.push("");
    return lines.join("\n");
}

module.exports = {
    buildPluginPromptSection,
    DEFAULT_MAX_PROMPT_CHARS,
    GROUP_TITLES,
};
