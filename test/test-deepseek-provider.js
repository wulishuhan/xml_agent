const assert = require("assert");
const {
    DeepSeekProvider,
    balanceMarkdownFences,
    extractXmlFromCandidate,
} = require("../providers/deepseek");

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log("PASS: " + name);
    } catch (err) {
        failed++;
        console.log("FAIL: " + name + " -> " + err.message);
    }
}

// ===== 1. Provider 基础信息 =====
check("provider name is DeepSeek", () => {
    const p = new DeepSeekProvider({ autoStart: false });
    assert.strictEqual(p.name, "DeepSeek");
});

check("exports balanceMarkdownFences", () => {
    assert.strictEqual(typeof balanceMarkdownFences, "function");
});

check("exports extractXmlFromCandidate", () => {
    assert.strictEqual(typeof extractXmlFromCandidate, "function");
});

// ===== 2. 会话 URL 解析 =====
check("getConversationIdFromUrl extracts uuid", () => {
    const p = new DeepSeekProvider({ autoStart: false });
    const id = p.getConversationIdFromUrl(
        "https://chat.deepseek.com/a/chat/s/9efa4714-38db-4038-a971-226570f7155d"
    );
    assert.strictEqual(id, "9efa4714-38db-4038-a971-226570f7155d");
});

check("getConversationIdFromUrl returns null for invalid url", () => {
    const p = new DeepSeekProvider({ autoStart: false });
    assert.strictEqual(p.getConversationIdFromUrl("https://chat.deepseek.com"), null);
    assert.strictEqual(p.getConversationIdFromUrl(""), null);
    assert.strictEqual(p.getConversationIdFromUrl(null), null);
});

check("buildTargetUrl without conversationId", () => {
    const p = new DeepSeekProvider({
        autoStart: false,
        targetUrl: "https://chat.deepseek.com",
    });
    assert.strictEqual(p.buildTargetUrl(), "https://chat.deepseek.com");
});

check("buildTargetUrl with conversationId", () => {
    const p = new DeepSeekProvider({
        autoStart: false,
        targetUrl: "https://chat.deepseek.com",
        conversationId: "abc-123",
    });
    assert.strictEqual(p.buildTargetUrl(), "https://chat.deepseek.com/a/chat/s/abc-123");
});

check("buildTargetUrl strips trailing slash", () => {
    const p = new DeepSeekProvider({
        autoStart: false,
        targetUrl: "https://chat.deepseek.com/",
        conversationId: "abc-123",
    });
    assert.strictEqual(p.buildTargetUrl(), "https://chat.deepseek.com/a/chat/s/abc-123");
});

// ===== 3. XML 候选提取 =====
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const BT = String.fromCharCode(96);
const DQ = String.fromCharCode(34);

check("extractXmlFromCandidate finds answer tag", () => {
    const raw = "一些前置文本 " + LT + "answer" + GT + "真正的回答" + LT + "/answer" + GT + " 后置";
    const xml = extractXmlFromCandidate(raw);
    assert.ok(xml);
    assert.ok(xml.indexOf(LT + "answer" + GT) === 0);
});

check("extractXmlFromCandidate strips xml code fence", () => {
    const fence = BT + BT + BT;
    const readTag = LT + "read path=" + DQ + "a.js" + DQ + "/" + GT;
    const raw = fence + "xml\n" + readTag + "\n" + fence;
    const xml = extractXmlFromCandidate(raw);
    assert.ok(xml);
    assert.ok(xml.indexOf(LT + "read") === 0);
});

check("extractXmlFromCandidate returns null for plain text", () => {
    assert.strictEqual(extractXmlFromCandidate("just a normal answer"), null);
    assert.strictEqual(extractXmlFromCandidate(""), null);
    assert.strictEqual(extractXmlFromCandidate(null), null);
});

// ===== 4. Markdown fence 平衡 =====
check("balanceMarkdownFences closes unclosed fence", () => {
    const fence = BT + BT + BT;
    const input = "前言\n" + fence + "js\nconst a = 1;\n";
    const out = balanceMarkdownFences(input);
    const fenceCount = out.split(fence).length - 1;
    assert.strictEqual(fenceCount, 2, "should have paired fences, got " + fenceCount);
});

check("balanceMarkdownFences removes orphan closing fence", () => {
    const fence = BT + BT + BT;
    const input = "前言\n" + fence + "\n后语";
    const out = balanceMarkdownFences(input);
    assert.ok(out.indexOf(fence) === -1, "orphan fence should be removed");
});

check("balanceMarkdownFences keeps balanced fences unchanged", () => {
    const fence = BT + BT + BT;
    const input = fence + "js\ncode\n" + fence;
    assert.strictEqual(balanceMarkdownFences(input), input);
});

check("balanceMarkdownFences handles empty string", () => {
    assert.strictEqual(balanceMarkdownFences(""), "");
    assert.strictEqual(balanceMarkdownFences(null), "");
});

// ===== 5. buildFromDom 存在且是函数 =====
check("buildFromDom exists as async method", () => {
    const p = new DeepSeekProvider({ autoStart: false });
    assert.strictEqual(typeof p.buildFromDom, "function");
});

check("extractOne exists as async method", () => {
    const p = new DeepSeekProvider({ autoStart: false });
    assert.strictEqual(typeof p.extractOne, "function");
});

// ===== 6. 输入选择器 =====
check("inputSelectors includes contenteditable variants", () => {
    const p = new DeepSeekProvider({ autoStart: false });
    assert.ok(Array.isArray(p.inputSelectors));
    assert.ok(p.inputSelectors.length > 0);
    assert.ok(
        p.inputSelectors.some((s) => s.indexOf("contenteditable") !== -1),
        "should include contenteditable selector"
    );
});

console.log("\nTotal: " + (passed + failed) + ", Passed: " + passed + ", Failed: " + failed);
if (failed > 0) {
    process.exit(1);
}
