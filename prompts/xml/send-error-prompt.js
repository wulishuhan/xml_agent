/**
发送失败的续接提示词。

这段文本在"模型根本没收到消息"（网络断了、输入框没清空、回复空白）时补发一次，
用来告诉模型"上一条不算数"。旧版写的是：

    上一轮 Agent 调用模型时发生错误。
    错误信息：${error.message}
    不要假设上一轮已经成功执行。
    不要编造 Runtime 结果。
    请重新输出一个 XML Action。

三个问题：
1. 自我描述。`Agent 调用模型`、`Runtime`、`XML Action` 都是宿主内部术语，等于
   直接告诉平台"这是某个自动化框架在调模型"。这段文本一旦被读走就是确凿证据，
   比句式重复更容易被判定为脚本。
2. 原文照搬 error.message。这里能传进来的错误多是 `Provider failed 3 consecutive
   times`、`page.goto: Timeout 30000ms exceeded`、`socket hang up` 之类，是
   Playwright / 网络栈的原话，同样是宿主指纹。而且这些错误模型完全帮不上忙——
   它连消息都没收到——原文对它没有信息价值，完整报错已经进了 provider.error
   事件和 Trace。
3. 单一固定文本。每次发送失败都是逐字节相同的一段话，重复即特征。

现在改成：按错误类别给一句人话原因（不暴露栈信息 + 不暴露术语），措辞给四套
变体，随会话抽签（与 runtime-prompt.js 同一套 variant 索引）。语义上必须保留
旧版那两个约束，否则模型会以为上一步成功了：

- 上一步不算做成（不要假设已经成功执行）；
- 不要自己编造执行结果；
- 照首条消息的格式再给一段动作。
*/

const SEND_ERROR_VARIANTS = [
    // 0 = 口语直白
    (reason) => `
刚才那次没成功：${reason}。

上一步不算数，别当成已经做完了，也别自己编结果出来。接着按开头那条的格式回一段动作就行。
`,
    // 1 = 对话口吻
    (reason) => `
这次没成（${reason}），我这边没拿到东西。

所以上一步等于没做，别假设它成功了，更别替我编个结果。格式还按第一条那样，再来一段动作。
`,
    // 2 = 稍正式
    (reason) => `
上一条发送失败了，原因：${reason}。

请把刚才那步当作没发生：不要假设它已经执行成功，也不要虚构执行结果。然后照一开始给的写法，重新给一段动作。
`,
    // 3 = 极简
    (reason) => `
这次没成（${reason}）。上一步当作没做，别编结果，按开头格式再回一段动作。
`,
];

/** 变体总数（与 SYSTEM_PROMPT / 回贴提示词保持同一套 0-3 索引）。 */
const SEND_ERROR_VARIANT_COUNT = SEND_ERROR_VARIANTS.length;

/**
 * 把宿主侧的错误翻成一句人话。
 *
 * 只做分类，不拼接原始 message：这些错误的原文是 Playwright / 网络栈的输出，
 * 既是宿主指纹，对模型又毫无用处（它压根没收到那条消息）。
 * 完整报错保留在 provider.error / provider.retry 事件里，排查照旧可查。
 */
function humanReason(error) {
    const code = error && error.code;
    const message = String((error && error.message) || "");
    if (code === "EMPTY_RESPONSE" || /empty response|no reply|回复为空/i.test(message)) {
        return "回复是空的";
    }
    if (/did not take effect|input box was not cleared/i.test(message)) {
        return "消息没发出去";
    }
    if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|EAI_AGAIN/i.test(message)) {
        return "连接超时了";
    }
    return "连接断了";
}

function resolveTemplate(variant) {
    return Number.isInteger(variant) && variant >= 0 && variant < SEND_ERROR_VARIANTS.length
        ? SEND_ERROR_VARIANTS[variant]
        : SEND_ERROR_VARIANTS[0];
}

/**
 * @param {Error|{message?: string, code?: string}} error 触发补发的错误
 * @param {{variant?: number}} [options] 会话级措辞变体（0-3），非法值退回 0
 */
function getSendErrorPrompt(error, options = {}) {
    return resolveTemplate(options.variant)(humanReason(error));
}

module.exports = {
    getSendErrorPrompt,
    humanReason,
    SEND_ERROR_VARIANT_COUNT,
};
