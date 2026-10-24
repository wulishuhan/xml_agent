const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { extractXML, normalizeScreenshotTargets } = require("../parse/xml-parse");
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
    await check("parse multi-target screenshot", async () => {
        const xml = [
            "<screenshot>",
            '  <target source="screen" path="shots/a.png"/>',
            '  <target source="window" windowTitle="Visual Studio Code" path="shots/b.png"/>',
            "</screenshot>",
        ].join(String.fromCharCode(10));
        const action = extractXML(xml);
        assert.strictEqual(action.action, "screenshot");
        const targets = normalizeScreenshotTargets(action.node);
        assert.strictEqual(targets.length, 2);
        assert.strictEqual(targets[0]["@_source"], "screen");
        assert.strictEqual(targets[1]["@_windowTitle"], "Visual Studio Code");
    });
    await check("old single screenshot still parses", async () => {
        const action = extractXML('<screenshot source="screen" path="a.png"/>');
        assert.strictEqual(action.action, "screenshot");
        assert.strictEqual(action.node["@_source"], "screen");
        assert.strictEqual(normalizeScreenshotTargets(action.node).length, 0);
    });
    await check("multi-target requires valid source", async () => {
        const xml = [
            "<screenshot>",
            '  <target source="magic" path="a.png"/>',
            "</screenshot>",
        ].join(String.fromCharCode(10));
        assert.throws(() => extractXML(xml), /source must be one of/);
    });
    await check("multi-target window requires windowTitle", async () => {
        const xml = [
            "<screenshot>",
            '  <target source="window" path="a.png"/>',
            "</screenshot>",
        ].join(String.fromCharCode(10));
        assert.throws(() => extractXML(xml), /requires windowTitle/);
    });
    await check("multi-target max 8 targets", async () => {
        const lines = ["<screenshot>"];
        for (let i = 0; i < 9; i += 1) {
            lines.push('  <target source="screen" path="s' + i + '.png"/>');
        }
        lines.push("</screenshot>");
        assert.throws(() => extractXML(lines.join(String.fromCharCode(10))), /at most 8 targets/);
    });
    await check("multi-target with xml fence", async () => {
        const fence = String.fromCharCode(96, 96, 96);
        const xml =
            fence +
            "xml" +
            String.fromCharCode(10) +
            "<screenshot>" +
            String.fromCharCode(10) +
            '  <target source="screen" path="a.png"/>' +
            String.fromCharCode(10) +
            '  <target source="screen" path="b.png"/>' +
            String.fromCharCode(10) +
            "</screenshot>" +
            String.fromCharCode(10) +
            fence;
        const action = extractXML(xml);
        assert.strictEqual(normalizeScreenshotTargets(action.node).length, 2);
    });
    // ===== Runtime 层 =====
    if (process.platform === "win32") {
        await check("runtime multi screenshot returns results array", async () => {
            const runtime = new Runtime(workspace);
            const result = await runtime.run({
                action: "screenshot",
                node: {
                    target: [
                        { "@_source": "screen", "@_path": "shots/desk.png" },
                        { "@_source": "screen", "@_path": "shots/desk2.png" },
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
                node: {
                    target: [
                        { "@_source": "screen", "@_path": "shots/ok.png" },
                        {
                            "@_source": "window",
                            "@_windowTitle": "**no_such_window**",
                            "@_path": "shots/bad.png",
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
                node: {
                    target: [
                        {
                            "@_source": "window",
                            "@_windowTitle": "**no_window_a**",
                            "@_path": "shots/x1.png",
                        },
                        {
                            "@_source": "window",
                            "@_windowTitle": "**no_window_b**",
                            "@_path": "shots/x2.png",
                        },
                    ],
                },
            });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.failed, 2);
            assert.strictEqual(result.succeeded, 0);
        });
        await check("runtime rejects escaping path in target", async () => {
            const runtime = new Runtime(workspace);
            const result = await runtime.run({
                action: "screenshot",
                node: {
                    target: [{ "@_source": "screen", "@_path": "../evil.png" }],
                },
            });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.failed, 1);
        });
        await check("runtime single screenshot still works", async () => {
            const runtime = new Runtime(workspace);
            const result = await runtime.run({
                action: "screenshot",
                node: { "@_source": "screen", "@_path": "shots/single.png" },
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
