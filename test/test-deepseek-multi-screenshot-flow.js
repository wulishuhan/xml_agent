const assert = require("assert");
const path = require("path");
const fs = require("fs");
const browserSettings = require("../webui/browser-settings");
const { Agent } = require("../agent-core");
// ============================================================
// 真实 CDP + DeepSeek 多图端到端流程：
//   多目标截图 -> 一次上传多张给 DeepSeek -> DeepSeek 描述图片 -> answer
//
// 与 test-deepseek-screenshot-flow.js 的区别：
//   前一个只验证单张上传；本测试验证一次截图多张后，
//   是否真的把多张图片一起上传到 DeepSeek 对话。
// ============================================================
async function ensureCdp() {
    const settings = browserSettings.readSettings();
    const status = await browserSettings.getStatus();
    console.log("[cdp] browserType=" + settings.browserType + " cdpUrl=" + status.cdpUrl);
    console.log("[cdp] running=" + status.cdpRunning);
    if (status.cdpRunning) {
        return status;
    }
    const launched = await browserSettings.ensureBrowserCdp(settings);
    console.log("[cdp] launch => " + JSON.stringify(launched));
    if (!launched.ok) {
        throw new Error("Unable to start CDP browser: " + launched.message);
    }
    const after = await browserSettings.getStatus();
    if (!after.cdpRunning) {
        throw new Error("CDP browser reported running but status check failed");
    }
    return after;
}
async function main() {
    const workspace = path.resolve(__dirname, "..", "test-output-deepseek-multi");
    fs.mkdirSync(workspace, { recursive: true });
    console.log("[step1] ensuring CDP browser...");
    const cdpStatus = await ensureCdp();
    console.log("[step1] ok, cdpUrl=" + cdpStatus.cdpUrl);
    browserSettings.applyToRuntime(browserSettings.readSettings());
    process.env.BROWSER_CDP_URL = cdpStatus.cdpUrl;
    process.env.XML_AGENT_CDP_URL = cdpStatus.cdpUrl;
    process.env.BROWSER_TYPE = cdpStatus.browserType;
    process.env.XML_AGENT_BROWSER_TYPE = cdpStatus.browserType;
    const task = [
        "这是一个能力测试任务。你具备 screenshot 能力，可以一次截多张图，系统会自动把多张图一起上传给你查看。",
        "请严格按以下步骤执行：",
        "第 1 步：只输出下面这一个 XML 动作，不要输出任何其它内容：",
        "<screenshot>",
        '  <target source="screen" path="screenshots/multi-1.png"/>',
        '  <target source="screen" path="screenshots/multi-2.png"/>',
        "</screenshot>",
        "第 2 步：系统会把刚才的 2 张截图一起上传给你。请分别描述这两张截图中看到的主要内容，",
        "然后用 <answer><![CDATA[两张截图的内容描述]]></answer> 回复。",
    ].join(String.fromCharCode(10));
    console.log("[step2] creating Agent (deepseek)...");
    const agent = new Agent({
        workspace: workspace,
        provider: "deepseek",
        task: task,
        browserType: cdpStatus.browserType,
        maxSteps: 6,
        maxProviderErrors: 2,
    });
    const events = [];
    agent.on("event", (e) => {
        events.push(e);
        if (e.type === "action.parsed") {
            console.log("[event] action.parsed -> " + e.action);
        } else if (e.type === "runtime.result") {
            const r = e.result || {};
            console.log(
                "[event] runtime.result -> action=" +
                    r.action +
                    " ok=" +
                    r.ok +
                    (r.multi ? " multi=true count=" + r.count + " succeeded=" + r.succeeded : "") +
                    (r.uploaded !== undefined ? " uploaded=" + r.uploaded : "") +
                    (r.uploadCount !== undefined ? " uploadCount=" + r.uploadCount : "")
            );
        } else if (e.type === "screenshot.uploaded") {
            console.log(
                "[event] screenshot.uploaded -> uploaded=" +
                    e.uploaded +
                    " uploadCount=" +
                    e.uploadCount +
                    " paths=" +
                    JSON.stringify(e.paths || [])
            );
        } else if (e.type === "screenshot.upload_error") {
            console.log("[event] screenshot.upload_error -> " + e.error);
        } else if (e.type === "agent.completed") {
            console.log("[event] agent.completed -> status=" + e.status + " steps=" + e.steps);
        }
    });
    console.log("[step3] running agent...");
    let result;
    try {
        result = await agent.run();
    } catch (error) {
        console.error("[step3] agent.run() failed: " + (error && error.message));
        for (const e of events) {
            console.error("  - " + e.type + " " + JSON.stringify(e).slice(0, 300));
        }
        throw error;
    }
    console.log("[step3] agent done. status=" + result.status + " steps=" + result.step);
    // ===== 断言 1：多目标 screenshot 被解析 =====
    const parsedActions = events.filter((e) => e.type === "action.parsed").map((e) => e.action);
    console.log("[assert] parsed actions: " + JSON.stringify(parsedActions));
    assert(
        parsedActions.indexOf("screenshot") !== -1,
        "should parse at least one screenshot action"
    );
    // ===== 断言 2：runtime 返回多图结果且全部成功 =====
    const shotResults = events
        .filter((e) => e.type === "runtime.result" && e.result && e.result.action === "screenshot")
        .map((e) => e.result);
    console.log(
        "[assert] screenshot results: " +
            JSON.stringify(
                shotResults.map((r) => ({
                    ok: r.ok,
                    multi: r.multi,
                    count: r.count,
                    succeeded: r.succeeded,
                    failed: r.failed,
                    uploaded: r.uploaded,
                    uploadCount: r.uploadCount,
                    paths: r.paths,
                }))
            )
    );
    assert(shotResults.length > 0, "should have screenshot runtime result");
    const multiShot = shotResults.find((r) => r.multi === true);
    assert(multiShot, "should have a multi-target screenshot result");
    assert.strictEqual(multiShot.succeeded, 2, "both targets should succeed");
    assert.strictEqual(multiShot.failed, 0);
    assert(Array.isArray(multiShot.paths), "paths should be an array");
    assert.strictEqual(multiShot.paths.length, 2, "should have 2 screenshot paths");
    // ===== 断言 3：多张图被一次性上传 =====
    assert.strictEqual(multiShot.uploaded, true, "multi screenshots should be uploaded");
    assert.strictEqual(
        multiShot.uploadCount,
        2,
        "should upload 2 images at once, got " + multiShot.uploadCount
    );
    const uploadEvents = events.filter(
        (e) => e.type === "screenshot.uploaded" && e.uploadCount === 2
    );
    assert(uploadEvents.length > 0, "should emit screenshot.uploaded with uploadCount=2");
    assert.strictEqual(uploadEvents[0].paths.length, 2, "uploaded event should carry 2 paths");
    // ===== 断言 4：两张截图文件真实存在 =====
    for (const p of multiShot.paths) {
        const absolute = path.join(workspace, p);
        assert(fs.existsSync(absolute), "screenshot file should exist: " + absolute);
        assert(fs.statSync(absolute).size > 1000, "screenshot should be non-trivial: " + absolute);
    }
    // ===== 断言 5：DeepSeek 基于多张图给出回答 =====
    assert(result.answer && result.answer.trim(), "final answer should be non-empty");
    console.log("[assert] final answer preview: " + String(result.answer).slice(0, 300));
    console.log("");
    console.log("DEEPSEEK_MULTI_SCREENSHOT_FLOW_OK");
    console.log("status=" + result.status);
    console.log("steps=" + result.step);
    console.log("paths=" + JSON.stringify(multiShot.paths));
    console.log("uploadCount=" + multiShot.uploadCount);
    console.log("conversationId=" + (result.conversationId || "(none)"));
}
main().catch((error) => {
    console.error("");
    console.error("DEEPSEEK MULTI SCREENSHOT FLOW TEST FAILED:");
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
