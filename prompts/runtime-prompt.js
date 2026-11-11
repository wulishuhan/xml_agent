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

function getRuntimeOkPrompt(result) {
    return `
上一轮执行完了，结果：
${stringifyResult(result)}

继续下一步，动作按第一条消息里的格式写（read / write / edit / exec / screenshot；只改几处就用 <edit>，不要整篇重写）。
能回答用户了就只回 <answer><![CDATA[最终答案]]></answer>（这一轮不要带 <done/>）；任务结束且无需多说就回 <done/>。每次只发一段动作。
`;
}
function getRuntimeErrorPrompt(result) {
    return `
这一轮执行失败，真实返回：
${stringifyResult(result)}

看错误自己修：缺依赖就装，路径或语法错了就改，必要时重跑验证。修不好就回 <answer><![CDATA[错误原因]]></answer>，如实说清楚。每次只发一段动作。
`;
}
module.exports = {
    getRuntimeOkPrompt,
    getRuntimeErrorPrompt,
    compactValue,
    stringifyResult,
};
