/**
每轮回给模型的结果 + 下一步提示

一轮任务里这段文本会重复发送几十次，所以它必须短。旧版每轮都把 <read> / <write>
/ <edit> / <exec> / <screenshot> 的用法和示例重抄一遍（约 700 字符），实际信息量
只有"上一轮结果 + 继续"；而几十轮高度重复的模板文本，正是网页平台判定"脚本在
批量调用"的典型特征。语法说明只放在首轮（prompts/system-prompt.js）就够了。

结果本身也做了收敛：旧的 `JSON.stringify(x, null, 2)` 会把一个 20000 字符的
响应体原样铺开成上百行，既撑上下文又让整条消息看起来像日志倾倒。现在用紧凑
JSON，并对超长字符串 / 超长数组做截断并标注，模型仍能看出"这里被截了"。
*/

/** 单个字符串值超过这个长度就截断（字符）。 */
const MAX_STRING_CHARS = 4000;
/** 数组最多保留这么多项。 */
const MAX_ARRAY_ITEMS = 200;
/** 递归深度上限，防止插件返回的自引用结构把栈打爆。 */
const MAX_DEPTH = 6;

function truncateText(text) {
    if (text.length <= MAX_STRING_CHARS) {
        return text;
    }
    return (
        text.slice(0, MAX_STRING_CHARS) +
        "\n... (truncated, " +
        text.length +
        " chars in total; read again with a narrower path or use exec for the rest)"
    );
}

/**
把结果收敛成"能读懂但不啰嗦"的普通对象：长字符串截断、长数组截断、深度设限。
只处理 JSON 可表达的类型，其余（函数、Symbol）直接丢弃——它们本来也 stringify 不出来。
*/
function compactValue(value, depth) {
    if (typeof value === "string") {
        return truncateText(value);
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (depth >= MAX_DEPTH) {
        return Array.isArray(value) ? "[...]" : "{...}";
    }
    if (Array.isArray(value)) {
        const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) {
            kept.push("... (" + value.length + " items in total)");
        }
        return kept;
    }
    const output = {};
    for (const key of Object.keys(value)) {
        const child = value[key];
        if (typeof child === "function" || typeof child === "symbol") {
            continue;
        }
        output[key] = compactValue(child, depth + 1);
    }
    return output;
}

// 回给模型的结果视图：插件动作可能返回很大的结果（例如 HTTP 响应体），
// registry 会提供 promptView 精简视图，完整结果只留在 Trace / 报告里。
function promptView(result) {
    if (result && typeof result === "object" && result.promptView) {
        return result.promptView;
    }
    return result;
}

function stringifyResult(result) {
    return JSON.stringify(compactValue(promptView(result), 0));
}

/**
 * 回贴措辞变体池。
 *
 * 一轮任务里这类消息会发几十次，句式高度重复是自动化指纹的主要来源。
 * 这里给出 4 套语义等价的模板：索引 0 是原文基准（不传 variant 时使用，
 * 保证指纹测试与旧调用方逐字兼容），1-3 是改写版。
 *
 * 每套模板都必须保留三样东西，否则会破坏协议或测试：
 * - 单行紧凑 JSON 结果（stringifyResult 的返回值，含 {"ok":...}）；
 * - 至少一个可解析的 <answer><![CDATA[...]]></answer> 或 <done/>；
 * - 整体足够短（成功 < 600 字符、失败 < 400 字符，见 test-first-prompt.js）。
 */
const OK_TEMPLATES = [
    // 0 = 原文基准
    (json) => `
上一轮执行完了，结果：
${json}

继续下一步，动作按第一条消息里的格式写（read / write / edit / exec / screenshot；只改几处就用 <edit>，不要整篇重写）。
能回答用户了就只回 <answer><![CDATA[最终答案]]></answer>（这一轮不要带 <done/>）；任务结束且无需多说就回 <done/>。每次只发一段动作。
`,
    // 1 = 口语
    (json) => `
刚才那步做完了，实际返回：
${json}

接着往下走，动作还按开头第一条的格式写（read / write / edit / exec / screenshot；局部改动用 <edit>，别整篇覆盖）。
能答复用户了就只回 <answer><![CDATA[最终答案]]></answer>（这轮别带 <done/>）；事情办完不用多说就回 <done/>。一次只发一段动作。
`,
    // 2 = 工单
    (json) => `
上一条指令的执行结果贴下面：
${json}

请继续下一步，动作格式参照首条消息（read / write / edit / exec / screenshot；小改动优先 <edit>，不要重写整个文件）。
可以向用户交付时就只回 <answer><![CDATA[最终答案]]></answer>（本轮不要带 <done/>）；任务收尾且无需补充就回 <done/>。每轮只发一段动作。
`,
    // 3 = 简短
    (json) => `
执行完了，结果是：
${json}

下一步照第一条消息的写法给动作（read / write / edit / exec / screenshot；改几处用 <edit>，别整篇重写）。
能答了就只回 <answer><![CDATA[最终答案]]></answer>（这轮不带 <done/>）；结束就回 <done/>。每次只发一段动作。
`,
];

const ERROR_TEMPLATES = [
    // 0 = 原文基准
    (json) => `
这一轮执行失败，真实返回：
${json}

看错误自己修：缺依赖就装，路径或语法错了就改，必要时重跑验证。修不好就回 <answer><![CDATA[错误原因]]></answer>，如实说清楚。每次只发一段动作。
`,
    // 1 = 口语
    (json) => `
刚才这步没成功，报错原文：
${json}

照着报错自己处理：缺什么装什么，路径写错就改，不好说就重跑一次确认。实在不行就回 <answer><![CDATA[错误原因]]></answer>，如实讲清楚。一次只发一段动作。
`,
    // 2 = 工单
    (json) => `
上一条动作执行出错，返回如下：
${json}

请依据实际错误自行修正：依赖缺失就安装，路径或语法有误就调整，必要时重新执行验证。无法修复时回 <answer><![CDATA[错误原因]]></answer> 说明情况。每轮只发一段动作。
`,
    // 3 = 简短
    (json) => `
执行失败，返回：
${json}

按真实报错修：缺依赖就装，路径/语法错就改，必要时重跑。修不好就回 <answer><![CDATA[错误原因]]></answer>。每次只发一段动作。
`,
];

/** 回贴模板总数（含索引 0 的原文基准）。 */
const RUNTIME_PROMPT_VARIANT_COUNT = OK_TEMPLATES.length;

function resolveTemplate(templates, variant) {
    const resolved =
        Number.isInteger(variant) && variant >= 0 && variant < templates.length ? variant : 0;
    return templates[resolved];
}

function getRuntimeOkPrompt(result, options = {}) {
    const prompt = resolveTemplate(OK_TEMPLATES, options.variant)(stringifyResult(result));
    if (
        result &&
        result.action === "read" &&
        result.truncated === true &&
        Number.isInteger(result.nextOffset)
    ) {
        const limit = Number.isInteger(result.limit) ? result.limit : 4000;
        const continuation = '<read path="' + result.path + '" offset="' + result.nextOffset + '" limit="' + limit + '"/>';
        return (
            prompt +
            "\n文件尚未读完。下一次必须继续读取同一文件，用返回的 nextOffset；不要把当前片段当成全文。\n" +
            continuation +
            "\n"
        );
    }
    return prompt;
}

function getRuntimeErrorPrompt(result, options = {}) {
    return resolveTemplate(ERROR_TEMPLATES, options.variant)(stringifyResult(result));
}

module.exports = {
    getRuntimeOkPrompt,
    getRuntimeErrorPrompt,
    compactValue,
    stringifyResult,
    RUNTIME_PROMPT_VARIANT_COUNT,
};
