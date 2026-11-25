const ERROR_TEMPLATES = [
    (reason) => `
上一条回复不是有效的 JSON 动作：${reason}

请只输出一个 JSON 动作对象，结构为 {"action":"read","params":{"path":"."}}。不要输出 XML、解释或多个动作；参数必须符合首轮协议。
`,
    (reason) => `
刚才的格式没通过：${reason}

请重新只回一个 JSON 动作对象，例如 {"action":"read","params":{"path":"."}}。不要带 XML 或其它说明，也不要一次给多个动作。
`,
    (reason) => `
上一条动作格式有误：${reason}

请按首轮 JSON 协议重新输出一个动作对象，例如 {"action":"read","params":{"path":"."}}。action 必须是字符串，params 必须是对象；不要输出 XML 或多个候选。
`,
    (reason) => `
JSON 动作格式错误：${reason}

只重发一个 JSON 动作对象，如 {"action":"read","params":{"path":"."}}；不要 XML、说明或多个动作。
`,
];

const JSON_ERROR_VARIANT_COUNT = ERROR_TEMPLATES.length;

function describeParseError(error) {
    return String((error && error.message) || "未知格式错误");
}

function getJsonErrorPrompt(error, options = {}) {
    const variant =
        Number.isInteger(options.variant) &&
        options.variant >= 0 &&
        options.variant < ERROR_TEMPLATES.length
            ? options.variant
            : 0;
    return ERROR_TEMPLATES[variant](describeParseError(error));
}

module.exports = {
    getJsonErrorPrompt,
    describeParseError,
    JSON_ERROR_VARIANT_COUNT,
};
