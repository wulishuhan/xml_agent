/**
插件提示词区块

系统提示词里的"内置动作文档"仍然是手写的（prompts/system-prompt.js），
插件动作的文档由本模块自动生成：注册项里的 meta.prompt 就是唯一来源。

两个关键约束（见 docs/PLUGIN_DESIGN.md §3.1 ②）：
1. 没有启用的插件动作时，本模块返回空字符串，不追加额外区块；
2. 有插件动作时按字符预算裁剪，避免插件变多后把首轮提示词撑爆
   —— 两套协议对提示词长度都很敏感。

协议感知：meta.prompt.usage 历史上是 JSON 写法。XML 协议下折算成标签，
JSON 协议下原样使用；复杂参数可用 usageXml / usageJson 显式声明。
老插件若写了异协议示例，降级成文字说明，不把模型带偏。
*/

const { getRegistrySafe } = require("../plugins/registry");

const DEFAULT_MAX_PROMPT_CHARS = 8000;

/** XML 属性值转义：& " < > 必须转实体，否则标签会被截断。 */
function escapeXmlAttr(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * 把 JSON 用法示例折算成简单 XML 标签，避免 XML 协议下提示词里混进 JSON 示例。
 *
 * 仅当 params 全是标量时才安全转换；遇到数组 / 对象（例如 screenshot 的 targets）
 * 返回空串，让调用方降级成文字说明 —— 复杂结构有专有写法，猜出来的标签反而会
 * 把模型带偏。插件也可以在 meta.prompt.usageXml 里直接声明 XML 示例，优先级最高。
 *
 * @param {string} usage 形如 {"action":"fetch","params":{"url":"...","method":"GET"}}
 * @returns {string} 形如 <fetch url="..." method="GET"/>，无法转换时返回 ""
 */
function jsonUsageToXml(usage) {
    const text = String(usage || "").trim();
    // 插件原生就给了 XML 示例（或不是 JSON），原样使用。
    if (!text.startsWith("{")) {
        return text;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return "";
    }
    if (!parsed || typeof parsed.action !== "string" || !/^[A-Za-z][\w-]*$/.test(parsed.action)) {
        return "";
    }
    const params =
        parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
            ? parsed.params
            : {};
    const attrs = [];
    for (const key of Object.keys(params)) {
        const value = params[key];
        if (!/^[A-Za-z][\w-]*$/.test(key) || value === null || typeof value === "object") {
            return "";
        }
        attrs.push(key + '="' + escapeXmlAttr(value) + '"');
    }
    return "<" + parsed.action + (attrs.length ? " " + attrs.join(" ") : "") + "/>";
}

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
@param {object} options { task, maxPromptChars, protocol }
@returns {string} 空字符串表示没有可用插件动作
*/
function buildPluginPromptSection(registry, options = {}) {
    const isXml = String(options.protocol || "").toLowerCase() === "xml";
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

    // 头部只保留必要信息：系统提示词里已经交代过"每次只发一段动作"和报错会被拒绝，
    // 这里再抄一遍只会让首轮消息更长（网页平台按"用户消息"读，越长越像脚本）。
    const lines = [
        "插件能力（Plugin Actions）",
        isXml
            ? "以下动作由插件提供，写法同前面的 XML 动作（标签名即动作名，参数写成属性）："
            : "以下动作由插件提供，使用相同的 {action, params} 结构：",
        "",
    ];

    let used = lines.join("\n").length;
    let skipped = 0;
    let currentGroup = null;

    for (const item of sorted) {
        const block = renderContribution(item, currentGroup, isXml);
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

function renderContribution(item, currentGroup, isXml) {
    const lines = [];
    if (item.group !== currentGroup) {
        lines.push("[" + groupTitle(item.group) + "]");
    }
    lines.push("- " + item.action + "（插件 " + item.plugin + "）");
    if (isXml) {
        // 插件自带 XML 示例优先；否则把简单 JSON 示例折算成标签。
        const xmlUsage =
            typeof item.usageXml === "string" && item.usageXml.trim()
                ? item.usageXml.trim()
                : jsonUsageToXml(item.usage);
        lines.push(
            xmlUsage
                ? "  " + xmlUsage
                : "  写法同前面的 XML 动作：标签名即动作名，参数写成属性；复杂参数照首条消息里的示例。"
        );
    } else {
        // 老插件的 usage 可能是 XML 写法（项目早期只支持 XML）；JSON 会话下不能照抄。
        const text = String(item.usage || "").trim();
        const jsonUsage =
            typeof item.usageJson === "string" && item.usageJson.trim()
                ? item.usageJson.trim()
                : text.startsWith("{")
                  ? text
                  : "";
        lines.push(
            jsonUsage
                ? "  " + jsonUsage
                : "  写法按本会话首条消息给的 JSON 协议（action + params 对象）。"
        );
    }
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
