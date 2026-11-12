/**
browser 插件的边界单测（不启动浏览器）

只测「允许什么」与「怎么截断」：http/https 白名单、file:// 与 javascript: 的拒绝、
正文长度上限、以及插件对 evaluate 的默认关闭。真正打开页面的行为由 qwen 真机
端到端用例覆盖（test/live/… 手跑），因为那需要一台带 Edge 的机器。

运行：node test/unit/test-browser-plugin.js
*/

const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const engine = require(path.join(ROOT, "plugins/builtin/browser/engine/browser"));
const plugin = require(path.join(ROOT, "plugins/builtin/browser/index.js"));

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

async function checkAsync(name, fn) {
    total += 1;
    try {
        await fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

function makeCtx(config) {
    const actions = new Map();
    const panels = [];
    const disposers = [];
    plugin.setup({
        config: Object.assign({ cdpPort: 9333, allowEval: false, maxTextChars: 500 }, config),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        fs: { resolve: (target) => path.resolve(__dirname, String(target || "")) },
        storage: { appendLine() {}, readText: () => "", list: () => [], remove: () => false },
        actions: {
            register(def) {
                actions.set(def.name, def);
            },
        },
        api: { get() {}, post() {}, put() {}, delete() {}, register() {} },
        ui: {
            registerPanel(panel) {
                panels.push(panel);
            },
            registerSettings() {},
            registerComposerAction() {},
        },
        hooks: { on() {} },
        onDispose(fn) {
            disposers.push(fn);
        },
        permissions: { check: () => true, policy: () => "allow" },
    });
    return { actions: actions, panels: panels, disposers: disposers };
}

check("只放行 http/https", () => {
    assert.strictEqual(
        engine.assertHttpUrl("https://example.com/a?b=1"),
        "https://example.com/a?b=1"
    );
    assert.strictEqual(
        engine.assertHttpUrl("  http://127.0.0.1:3000/  "),
        "http://127.0.0.1:3000/"
    );
});

check("file:// javascript: chrome:// 一律拒绝", () => {
    for (const bad of [
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "chrome://settings",
        "about:blank",
        "ftp://example.com/x",
    ]) {
        assert.throws(() => engine.assertHttpUrl(bad), /只允许 http\/https/, bad + " 应被拒绝");
    }
});

check("不是 URL 的输入报错而不是瞎猜", () => {
    assert.throws(() => engine.assertHttpUrl("example.com"), /不是合法地址/);
    assert.throws(() => engine.assertHttpUrl(""), /不是合法地址/);
});

check("正文按上限截断并标记", () => {
    const short = engine.shorten("abc", 10);
    assert.deepStrictEqual(short, { text: "abc", truncated: false });
    const long = engine.shorten("x".repeat(50), 10);
    assert.strictEqual(long.text.length, 10);
    assert.strictEqual(long.truncated, true);
});

check("六个动作都注册了", () => {
    const { actions } = makeCtx();
    for (const name of [
        "browse-nav",
        "browse-click",
        "browse-fill",
        "browse-text",
        "browse-shot",
        "browse-eval",
    ]) {
        assert.ok(actions.has(name), name + " 未注册");
    }
});

check("browse-nav 在 validate 阶段就拦掉非法协议（不会去启动浏览器）", () => {
    const { actions } = makeCtx();
    const def = actions.get("browse-nav");
    assert.throws(() => def.validate({ "@_url": "file:///etc/passwd" }), /只允许 http\/https/);
    assert.doesNotThrow(() => def.validate({ "@_url": "https://example.com" }));
});

(async () => {
    await checkAsync("allowEval 默认关闭时 browse-eval 直接拒绝", async () => {
        const { actions } = makeCtx({ allowEval: false });
        const def = actions.get("browse-eval");
        const result = await def.run({}, { attrs: { script: "document.title" } });
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /allowEval/);
    });

    check("面板与清理函数都登记了", () => {
        const { panels, disposers } = makeCtx();
        assert.strictEqual(panels.length, 1);
        assert.strictEqual(panels[0].id, "browser");
        assert.ok(disposers.length >= 1, "应登记关闭浏览器的清理函数");
    });

    console.log("");
    console.log("Total: " + pass + "/" + total);
    if (pass !== total) {
        process.exit(1);
    }
})();
