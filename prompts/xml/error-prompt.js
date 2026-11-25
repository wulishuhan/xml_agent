/**
格式没对上的续接提示词。

模型回了普通文字、回了多个动作、或者动作名/参数写错时补发一次。旧版是：

    你的上一条回复不是合法的 XML Action。
    ...
    请严格只输出一个合法 XML Action。
    例如：<read path="package.json"/>
    或者：<write><![CDATA[...]]></write>
    或者：<answer><![CDATA[...]]></answer>
    或者：<done/>

问题与 send-error-prompt.js 同源，且更重：
1. `XML Action` 是宿主自造术语，每条纠错消息里反复出现；
2. 每错一次就把 4 段 XML 示例重抄一遍（约 200 字符），几十轮下来既是长度负担，
   又是"高度重复模板"的典型特征——语法示例首条消息里已经给全了；
3. 单一固定文本，逐字节重复。

现在：一句原因 + 一句"一次只给一个动作"，至多带一个极短示例；四套变体随会话抽签。

协议约束必须保留（否则模型会改回自然语言，循环直接卡死）：
- 不解释、不写自然语言；
- 一轮只给一个动作；
- 格式照首条消息。
*/

/** 把解析器的英文报错翻成人话，顺带抹掉 `XML Action` 这类宿主术语。 */
function describeParseError(error) {
    const raw = String((error && error.message) || "").trim();
    if (!raw) {
        return "上一条的格式没对上";
    }
    if (/returned empty response/i.test(raw)) {
        return "上一条什么也没返回";
    }
    if (/No XML Action found/i.test(raw)) {
        return "上一条里没有动作";
    }
    const unknown = raw.match(/Unknown XML Action:\s*([^\s,;]+)/i);
    if (unknown) {
        return "没有 " + unknown[1] + " 这个动作名";
    }
    const multi = raw.match(/received\s+(\d+)/i);
    if (/Exactly one/i.test(raw) && multi) {
        return "一次只能给一个动作，上一条给了 " + multi[1] + " 个";
    }
    if (/^Invalid XML\b/i.test(raw)) {
        return "内容不是合法的 XML";
    }
    // 其余多为参数缺失/取值错误（如 "path is required"），本身已是人话，原样保留
    return raw;
}

const XML_ERROR_VARIANTS = [
    // 0 = 口语直白
    (reason) => `
上一条格式不对：${reason}。

别写解释文字，一轮只给一个动作，照开头那条的写法来，比如 <read path="."/>。
`,
    // 1 = 对话口吻
    (reason) => `
这条我没看懂：${reason}。

麻烦只回一段动作，不要带说明，一次一个，格式跟第一条一样（形如 <read path="."/>）。
`,
    // 2 = 稍正式
    (reason) => `
上一条回复无法解析，原因：${reason}。

请不要附带任何解释，每轮仅输出一个动作，写法参照首条消息，例如 <read path="."/>。
`,
    // 3 = 极简
    (reason) => `
格式错了（${reason}）。只回一个动作，别解释，形如 <read path="."/>。
`,
];

/** 变体总数（与 SYSTEM_PROMPT / 回贴提示词保持同一套 0-3 索引）。 */
const XML_ERROR_VARIANT_COUNT = XML_ERROR_VARIANTS.length;

function resolveTemplate(variant) {
    return Number.isInteger(variant) && variant >= 0 && variant < XML_ERROR_VARIANTS.length
        ? XML_ERROR_VARIANTS[variant]
        : XML_ERROR_VARIANTS[0];
}

/**
 * @param {Error|{message?: string}} error 解析失败的错误
 * @param {{variant?: number}} [options] 会话级措辞变体（0-3），非法值退回 0
 */
function getXmlErrorPrompt(error, options = {}) {
    return resolveTemplate(options.variant)(describeParseError(error));
}

module.exports = {
    getXmlErrorPrompt,
    describeParseError,
    XML_ERROR_VARIANT_COUNT,
};
