const { MAX_READ_CHARS } = require("../parse/action-schema");

const MAX_STRING_CHARS = 4000;
const MAX_ARRAY_ITEMS = 200;
const MAX_DEPTH = 6;

function truncateText(text) {
    if (text.length <= MAX_STRING_CHARS) {
        return text;
    }
    return (
        text.slice(0, MAX_STRING_CHARS) +
        "\n... (truncated, " +
        text.length +
        " chars in total; request a smaller or paginated result)"
    );
}

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

function promptView(result) {
    if (result && typeof result === "object" && result.promptView) {
        return result.promptView;
    }
    return result;
}

function stringifyResult(result) {
    return JSON.stringify(compactValue(promptView(result), 0));
}

const OK_TEMPLATES = [
    (json) => `
上一轮执行完了，结果：
${json}

继续下一步，只输出一个 JSON 动作对象。局部修改用 {"action":"edit","params":{"path":"...","changes":[{"old":"...","new":"..."}]}}；能答复用户就输出 {"action":"answer","params":{"content":"最终答案"}}；任务结束且无需补充就输出 {"action":"done","params":{}}。每次只发一个动作。
`,
    (json) => `
刚才那步做完了，实际返回：
${json}

接着往下走，只回一个 JSON 动作对象。改几处用 {"action":"edit","params":{"path":"...","changes":[{"old":"...","new":"..."}]}}；能答复用户用 {"action":"answer","params":{"content":"最终答案"}}；结束且无需补充用 {"action":"done","params":{}}。
`,
    (json) => `
上一条指令的执行结果贴下面：
${json}

请继续下一步，仍按首轮协议输出一个 JSON 动作对象。局部修改优先 edit；可以交付时用 {"action":"answer","params":{"content":"最终答案"}}；任务收尾且无需补充时用 {"action":"done","params":{}}。一次只发一个动作。
`,
    (json) => `
执行完了，结果是：
${json}

下一步只给一个 JSON 动作对象。局部改动用 edit，能答了用 {"action":"answer","params":{"content":"最终答案"}}，结束用 {"action":"done","params":{}}；不要输出 XML 或多个动作。
`,
];

const ERROR_TEMPLATES = [
    (json) => `
这一轮执行失败，真实返回：
${json}

依据错误修正，只输出一个 JSON 动作对象。缺依赖就安装，路径或语法错了就改，必要时重新验证；修不好就用 {"action":"answer","params":{"content":"错误原因"}} 如实说明。
`,
    (json) => `
刚才这步没成功，报错原文：
${json}

照着报错处理，只回一个 JSON 动作对象。缺什么补什么，路径或语法不对就改，需要时再跑一次；无法修复就用 {"action":"answer","params":{"content":"真实原因"}} 说明。
`,
    (json) => `
上一条动作执行出错，返回如下：
${json}

请根据实际错误继续，输出一个 JSON 动作对象。必要时修正依赖、路径或语法并重新验证；无法修复时使用 {"action":"answer","params":{"content":"真实原因"}} 如实说明。
`,
    (json) => `
执行失败，返回：
${json}

按真实报错修正，只输出一个 JSON 动作对象。修不好就用 {"action":"answer","params":{"content":"真实原因"}} 说明，不要编造结果。
`,
];

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
        const continuation = {
            action: "read",
            params: {
                path: result.path,
                offset: result.nextOffset,
                limit: Number.isInteger(result.limit) ? result.limit : MAX_READ_CHARS,
            },
        };
        return (
            prompt +
            "\n文件尚未读完。下一次必须继续读取同一文件，使用返回的 nextOffset；不要把当前片段当成全文。\n" +
            JSON.stringify(continuation) +
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
