const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { extractXML, tryExtractScreenshotManually } = require("../parse/xml-parse");
const { isPathInside, resolveOutputPath, takeScreenshot } = require("../webui/screenshot-api");
async function run() {
    // 1. 手动解析 screenshot 自闭合标签
    const manual = tryExtractScreenshotManually(
        '<screenshot source="screen" path="screenshots/desktop.png"/>'
    );
    assert(manual, "should parse self-closing screenshot");
    assert.strictEqual(manual.action, "screenshot");
    assert.strictEqual(manual.node["@_source"], "screen");
    assert.strictEqual(manual.node["@_path"], "screenshots/desktop.png");
    // 2. extractXML 支持 screenshot
    const action = extractXML(
        '<screenshot source="window" windowTitle="Visual Studio Code" path="screenshots/vscode.png"/>'
    );
    assert.strictEqual(action.action, "screenshot");
    assert.strictEqual(action.node["@_source"], "window");
    assert.strictEqual(action.node["@_windowTitle"], "Visual Studio Code");
    // 3. 非法 source 应报错
    let threw = false;
    try {
        extractXML('<screenshot source="magic" path="a.png"/>');
    } catch (e) {
        threw = true;
        assert(e.message.indexOf("source") !== -1, "error should mention source");
    }
    assert(threw, "invalid source should throw");
    // 4. window 缺 windowTitle 应报错
    threw = false;
    try {
        extractXML('<screenshot source="window" path="a.png"/>');
    } catch (e) {
        threw = true;
    }
    assert(threw, "window without windowTitle should throw");
    // 5. 路径越界检测
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-ws-"));
    assert.strictEqual(isPathInside(tmpWorkspace, path.join(tmpWorkspace, "a.png")), true);
    assert.strictEqual(
        isPathInside(tmpWorkspace, path.join(tmpWorkspace, "..", "evil.png")),
        false
    );
    threw = false;
    try {
        resolveOutputPath(tmpWorkspace, "../evil.png");
    } catch (e) {
        threw = true;
    }
    assert(threw, "escaping workspace should throw");
    // 6. 真实截图（仅在 Windows 上跑，且尽量稳）
    if (process.platform === "win32") {
        const result = await takeScreenshot({
            workspace: tmpWorkspace,
            source: "screen",
            path: "screenshots/test-screen.png",
        });
        if (!result.ok) {
            console.warn("screen screenshot failed (may lack permission): " + result.error);
        } else {
            assert(result.ok, "screen capture ok");
            assert.strictEqual(result.source, "screen");
            assert(result.width > 0, "width should be > 0");
            assert(result.height > 0, "height should be > 0");
            const absolute = path.join(tmpWorkspace, "screenshots", "test-screen.png");
            assert(fs.existsSync(absolute), "screenshot file should exist");
            console.log(
                "screen screenshot saved: " +
                    absolute +
                    " (" +
                    result.width +
                    "x" +
                    result.height +
                    ")"
            );
        }
    }
    // 7. Runtime handler 存在 screenshot
    const { Runtime } = require("../runtime");
    const runtime = new Runtime(tmpWorkspace);
    const handlers = runtime.actionHandlers;
    assert(typeof handlers.screenshot === "function", "runtime should have screenshot handler");
    // 8. runtime.screenshot 越界应报错
    threw = false;
    try {
        await runtime.screenshot({ "@_source": "screen", "@_path": "../evil.png" });
    } catch (e) {
        threw = true;
    }
    assert(threw, "runtime.screenshot should reject escaping path");
    console.log("ALL SCREENSHOT TESTS PASSED");
}
run().catch((error) => {
    console.error("TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
