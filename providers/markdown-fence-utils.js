// Markdown 围栏平衡与 JSON Action 候选提取工具。
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
var RE_TRAIL_WS = new RegExp(BS + "s+$");
var jsonCandidate = require("../parse/json-candidate");
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
function extractJsonActionCandidate(value) {
    if (value == null) {
        return null;
    }
    var text = String(value).trim();
    if (!text) {
        return null;
    }
    // 返回原始候选文本而不是重新序列化对象，保留 params 的格式与转义。
    // 多个 envelope 时返回完整回复，交给解析层报告数量错误，避免静默挑掉其中一个。
    var candidates = jsonCandidate.findJsonObjects(text);
    var actionCandidates = [];
    for (var i = 0; i < candidates.length; i++) {
        try {
            jsonCandidate.extractActionEnvelope(candidates[i]);
            actionCandidates.push(candidates[i]);
        } catch (error) {
            // 说明文字里的非 envelope JSON 对象不是动作候选。
        }
    }
    if (actionCandidates.length === 1) {
        return actionCandidates[0];
    }
    if (actionCandidates.length > 1) {
        return text;
    }
    return null;
}
module.exports = {
    FENCE: FENCE,
    balanceMarkdownFences: balanceMarkdownFences,
    extractJsonActionCandidate: extractJsonActionCandidate,
};
