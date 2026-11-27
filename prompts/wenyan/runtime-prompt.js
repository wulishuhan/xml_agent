/**
 * 文言文协议每轮结果回贴（实验协议 wenyan）
 * 结果本身用紧凑 JSON（数据，越短越好），协议措辞用文言。
 * 与 xml 版共用同样的截断/收敛逻辑，保证行为一致。
 */

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
        " chars in total; read again with a narrower path or use exec for the rest)"
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
    // 0 = 原文基准
    (json) => `
果：
${json}

续出一令；可答则 答｜「答语」（勿并 毕），事竟只 毕。每轮一令。
`,
    // 1
    (json) => `
上行之果：
${json}

再出一令。能答则 答｜「答语」（莫并 毕）；事了只 毕。一轮一令。
`,
    // 2
    (json) => `
其果如左：
${json}

请续令。可交付则 答｜「答语」（此轮勿带 毕）；收尾只 毕。每轮仅一令。
`,
    // 3
    (json) => `
果：
${json}

续令；答则 答｜「答语」（勿同 毕），竟则 毕。每轮一令。
`,
];

const ERROR_TEMPLATES = [
    // 0 = 原文基准
    (json) => `
败：
${json}

视错自正：缺者补，误者改，必要时重行；不济则 答｜「原因」。每轮一令。
`,
    // 1
    (json) => `
行而未成：
${json}

依错自修：缺者补，误者改，必要时重行；终不能则 答｜「原因」。一轮一令。
`,
    // 2
    (json) => `
此令有误：
${json}

按实错正：缺者装，路径语法误者改，必要时重行；不可救则 答｜「原因」。每轮一令。
`,
    // 3
    (json) => `
败：
${json}

自正：缺补、误改，必要时重行；不济则 答｜「原因」。每轮一令。
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
        const limit = Number.isInteger(result.limit) ? result.limit : 4000;
        const continuation = "阅 " + result.path + " " + result.nextOffset + " " + limit;
        return prompt + "\n未阅毕，须续阅：" + continuation + "，勿以片段为全文。\n";
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
