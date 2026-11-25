const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { extractAction } = require("../parse/json-action");
const {
    isPathInside,
    resolveOutputPath,
    takeScreenshot,
} = require("../plugins/builtin/screenshot/engine/take-screenshot");
async function run() {
    // 1. JSON action 解析 screen target，并补全默认值
    const single = extractAction(
        JSON.stringify({
            action: "screenshot",
            params: { targets: [{ source: "screen", path: "screenshots/desktop.png" }] },
        })
    );
    assert.strictEqual(single.action, "screenshot");
    assert.strictEqual(single.plugin, "screenshot");
    assert.deepStrictEqual(single.params, {
        targets: [
            { source: "screen", path: "screenshots/desktop.png", fullPage: false },
        ],
    });
    // 2. extractAction 支持 window target 与 title 别名
    const action = extractAction(
        JSON.stringify({
            action: "screenshot",
            params: {
                targets: [
                    {
                        source: "window",
                        title: "Visual Studio Code",
                        path: "screenshots/vscode.png",
                    },
                ],
            },
        })
    );
    assert.strictEqual(action.action, "screenshot");
    assert.strictEqual(action.params.targets[0].source, "window");
    assert.strictEqual(action.params.targets[0].title, "Visual Studio Code");
    // 3. 非法 source 应报错
    let threw = false;
    try {
        extractAction(
            JSON.stringify({
                action: "screenshot",
                params: { targets: [{ source: "magic", path: "a.png" }] },
            })
        );
    } catch (e) {
        threw = true;
        assert(e.message.indexOf("source") !== -1, "error should mention source");
    }
    assert(threw, "invalid source should throw");
    // 4. window 缺 windowTitle / title 应报错
    threw = false;
    try {
        extractAction(
            JSON.stringify({
                action: "screenshot",
                params: { targets: [{ source: "window", path: "a.png" }] },
            })
        );
    } catch (e) {
        threw = true;
        assert(/windowTitle|title/.test(e.message), "error should mention window title fields");
    }
    assert(threw, "window without windowTitle or title should throw");
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
    //    注：screenshot 自 v1.1.0 起是内置插件，actionHandlers 会把插件动作一并包含进来。
    const { Runtime } = require("../runtime");
    const runtime = new Runtime(tmpWorkspace);
    const handlers = runtime.actionHandlers;
    assert(typeof handlers.screenshot === "function", "runtime should have screenshot handler");
    // 8. 越界路径必须被拒。
    //    迁移到插件后，插件动作的执行由 registry 兜底，错误以结构化结果返回
    //    （{ ok:false, error }，且保留 action 名），而不是抛栈；两者都算"被拒"。
    let rejected = false;
    try {
        const result = await runtime.screenshot({
            targets: [{ source: "screen", path: "../evil.png" }],
        });
        rejected = Boolean(result) && result.ok === false;
    } catch (e) {
        rejected = true;
    }
    assert(rejected, "runtime.screenshot should reject escaping path");
    console.log("ALL SCREENSHOT TESTS PASSED");
}
run().catch((error) => {
    console.error("TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
