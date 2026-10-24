const assert = require("assert");
const {
    extractXmlFromCandidate,
    balanceMarkdownFences,
} = require("../providers/markdown-fence-utils");
const { extractXML } = require("../parse/xml-parse");
async function run() {
    // 1. 纯 screenshot 自闭合，前面没有围栏
    const plain = '<screenshot source="screen" path="a.png"/>';
    assert.strictEqual(extractXmlFromCandidate(plain), plain);
    // 2. 带围栏 + xml 标记
    const fenced =
        '`xml\n<screenshot source="window" windowTitle="Visual Studio Code" path="b.png"/>\n`';
    const extracted = extractXmlFromCandidate(fenced);
    assert(extracted, "should extract screenshot from fenced text");
    assert(extracted.startsWith("<screenshot"), "extracted should start with screenshot");
    // 3. 前面有多余文字
    const withPrefix =
        '好的，我来截图。\n<screenshot source="browser_page" url="https://example.com" path="c.png"/>';
    const fromPrefix = extractXmlFromCandidate(withPrefix);
    assert(fromPrefix && fromPrefix.startsWith("<screenshot"), "should strip leading prose");
    // 4. 提取后能被 extractXML 正确解析
    const action = extractXML(extracted);
    assert.strictEqual(action.action, "screenshot");
    assert.strictEqual(action.node["@_source"], "window");
    assert.strictEqual(action.node["@_windowTitle"], "Visual Studio Code");
    // 5. 围栏平衡不被破坏
    const balanced = balanceMarkdownFences(fenced + "```");
    assert(typeof balanced === "string");
    // 6. 原有 read 仍能提取（回归）
    const readFenced = '`\n<read path="package.json"/>\n`';
    const readExtracted = extractXmlFromCandidate(readFenced);
    assert(readExtracted && readExtracted.startsWith("<read"), "read should still be extracted");
    // 7. 不带任何 action 的文本返回 null
    assert.strictEqual(extractXmlFromCandidate("只是一段普通文字，没有动作"), null);
    console.log("EXTRACT_OK");
    console.log("fenced-> " + extracted.slice(0, 60));
    console.log("prefix-> " + fromPrefix.slice(0, 60));
}
run().catch((error) => {
    console.error("EXTRACT TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
