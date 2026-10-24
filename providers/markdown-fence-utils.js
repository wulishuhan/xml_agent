// Markdown 围栏平衡与 XML 候选提取工具。
// 为规避写入管线对反斜杠/美元符/三反引号的破坏，围栏与反斜杠用 fromCharCode 构造，
// 逻辑与历史实现保持一致。
var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;
var NL = String.fromCharCode(10);
var BS = String.fromCharCode(92);
var RE_FENCE_TRAILING = new RegExp("[^" + BS + "s" + BT + "]");
var RE_CODE_KEYWORDS = new RegExp(
    BS + "b(const|let|var|function|return|class|import|export|if|for|while)" + BS + "b"
);
var RE_CODE_PUNCT = new RegExp("[;{}()[]" + BS + "<>]=?");
var RE_INDENT = new RegExp(NL + BS + "s+" + BS + "S");
var RE_LEAD_WS = new RegExp("^" + BS + "s+");
var RE_TRAIL_WS = new RegExp(BS + "s+$");
// 注意：这里必须与 parse/xml-parse.js 的 validateAction 支持的 action 名称保持一致，
// 否则大模型回复里只包含 screenshot 时会被当成“没有 XML Action”而丢弃。
var RE_ACTION = new RegExp("<(read|write|exec|screenshot|answer|done)(?:" + BS + "s[^>]*)?/?>");
function balanceMarkdownFences(value) {
    if (value == null) {
        return "";
    }
    var text = String(value);
    var count = 0;
    var index = 0;
    while ((index = text.indexOf(FENCE, index)) !== -1) {
        count += 1;
        index += FENCE.length;
    }
    if (count === 0 || count % 2 === 0) {
        return text;
    }
    var lastFence = text.lastIndexOf(FENCE);
    var lineStart = text.lastIndexOf(NL, lastFence - 1) + 1;
    var fenceLine = text.slice(lineStart, lastFence + FENCE.length);
    var suffix = text.slice(lastFence + FENCE.length);
    if (RE_FENCE_TRAILING.test(fenceLine.slice(FENCE.length))) {
        return text + NL + FENCE;
    }
    var codeLike =
        RE_CODE_KEYWORDS.test(suffix) || RE_CODE_PUNCT.test(suffix) || RE_INDENT.test(suffix);
    if (codeLike) {
        return text + NL + FENCE;
    }
    return text.slice(0, lastFence).replace(RE_TRAIL_WS, "");
}
function extractXmlFromCandidate(value) {
    if (value == null) {
        return null;
    }
    var text = String(value).trim();
    if (!text) {
        return null;
    }
    var guard = 0;
    while (text.indexOf(FENCE) === 0 && guard < 10) {
        guard += 1;
        text = text.slice(FENCE.length).replace(RE_LEAD_WS, "");
        var head = text.slice(0, 3).toLowerCase();
        if (head === "xml") {
            text = text.slice(3).replace(RE_LEAD_WS, "");
        } else {
            break;
        }
    }
    guard = 0;
    while (
        text.length >= FENCE.length &&
        text.slice(text.length - FENCE.length) === FENCE &&
        guard < 10
    ) {
        guard += 1;
        text = text.slice(0, text.length - FENCE.length).replace(RE_TRAIL_WS, "");
    }
    text = text.trim();
    var match = text.match(RE_ACTION);
    if (!match) {
        return null;
    }
    if (match.index > 0) {
        text = text.slice(match.index).trim();
    }
    return text || null;
}
module.exports = {
    FENCE: FENCE,
    balanceMarkdownFences: balanceMarkdownFences,
    extractXmlFromCandidate: extractXmlFromCandidate,
};
