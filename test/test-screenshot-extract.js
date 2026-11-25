const assert = require("assert");
const {
    extractJsonActionCandidate,
    balanceMarkdownFences,
} = require("../providers/markdown-fence-utils");
const { extractAction } = require("../parse/json-action");

async function run() {
    // 1. 纯 JSON action，前面没有围栏
    const plain =
        '{"action":"screenshot","params":{"targets":[{"source":"screen","path":"a.png"}]}}';
    assert.strictEqual(extractJsonActionCandidate(plain), plain);
    // 2. 带围栏 + json 标记
    const fenced =
        '```json\n{"action":"screenshot","params":{"targets":[{"source":"window","windowTitle":"Visual Studio Code","path":"b.png"}]}}\n```';
    const extracted = extractJsonActionCandidate(fenced);
    assert(extracted, "should extract screenshot from fenced text");
    assert(extracted.startsWith("{"), "extracted should start with JSON action");
    // 3. 前面有多余文字
    const withPrefix =
        '好的，我来截图。\n{"action":"screenshot","params":{"targets":[{"source":"browser_page","url":"https://example.com","path":"c.png"}]}}';
    const fromPrefix = extractJsonActionCandidate(withPrefix);
    assert(fromPrefix && fromPrefix.startsWith("{"), "should strip leading prose");
    // 4. 提取后能被 extractAction 正确解析，并归一化默认值
    const action = extractAction(extracted);
    assert.strictEqual(action.action, "screenshot");
    assert.strictEqual(action.plugin, "screenshot");
    assert.strictEqual(action.params.targets.length, 1);
    assert.strictEqual(action.params.targets[0].source, "window");
    assert.strictEqual(action.params.targets[0].windowTitle, "Visual Studio Code");
    assert.strictEqual(action.params.targets[0].fullPage, false);
    // 5. 围栏平衡不被破坏
    const balanced = balanceMarkdownFences(fenced + "```");
    assert(typeof balanced === "string");
    // 6. 原有 read 仍能提取（回归）
    const readFenced = '```json\n{"action":"read","params":{"path":"package.json"}}\n```';
    const readExtracted = extractJsonActionCandidate(readFenced);
    const readAction = extractAction(readExtracted);
    assert(readExtracted && readExtracted.startsWith("{"), "read should still be extracted");
    assert.deepStrictEqual(readAction.params, { path: "package.json" });
    // 7. 不带任何 action 的文本返回 null
    assert.strictEqual(extractJsonActionCandidate("只是一段普通文字，没有动作"), null);
    console.log("EXTRACT_OK");
    console.log("fenced-> " + extracted.slice(0, 60));
    console.log("prefix-> " + fromPrefix.slice(0, 60));
}
run().catch((error) => {
    console.error("EXTRACT TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
