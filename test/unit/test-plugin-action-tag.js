/**
 * JSON Action envelope 识别单测（不启动浏览器、不联网）
 *
 * 动作集合是开放的：Provider 不再依赖内置/插件动作名清单，而是判断回复中
 * 是否有且只有一个 JSON envelope。这里同时钉住解析层与 Fiber 扫描器的契约：
 * 裸 JSON、```json 围栏、说明文字、嵌套 params、字符串花括号与转义都能识别；
 * XML、普通文本和多个 envelope 不能被误判为单条动作。
 *
 * 运行：node test/unit/test-plugin-action-tag.js
 */

const assert = require("assert");

const actionTag = require("../../providers/action-tag");
const fenceUtils = require("../../providers/markdown-fence-utils");
const jsonCandidate = require("../../parse/json-candidate");
const fiber = require("../../providers/dom/fiber");

const FENCE = String.fromCharCode(96, 96, 96);
const READ = JSON.stringify({ action: "read", params: { path: "." } });

let pass = 0;
let total = 0;

function check(name, fn) {
    total += 1;
    try {
        fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

// ------------------------------------------------------------
// 1. 共享入口与解析契约
// ------------------------------------------------------------

check("Provider 导出 hasActionEnvelope", () => {
    assert.strictEqual(typeof actionTag.hasActionEnvelope, "function");
    assert.strictEqual(actionTag.hasActionEnvelope, jsonCandidate.hasActionEnvelope);
});

check("围栏工具导出 extractJsonActionCandidate", () => {
    assert.strictEqual(typeof fenceUtils.extractJsonActionCandidate, "function");
});

check("裸 JSON 与开放插件动作无需动作名清单", () => {
    const fixtures = [
        { action: "read", params: { path: "." } },
        { action: "done", params: {} },
        { action: "browse-nav", params: { url: "https://example.com" } },
        { action: "wechat-status", params: {} },
        { action: "fetch", params: { url: "http://127.0.0.1/" } },
        { action: "screenshot", params: { source: "window" } },
        { action: "answer", params: { text: "好" } },
    ];

    for (const fixture of fixtures) {
        const raw = JSON.stringify(fixture);
        assert.strictEqual(jsonCandidate.hasActionEnvelope(raw), true, raw);
        assert.deepStrictEqual(jsonCandidate.extractActionEnvelope(raw), fixture);
    }
});

check("说明文字与 ```json 围栏中的 envelope 可识别", () => {
    const wrapped = "先执行这个动作：\n" + FENCE + "json\n" + READ + "\n" + FENCE + "\n完成后告诉我。";

    assert.strictEqual(jsonCandidate.hasActionEnvelope(wrapped), true);
    assert.deepStrictEqual(jsonCandidate.extractActionEnvelope(wrapped), {
        action: "read",
        params: { path: "." },
    });
    assert.strictEqual(fenceUtils.extractJsonActionCandidate(wrapped), READ);
});

check("嵌套 params、字符串花括号与转义原样解析", () => {
    const fixture = {
        action: "write",
        params: {
            path: "note.txt",
            content: '左侧 { 花括号 }，引号 "quoted"，反斜杠 C:\\tmp\\x，换行\n下一行',
            options: {
                nested: { enabled: true },
                entries: [{ value: "}" }, { value: "{" }],
            },
        },
    };
    const raw = JSON.stringify(fixture);
    const wrapped = "说明文字\n" + FENCE + "json\n" + raw + "\n" + FENCE;

    assert.strictEqual(jsonCandidate.hasActionEnvelope(raw), true);
    assert.deepStrictEqual(jsonCandidate.extractActionEnvelope(wrapped), fixture);
    assert.strictEqual(fenceUtils.extractJsonActionCandidate(wrapped), raw);
});

check("普通文本、XML、空值与非 envelope JSON 均被拒绝", () => {
    const rejected = [
        "这一轮不需要执行动作",
        '<read path="."/>',
        "<answer><![CDATA[好]]></answer>",
        FENCE + "xml\n<done/>\n" + FENCE,
        '{"path":"."}',
        '{"action":"read","params":[]}',
        '{"action":"read","params":',
        "",
        "   ",
        null,
        undefined,
    ];

    for (const value of rejected) {
        assert.strictEqual(jsonCandidate.hasActionEnvelope(value), false, String(value));
    }
});

check("多个 envelope 不误判为单条动作并保留给解析层报错", () => {
    const second = JSON.stringify({ action: "done", params: {} });
    const multiple = "第一个动作：\n" + READ + "\n第二个动作：\n" + second;

    assert.strictEqual(jsonCandidate.hasActionEnvelope(multiple), false);
    assert.throws(
        () => jsonCandidate.extractActionEnvelope(multiple),
        /Exactly one JSON action is required, but received 2/
    );
    assert.strictEqual(fenceUtils.extractJsonActionCandidate(multiple), multiple);
});

// ------------------------------------------------------------
// 2. 候选提取
// ------------------------------------------------------------

check("extractJsonActionCandidate 从说明文字中返回裸 envelope", () => {
    assert.strictEqual(fenceUtils.extractJsonActionCandidate("前置说明 " + READ + " 后置说明"), READ);
});

check("extractJsonActionCandidate 不挑选多个 envelope 中的一个", () => {
    const second = JSON.stringify({ action: "answer", params: { text: "done" } });
    const multiple = READ + "\n" + second;

    assert.strictEqual(fenceUtils.extractJsonActionCandidate(multiple), multiple);
});

check("extractJsonActionCandidate 对非动作文本返回 null", () => {
    assert.strictEqual(fenceUtils.extractJsonActionCandidate("就是一段普通回答"), null);
    assert.strictEqual(fenceUtils.extractJsonActionCandidate('<div class="x">hi</div>'), null);
    assert.strictEqual(fenceUtils.extractJsonActionCandidate('{"ok":true}'), null);
    assert.strictEqual(fenceUtils.extractJsonActionCandidate(""), null);
    assert.strictEqual(fenceUtils.extractJsonActionCandidate(null), null);
});

// ------------------------------------------------------------
// 3. Fiber 候选：短 JSON 动作保留，XML 与短噪声丢弃，重复节点去重
// ------------------------------------------------------------

/** 造一个带 React props / fiber 的假元素，够扫描器走纯对象分支。 */
function fakeElement(props, fiberProps) {
    const element = {};
    element.__reactProps$test = props;
    if (fiberProps) {
        element.__reactFiber$test = { memoizedProps: fiberProps, pendingProps: fiberProps, child: null };
    }
    return element;
}

check("child-only Fiber 识别短的开放插件 JSON 动作", () => {
    const raw = JSON.stringify({ action: "wechat-status", params: {} });
    const result = fiber.collectChildFiberCandidate(fakeElement({ children: raw }));

    assert.ok(result, "应当返回候选");
    assert.strictEqual(result.top.value, raw);
    assert.strictEqual(result.top.isAction, true);
});

check("三向 BFS 识别短的 JSON 动作", () => {
    const raw = JSON.stringify({ action: "browse-nav", params: { url: "https://example.com" } });
    const candidates = fiber.collectFiberCandidates(fakeElement({ children: raw }));

    assert.ok(candidates.length >= 1, "应当返回候选");
    assert.strictEqual(candidates[0].value, raw);
    assert.strictEqual(candidates[0].hasAction, true);
});

check("Fiber 对重复渲染的同一 JSON 动作去重", () => {
    const raw = JSON.stringify({ action: "read", params: { path: "." } });
    const element = fakeElement({ children: raw }, { children: raw });

    const wide = fiber.collectFiberCandidates(element);
    const narrow = fiber.collectChildFiberCandidate(element);

    assert.strictEqual(wide.length, 1, "三向 BFS 应只保留一份");
    assert.strictEqual(narrow.candidates.length, 1, "child-only 应只保留一份");
    assert.strictEqual(narrow.totalCandidates, 2, "去重前应确实收集到两份");
});

check("Fiber 不把短 XML 或普通文本当动作", () => {
    const xmlElement = fakeElement({ children: '<read path="."/>' });
    const textElement = fakeElement({ children: "短文本" });

    assert.strictEqual(fiber.collectChildFiberCandidate(xmlElement), null);
    assert.deepStrictEqual(fiber.collectFiberCandidates(xmlElement), []);
    assert.strictEqual(fiber.collectChildFiberCandidate(textElement), null);
    assert.deepStrictEqual(fiber.collectFiberCandidates(textElement), []);
});

check("Fiber 对多个 envelope 的文本不标记为单条动作", () => {
    const raw = READ + "\n" + JSON.stringify({ action: "done", params: {} });
    const candidates = fiber.collectFiberCandidates(fakeElement({ children: raw }));

    assert.ok(candidates.length >= 1);
    assert.strictEqual(candidates[0].value, raw);
    assert.strictEqual(candidates[0].hasAction, false);
});

console.log("\nTotal: " + pass + "/" + total);
process.exit(pass === total ? 0 : 1);
