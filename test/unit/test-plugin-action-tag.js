/**
动作标签识别的单测（不启动浏览器、不联网）

守的是一个真机踩过的坑：`ACTION_TAG_NAMES` 曾写死成七个内置动作，
插件动作（browse-nav / wechat-status …）不在清单里，于是

1. `containsActionTag("<browse-nav .../>")` 返回 false，这条回复被当成普通文本；
2. provider 以为最后一条没有动作，去合并最近几条消息，
   把上一轮同样的 XML 拼了第二遍；
3. 解析器报 "Exactly one XML Action is required, but received 2"，
   模型收到"你的回复不合法"的纠正提示，重试一次还是两份，原地死循环。

所以这里断言三件事：清单来自注册表、名字边界正确、短动作不被长度阈值误杀。

运行：node test/unit/test-plugin-action-tag.js
*/

const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const actionTag = require(path.join(ROOT, "providers/action-tag"));
const fenceUtils = require(path.join(ROOT, "providers/markdown-fence-utils"));
const fiber = require(path.join(ROOT, "providers/dom/fiber"));

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

const BUILTIN = ["write", "edit", "read", "exec", "screenshot", "answer", "done"];

// ------------------------------------------------------------
// 1. 清单来源
// ------------------------------------------------------------

check("内置动作一个都不能少", () => {
    const names = actionTag.getActionTagNames();

    for (const name of BUILTIN) {
        assert.ok(names.indexOf(name) !== -1, "缺少内置动作 " + name);
    }
});

check("插件动作从注册表合并进来", () => {
    const names = actionTag.getActionTagNames();

    // wechat / browser 是内置插件，注册表加载后必然在列
    for (const name of ["browse-nav", "browse-eval", "wechat-open", "wechat-read"]) {
        assert.ok(names.indexOf(name) !== -1, "缺少插件动作 " + name);
    }
});

check("ACTION_TAG_NAMES 仍只含内置动作（兼容旧引用）", () => {
    assert.deepStrictEqual(actionTag.ACTION_TAG_NAMES.slice(), BUILTIN);
});

// ------------------------------------------------------------
// 2. 识别与边界
// ------------------------------------------------------------

check("插件动作被识别为 Action", () => {
    assert.strictEqual(
        actionTag.containsActionTag('<browse-nav url="https://example.com"/>'),
        true
    );
    assert.strictEqual(actionTag.containsActionTag("<wechat-status/>"), true);
    assert.strictEqual(actionTag.containsActionTag('<wechat-send text="收到"/>'), true);
    assert.strictEqual(actionTag.containsActionTag('<fetch url="http://127.0.0.1/"/>'), true);
});

check("内置动作仍然认得出", () => {
    assert.strictEqual(actionTag.containsActionTag('<read path="a.js"/>'), true);
    assert.strictEqual(actionTag.containsActionTag("<done/>"), true);
    assert.strictEqual(actionTag.containsActionTag("<answer><![CDATA[好]]></answer>"), true);
});

check("名字必须完整匹配（<read 不能命中 <readfile）", () => {
    assert.strictEqual(actionTag.containsActionTag('<readfile name="x"/>'), false);
    assert.strictEqual(actionTag.containsActionTag("<wechat-statusx/>"), false);
});

check("普通文本不算 Action", () => {
    assert.strictEqual(actionTag.containsActionTag("这一轮不需要执行动作"), false);
    assert.strictEqual(actionTag.containsActionTag(""), false);
    assert.strictEqual(actionTag.containsActionTag(null), false);
});

// ------------------------------------------------------------
// 3. 从候选文本里切出 XML
// ------------------------------------------------------------

check("extractXmlFromCandidate 认得插件自闭合标签", () => {
    const text = '<browse-nav url="https://example.com"/>';

    assert.strictEqual(fenceUtils.extractXmlFromCandidate(text), text);
    assert.strictEqual(fenceUtils.extractXmlFromCandidate("<wechat-status/>"), "<wechat-status/>");
});

check("extractXmlFromCandidate 能剥掉代码围栏", () => {
    const fence = String.fromCharCode(96, 96, 96);
    const wrapped = fence + 'xml\n<browse-text selector="main"/>' + fence;

    assert.strictEqual(
        fenceUtils.extractXmlFromCandidate(wrapped),
        '<browse-text selector="main"/>'
    );
});

check("extractXmlFromCandidate 对非动作文本返回 null", () => {
    assert.strictEqual(fenceUtils.extractXmlFromCandidate("就是一段普通回答"), null);
    assert.strictEqual(fenceUtils.extractXmlFromCandidate('<div class="x">hi</div>'), null);
});

// ------------------------------------------------------------
// 4. fiber 扫描器：短的插件动作不能被长度阈值丢掉
// ------------------------------------------------------------

/** 造一个只有 React props 的假元素，够 fiber 扫描器走 props 分支。 */
function fakeElement(props) {
    const element = {};

    element["__reactProps$test"] = props;

    return element;
}

check("fiber 扫描器：传入清单后能捞到短的插件动作", () => {
    const element = fakeElement({ children: "<wechat-status/>" });
    const result = fiber.collectChildFiberCandidate(element, actionTag.getActionTagNames());

    assert.ok(result, "应当返回候选");
    assert.strictEqual(result.top.value, "<wechat-status/>");
    assert.strictEqual(result.top.isAction, true);
});

check("fiber 扫描器：不传清单时不认插件动作（证明参数真的生效）", () => {
    const element = fakeElement({ children: "<wechat-status/>" });

    assert.strictEqual(fiber.collectChildFiberCandidate(element), null);
});

check("fiber 扫描器：三向 BFS 同样认插件动作", () => {
    const element = fakeElement({ children: '<browse-nav url="https://example.com"/>' });
    const candidates = fiber.collectFiberCandidates(element, actionTag.getActionTagNames());

    assert.ok(candidates.length >= 1, "应当返回候选");
    assert.strictEqual(candidates[0].value, '<browse-nav url="https://example.com"/>');
    assert.strictEqual(candidates[0].hasAction, true);
});

check("fiber 扫描器：非动作的短字符串仍然被当噪声丢掉", () => {
    const element = fakeElement({ children: "短文本" });

    assert.deepStrictEqual(fiber.collectFiberCandidates(element, ["read", "write"]), []);
});

console.log("\nTotal: " + pass + "/" + total);
process.exit(pass === total ? 0 : 1);
