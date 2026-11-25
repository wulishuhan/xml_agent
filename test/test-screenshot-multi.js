const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { extractAction } = require("../parse/json-action");
const { Runtime } = require("../runtime");
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
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-multi-"));
    // ===== 解析层 =====
    function parseScreenshot(targets, fenced) {
        const response = JSON.stringify({ action: "screenshot", params: { targets } });
        const candidate = fenced ? "```json\n" + response + "\n```" : response;
        return extractAction(candidate);
    }
    await check("parse multi-target screenshot", async () => {
        const action = parseScreenshot([
            { source: "screen", path: "shots/a.png" },
            { source: "window", windowTitle: "Visual Studio Code", path: "shots/b.png" },
        ]);
        assert.strictEqual(action.action, "screenshot");
        assert.strictEqual(action.params.targets.length, 2);
        assert.strictEqual(action.params.targets[0].source, "screen");
        assert.strictEqual(action.params.targets[1].windowTitle, "Visual Studio Code");
    });
    await check("single-element targets array still parses", async () => {
        const action = parseScreenshot([{ source: "screen", path: "a.png" }]);
        assert.strictEqual(action.action, "screenshot");
        assert.strictEqual(action.params.targets.length, 1);
        assert.strictEqual(action.params.targets[0].source, "screen");
    });
    await check("multi-target requires valid source", async () => {
        assert.throws(
            () => parseScreenshot([{ source: "magic", path: "a.png" }]),
            /source.*allowed values/
        );
    });
    await check("multi-target window requires windowTitle or title", async () => {
        assert.throws(
            () => parseScreenshot([{ source: "window", path: "a.png" }]),
            /windowTitle|title/
        );
    });
    await check("multi-target max 8 targets", async () => {
        const targets = Array.from({ length: 9 }, (_, index) => ({
            source: "screen",
            path: "s" + index + ".png",
        }));
        assert.throws(() => parseScreenshot(targets), /must NOT have more than 8 items/);
    });
    await check("multi-target with json fence", async () => {
        const action = parseScreenshot(
            [
                { source: "screen", path: "a.png" },
                { source: "screen", path: "b.png" },
            ],
            true
        );
        assert.strictEqual(action.params.targets.length, 2);
    });
    // ===== Runtime 层 =====
    if (process.platform === "win32") {
        await check("runtime multi screenshot returns results array", async () => {
            const runtime = new Runtime(workspace);
            const result = await runtime.run({
                action: "screenshot",
                params: {
                    targets: [
                        { source: "screen", path: "shots/desk.png" },
                        { source: "screen", path: "shots/desk2.png" },
                    ],
                },
            });
            assert.strictEqual(result.ok, true, "multi screenshot should succeed: " + result.error);
            assert.strictEqual(result.multi, true);
            assert.strictEqual(result.count, 2);
            assert.strictEqual(result.succeeded, 2);
            assert.strictEqual(result.failed, 0);
            assert(Array.isArray(result.results));
            assert.strictEqual(result.results.length, 2);
            assert.deepStrictEqual(
                result.paths.sort(),
                ["shots/desk.png", "shots/desk2.png"].sort()
            );
            assert(fs.existsSync(path.join(workspace, "shots", "desk.png")));
            assert(fs.existsSync(path.join(workspace, "shots", "desk2.png")));
        });
        await check("runtime partial failure returns failed count", async () => {
            const runtime = new Runtime(workspace);
            const result = await runtime.run({
                action: "screenshot",
                params: {
                    targets: [
                        { source: "screen", path: "shots/ok.png" },
                        {
                            source: "window",
                            windowTitle: "**no_such_window**",
                            path: "shots/bad.png",
                        },
                    ],
                },
            });
            assert.strictEqual(result.multi, true);
            assert.strictEqual(result.count, 2);
            assert.strictEqual(result.succeeded, 1);
            assert.strictEqual(result.failed, 1);
            assert.strictEqual(result.ok, true, "partial success should still be ok=true");
            assert.deepStrictEqual(result.paths, ["shots/ok.png"]);
        });
        await check("runtime all failure returns ok=false", async () => {
            const runtime = new Runtime(workspace);
            const result = await runtime.run({
                action: "screenshot",
                params: {
                    targets: [
                        {
                            source: "window",
                            windowTitle: "**no_window_a**",
                            path: "shots/x1.png",
                        },
                        {
                            source: "window",
                            windowTitle: "**no_window_b**",
                            path: "shots/x2.png",
                        },
                    ],
                },
            });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.failed, 2);
            assert.strictEqual(result.succeeded, 0);
        });
        await check("runtime rejects escaping path in single target", async () => {
            const runtime = new Runtime(workspace);
            const result = await runtime.run({
                action: "screenshot",
                params: { targets: [{ source: "screen", path: "../evil.png" }] },
            });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.action, "screenshot");
            assert.strictEqual(result.source, "screen");
            assert.strictEqual(result.error, "Path escapes workspace");
            assert.strictEqual(result.failed, undefined, "单目标不应伪装成多目标汇总");
        });
        await check("runtime single screenshot still works", async () => {
            const runtime = new Runtime(workspace);
            const result = await runtime.run({
                action: "screenshot",
                params: { targets: [{ source: "screen", path: "shots/single.png" }] },
            });
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.multi, undefined);
            assert.strictEqual(result.path, "shots/single.png");
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
    console.error("MULTI SCREENSHOT TEST CRASHED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
