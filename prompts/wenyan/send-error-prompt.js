/**
 * 文言文协议发送失败续接提示词（实验协议 wenyan）
 * 模型未收到消息时补发。文言行文，按错误类别给一句人话原因。
 */
const SEND_ERROR_VARIANTS = [
    // 0
    (reason) => `
前步未达：${reason}。视同未行，勿造果；再出一令。
`,
    // 1
    (reason) => `
未达（${reason}）。前步作废，勿臆其成；再出一令。
`,
    // 2
    (reason) => `
发送失败（${reason}）。勿以为已行，勿造果；重出一令。
`,
    // 3
    (reason) => `
未达（${reason}）。前步作废，勿造果，再出一令。
`,
];

const SEND_ERROR_VARIANT_COUNT = SEND_ERROR_VARIANTS.length;

function humanReason(error) {
    const code = error && error.code;
    const message = String((error && error.message) || "");
    if (code === "EMPTY_RESPONSE" || /empty response|no reply|回复为空/i.test(message)) {
        return "所答为空";
    }
    if (/did not take effect|input box was not cleared/i.test(message)) {
        return "消息未发出";
    }
    if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|EAI_AGAIN/i.test(message)) {
        return "连接超时";
    }
    return "连接中断";
}

function resolveTemplate(variant) {
    return Number.isInteger(variant) && variant >= 0 && variant < SEND_ERROR_VARIANTS.length
        ? SEND_ERROR_VARIANTS[variant]
        : SEND_ERROR_VARIANTS[0];
}

function getSendErrorPrompt(error, options = {}) {
    return resolveTemplate(options.variant)(humanReason(error));
}

module.exports = {
    getSendErrorPrompt,
    humanReason,
    SEND_ERROR_VARIANT_COUNT,
};
