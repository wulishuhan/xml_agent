const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { listWindows } = require("../capture/screenshot");
const { Runtime } = require("../runtime");
// 真实多窗口截图测试：
//   1. 枚举当前可见窗口
//   2. 选最多 4 个不同标题的窗口作为 target（外加一张全屏）
//   3. 用 runtime.screenshot 一次性截取全部
//   4. 断言 results / succeeded / failed / paths 与磁盘文件
//
// 注意：真实环境里某些窗口（例如被 DWM 特殊处理、处于隐藏/最小化状态、
// 或属于受保护进程）会导致 PrintWindow 失败。多目标语义本身允许"部分成功"，
// 因此本测试要求：
//   - 至少 2 个 target 成功
//   - succeeded + failed === count
//   - 每个成功的 path 都真实存在于磁盘且非空
//   - paths 与成功的 results 一一对应
// 而不要求"全部成功"。
async function run() {
    if (process.platform !== "win32") {
        console.log("SKIP: window enumeration only supported on Windows");
        return;
    }
    const workspace = path.resolve(__dirname, "..", "test-output-screenshot-multi");
    fs.mkdirSync(workspace, { recursive: true });
    const titles = await listWindows();
    console.log("VISIBLE_WINDOWS_COUNT:" + titles.length);
    console.log("VISIBLE_WINDOWS:" + JSON.stringify(titles));
    // 去重，优先选不同的真实应用窗口
    const unique = [];
    for (const t of titles) {
        if (!t) continue;
        if (unique.indexOf(t) === -1) unique.push(t);
    }
    const picked = unique.slice(0, 4);
    if (!picked.length) {
        console.log("SKIP: no visible windows");
        return;
    }
    const targets = picked.map((title, index) => ({
        "@_source": "window",
        "@_windowTitle": title,
        "@_path": "shots/w" + (index + 1) + ".png",
    }));
    // 再追加一张全屏，凑成多目标（screen 与 window 混合）
    targets.push({ "@_source": "screen", "@_path": "shots/desktop.png" });
    console.log("TARGET_COUNT:" + targets.length);
    const runtime = new Runtime(workspace);
    const result = await runtime.run({
        action: "screenshot",
        node: { target: targets },
    });
    console.log(
        "SUMMARY: ok=" +
            result.ok +
            " count=" +
            result.count +
            " succeeded=" +
            result.succeeded +
            " failed=" +
            result.failed
    );
    assert.strictEqual(result.action, "screenshot");
    assert.strictEqual(result.multi, true);
    assert.strictEqual(result.count, targets.length);
    assert.strictEqual(result.succeeded + result.failed, targets.length, "counts must add up");
    assert(result.succeeded >= 2, "at least 2 targets should succeed, got " + result.succeeded);
    assert.strictEqual(result.ok, true, "partial success should still be ok=true");
    const okResults = result.results.filter((item) => item.ok);
    const failedResults = result.results.filter((item) => !item.ok);
    assert.strictEqual(okResults.length, result.succeeded);
    assert.strictEqual(failedResults.length, result.failed);
    assert.strictEqual(result.paths.length, result.succeeded);
    // 成功的每个 path 都要真实存在且非空
    for (const item of okResults) {
        const absolute = path.join(workspace, item.path);
        assert(fs.existsSync(absolute), "file should exist: " + absolute);
        assert(fs.statSync(absolute).size > 1000, "file should be non-trivial: " + absolute);
        assert(result.paths.indexOf(item.path) !== -1, "paths should include " + item.path);
    }
    // 失败项必须带 error 说明
    for (const item of failedResults) {
        assert(item.error, "failed result should carry error message");
    }
    console.log("MULTI_LIVE_OK");
    console.log("succeeded=" + result.succeeded + " failed=" + result.failed);
    console.log("paths=" + JSON.stringify(result.paths));
    if (failedResults.length) {
        console.log(
            "failed=" +
                JSON.stringify(
                    failedResults.map((item) => ({
                        title: item.windowTitle || item.source,
                        error: String(item.error).split(String.fromCharCode(10))[0],
                    }))
                )
        );
    }
    try {
        fs.rmSync(workspace, { recursive: true, force: true });
    } catch (e) {
        // ignore
    }
}
run().catch((error) => {
    console.error("MULTI LIVE TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
