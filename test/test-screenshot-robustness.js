const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {
    takeScreenshot,
    resolveOutputPath,
    isPathInside,
    normalizeClip,
    normalizeTimeout,
    toBoolean,
} = require("../webui/screenshot-api");
const { materializeWindowsScript } = require("../capture/screenshot");
const DOLLAR = String.fromCharCode(36);
let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log("PASS: " + name);
    } catch (error) {
        failed += 1;
        console.log("FAIL: " + name + " -> " + (error && error.message));
    }
}
async function run() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-robust-"));
    // ===== 参数校验 =====
    await check("workspace required", async () => {
        await assert.rejects(takeScreenshot({ source: "screen" }), /workspace is required/);
    });
    await check("workspace must exist", async () => {
        await assert.rejects(
            takeScreenshot({ workspace: path.join(workspace, "nope"), source: "screen" }),
            /workspace does not exist/
        );
    });
    await check("invalid source rejected", async () => {
        await assert.rejects(
            takeScreenshot({ workspace, source: "magic" }),
            /source must be one of/
        );
    });
    await check("path must be string", async () => {
        await assert.rejects(
            takeScreenshot({ workspace, source: "screen", path: 123 }),
            /path must be a string/
        );
    });
    await check("window without windowTitle rejected", async () => {
        await assert.rejects(
            takeScreenshot({ workspace, source: "window" }),
            /windowTitle is required/
        );
    });
    await check("window with blank windowTitle rejected", async () => {
        await assert.rejects(
            takeScreenshot({ workspace, source: "window", windowTitle: "   " }),
            /windowTitle is required/
        );
    });
    await check("browser_page with blank url rejected", async () => {
        await assert.rejects(
            takeScreenshot({ workspace, source: "browser_page", url: "  " }),
            /url must be a non-empty string/
        );
    });
    await check("browser_page with blank selector rejected", async () => {
        await assert.rejects(
            takeScreenshot({ workspace, source: "browser_page", selector: "  " }),
            /selector must be a non-empty string/
        );
    });
    await check("invalid clip rejected", async () => {
        await assert.rejects(
            takeScreenshot({
                workspace,
                source: "screen",
                clip: { x: "a", y: 0, width: 10, height: 10 },
            }),
            /clip must be an object/
        );
    });
    await check("clip with zero width rejected", async () => {
        await assert.rejects(
            takeScreenshot({
                workspace,
                source: "screen",
                clip: { x: 0, y: 0, width: 0, height: 10 },
            }),
            /clip must be an object/
        );
    });
    // ===== 路径越界 =====
    await check("path escape rejected", () => {
        assert.throws(() => resolveOutputPath(workspace, "../evil.png"), /escapes workspace/);
    });
    await check("isPathInside basic", () => {
        assert.strictEqual(isPathInside(workspace, path.join(workspace, "a.png")), true);
        assert.strictEqual(isPathInside(workspace, path.join(workspace, "..", "a.png")), false);
        assert.strictEqual(isPathInside(workspace, workspace), true);
    });
    await check("takeScreenshot rejects escaping path", async () => {
        await assert.rejects(
            takeScreenshot({ workspace, source: "screen", path: "../evil.png" }),
            /escapes workspace/
        );
    });
    // ===== 工具函数 =====
    await check("toBoolean handles strings", () => {
        assert.strictEqual(toBoolean("true", false), true);
        assert.strictEqual(toBoolean("1", false), true);
        assert.strictEqual(toBoolean("false", true), false);
        assert.strictEqual(toBoolean("0", true), false);
        assert.strictEqual(toBoolean(undefined, true), true);
        assert.strictEqual(toBoolean(true, false), true);
        assert.strictEqual(toBoolean("garbage", true), true);
    });
    await check("normalizeTimeout clamps", () => {
        assert.strictEqual(normalizeTimeout(undefined), 30000);
        assert.strictEqual(normalizeTimeout("abc"), 30000);
        assert.strictEqual(normalizeTimeout(-1), 30000);
        assert.strictEqual(normalizeTimeout(5000), 5000);
        assert.strictEqual(normalizeTimeout(99999999), 5 * 60 * 1000);
    });
    await check("normalizeClip valid", () => {
        const clip = normalizeClip({ x: 0, y: 1, width: 100, height: 50 });
        assert.deepStrictEqual(clip, { x: 0, y: 1, width: 100, height: 50 });
    });
    await check("normalizeClip invalid variants", () => {
        assert.strictEqual(normalizeClip(null), null);
        assert.strictEqual(normalizeClip("abc"), null);
        assert.strictEqual(normalizeClip({ x: 0, y: 0, width: 0, height: 10 }), null);
        assert.strictEqual(normalizeClip({ x: -1, y: 0, width: 10, height: 10 }), null);
        assert.strictEqual(normalizeClip({ x: 0, y: 0, width: 10 }), null);
    });
    // ===== PowerShell 脚本生成完整性 =====
    await check("windows script contains param block", () => {
        const script = materializeWindowsScript();
        assert(script.indexOf("param(") === 0, "should start with param(");
        const outputVar = DOLLAR + "OutputPath";
        const modeVar = DOLLAR + "Mode";
        const titleVar = DOLLAR + "WindowTitleFile";
        const nullVar = DOLLAR + "null";
        const windowTitleVar = DOLLAR + "windowTitle";
        assert(script.indexOf(outputVar) !== -1, "should contain OutputPath variable");
        assert(script.indexOf(modeVar) !== -1, "should contain Mode variable");
        assert(script.indexOf(titleVar) !== -1, "should contain WindowTitleFile variable");
        const placeholder = "@@D@@";
        assert(script.indexOf(placeholder) === -1, "should not contain placeholder");
        const nullGuard = nullVar + " -eq " + windowTitleVar;
        assert(script.indexOf(nullGuard) !== -1, "should guard null title");
        assert(script.indexOf("SetProcessDPIAware") !== -1, "should set DPI aware");
    });
    // ===== 真实截图 =====
    if (process.platform === "win32") {
        await check("real screen screenshot", async () => {
            const result = await takeScreenshot({
                workspace,
                source: "screen",
                path: "shots/ok.png",
            });
            assert.strictEqual(result.ok, true, "screenshot should succeed: " + result.error);
            assert(result.width > 0);
            assert(result.height > 0);
            assert(result.bytes > 0);
            assert(fs.existsSync(path.join(workspace, "shots", "ok.png")));
        });
        await check("default path saved under screenshots/", async () => {
            const result = await takeScreenshot({ workspace, source: "screen" });
            assert.strictEqual(result.ok, true, "screenshot should succeed: " + result.error);
            assert(
                result.path.indexOf("screenshots/") === 0,
                "default path should be under screenshots/, got " + result.path
            );
        });
        await check("window not found gives clean error", async () => {
            const result = await takeScreenshot({
                workspace,
                source: "window",
                windowTitle: "**definitely_not_a_window_xyz**",
                path: "shots/notfound.png",
            });
            assert.strictEqual(result.ok, false);
            assert(result.error && result.error.length > 0, "should have error message");
            assert(
                !fs.existsSync(path.join(workspace, "shots", "notfound.png")),
                "failed capture should not leave residual file"
            );
        });
    }
    try {
        fs.rmSync(workspace, { recursive: true, force: true });
    } catch (error) {
        // ignore
    }
    console.log("");
    console.log("Total: " + (passed + failed) + ", Passed: " + passed + ", Failed: " + failed);
    if (failed > 0) {
        process.exit(1);
    }
}
run().catch((error) => {
    console.error("ROBUSTNESS TEST CRASHED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
