// 纯文本清洗工具：从代码块文本中剔除 DeepSeek 代码块工具栏带来的
// 无关标签（text / 复制 / 下载 / Copy / Download / 代码 / Code）。
// 为了避免写入管线对反斜杠、美元符、三反引号的破坏，这里尽量不用
// 复杂正则，而是用 split/map/filter 逐行处理。
var CODE_TOOLBAR_LABELS = ["复制", "下载", "Copy", "Download", "text", "代码", "Code"];
function isToolbarLine(line) {
    var trimmed = String(line == null ? "" : line).trim();
    if (!trimmed) {
        return false;
    }
    return CODE_TOOLBAR_LABELS.indexOf(trimmed) !== -1;
}
// 删除“整行只包含工具栏标签”的行，并折叠多余空行。
function stripCodeToolbarLabels(text) {
    if (typeof text !== "string" || !text) {
        return "";
    }
    var NL = String.fromCharCode(10);
    var lines = text.split(NL);
    var kept = [];
    for (var i = 0; i < lines.length; i += 1) {
        if (!isToolbarLine(lines[i])) {
            kept.push(lines[i]);
        }
    }
    var result = kept.join(NL);
    // 折叠 3 个及以上连续换行到 2 个
    var tripleNl = NL + NL + NL;
    var doubleNl = NL + NL;
    while (result.indexOf(tripleNl) !== -1) {
        result = result.split(tripleNl).join(doubleNl);
    }
    return result;
}
module.exports = {
    CODE_TOOLBAR_LABELS: CODE_TOOLBAR_LABELS,
    isToolbarLine: isToolbarLine,
    stripCodeToolbarLabels: stripCodeToolbarLabels,
};
