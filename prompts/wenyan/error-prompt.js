/**
 * 文言文协议格式纠错提示词（实验协议 wenyan）
 * 解析失败时补发。文言行文 + 一个极短文言示例。
 */
function describeParseError(error) {
    const raw = String((error && error.message) || "").trim();
    if (!raw) {
        return "上一条格式未合";
    }
    if (/returned empty response/i.test(raw)) {
        return "上一条空无所答";
    }
    if (/Unknown Wenyan Action/i.test(raw)) {
        return "上一条动词不识";
    }
    const multi = raw.match(/received\s+(\d+)/i);
    if (/Exactly one/i.test(raw) && multi) {
        return "一轮只可出一令，上一条出了 " + multi[1] + " 个";
    }
    // 参数错误（path is required 等）本身已可读，原样保留
    return raw;
}

const WENYAN_ERROR_VARIANTS = [
    // 0
    (reason) => `
上条不合：${reason}。勿释，每轮一令，如 阅 a.js。
`,
    // 1
    (reason) => `
未解：${reason}。只回一令，式如 阅 a.js。
`,
    // 2
    (reason) => `
前条难解（${reason}）。勿附它言，一令即可，如 阅 a.js。
`,
    // 3
    (reason) => `
格式谬（${reason}）。只一令，如 阅 a.js。
`,
];

const WENYAN_ERROR_VARIANT_COUNT = WENYAN_ERROR_VARIANTS.length;

function resolveTemplate(variant) {
    return Number.isInteger(variant) && variant >= 0 && variant < WENYAN_ERROR_VARIANTS.length
        ? WENYAN_ERROR_VARIANTS[variant]
        : WENYAN_ERROR_VARIANTS[0];
}

function getWenyanErrorPrompt(error, options = {}) {
    return resolveTemplate(options.variant)(describeParseError(error));
}

module.exports = {
    getWenyanErrorPrompt,
    describeParseError,
    WENYAN_ERROR_VARIANT_COUNT,
};
