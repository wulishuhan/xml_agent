const SEND_ERROR_VARIANTS = [
    (reason) => `
刚才那次没成功：${reason}。

上一步不算数，别当成已经做完了，也别自己编结果出来。接着按首轮协议输出一个 JSON 动作对象。
`,
    (reason) => `
这次没成（${reason}），我这边没拿到东西。

所以上一步等于没做，别假设它成功了，更别替我编个结果。按首轮协议重新输出一个 JSON 动作对象。
`,
    (reason) => `
上一条发送失败了，原因：${reason}。

请把刚才那步当作没发生：不要假设它已经执行成功，也不要虚构执行结果。然后按首轮协议重新输出一个 JSON 动作对象。
`,
    (reason) => `
这次没成（${reason}）。上一步当作没做，别编结果，按首轮协议重发一个 JSON 动作对象。
`,
];

const SEND_ERROR_VARIANT_COUNT = SEND_ERROR_VARIANTS.length;

function humanReason(error) {
    const code = error && error.code;
    const message = String((error && error.message) || "");
    if (code === "EMPTY_RESPONSE" || /empty response|no reply|回复为空/i.test(message)) {
        return "回复是空的";
    }
    if (/did not take effect|input box was not cleared/i.test(message)) {
        return "消息没发出去";
    }
    if (
        /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|EAI_AGAIN/i.test(
            message
        )
    ) {
        return "连接超时了";
    }
    return "连接断了";
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
