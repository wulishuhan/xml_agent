const assert = require("assert");
const path = require("path");
const fs = require("fs");
const browserSettings = require("../webui/browser-settings");
const { Agent } = require("../agent-core");
// ============================================================
// 真实 CDP + DeepSeek 端到端流程测试：
//   截图 -> 上传给大模型 -> 大模型看到图片后回复 -> answer
//
// 流程说明：
//   1. 确保 CDP 浏览器可用（Edge/Chrome，自动启动）
//   2. 把浏览器配置同步到运行时 env（BROWSER_CDP_URL / BROWSER_TYPE 等）
//   3. 创建 Agent（provider=deepseek），任务要求：
//        第一轮：只输出 screenshot 动作（截桌面，保存到 workspace）
//        第二轮：系统会自动把截图上传给模型，模型需描述图片内容并 answer
//   4. 断言：
//        - 有 screenshot action 被解析
//        - runtime.result 中 screenshot ok=true 且 uploaded=true
//        - 有 screenshot.uploaded 事件
//        - 截图文件真实存在
//        - 最终 answer 非空
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
    const workspace = path.resolve(__dirname, "..", "test-output-deepseek-flow");
    fs.mkdirSync(workspace, { recursive: true });
    console.log("[step1] ensuring CDP browser...");
    const cdpStatus = await ensureCdp();
    console.log("[step1] ok, cdpUrl=" + cdpStatus.cdpUrl);
    // 把浏览器配置同步到运行时 env，让 Agent/Provider 使用同一 CDP
    browserSettings.applyToRuntime(browserSettings.readSettings());
    process.env.BROWSER_CDP_URL = cdpStatus.cdpUrl;
    process.env.XML_AGENT_CDP_URL = cdpStatus.cdpUrl;
    process.env.BROWSER_TYPE = cdpStatus.browserType;
    process.env.XML_AGENT_BROWSER_TYPE = cdpStatus.browserType;
    const task = [
        "这是一个能力测试任务。你具备 screenshot 能力，可以把截图保存到 workspace 并上传给你自己查看。",
        "请严格按以下步骤执行：",
        "第 1 步：只输出下面这一个 XML 动作，不要输出任何其它内容：",
        '<screenshot source="screen" path="screenshots/deepseek-shot.png"/>',
        "第 2 步：系统会把刚才的截图上传给你。请描述你在这张截图中看到的主要内容（例如有哪些窗口/应用），",
        "然后用 <answer><![CDATA[你看到的内容描述]]></answer> 回复。",
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
                    (r.path ? " path=" + r.path : "") +
                    (r.uploaded !== undefined ? " uploaded=" + r.uploaded : "")
            );
        } else if (e.type === "screenshot.uploaded") {
            console.log(
                "[event] screenshot.uploaded -> path=" + e.path + " uploaded=" + e.uploaded
            );
        } else if (e.type === "provider.response") {
            console.log("[event] provider.response -> length=" + e.length);
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
        console.error("captured events:");
        for (const e of events) {
            console.error("  - " + e.type + " " + JSON.stringify(e).slice(0, 200));
        }
        throw error;
    }
    console.log("[step3] agent done. status=" + result.status + " steps=" + result.step);
    // ===== 断言 1：screenshot 动作被解析 =====
    const parsedActions = events.filter((e) => e.type === "action.parsed").map((e) => e.action);
    console.log("[assert] parsed actions: " + JSON.stringify(parsedActions));
    assert(
        parsedActions.indexOf("screenshot") !== -1,
        "should parse at least one screenshot action, got: " + JSON.stringify(parsedActions)
    );
    // ===== 断言 2：runtime.result 中 screenshot ok 且 uploaded =====
    const shotResults = events
        .filter((e) => e.type === "runtime.result" && e.result && e.result.action === "screenshot")
        .map((e) => e.result);
    console.log("[assert] screenshot results: " + JSON.stringify(shotResults));
    assert(shotResults.length > 0, "should have at least one screenshot runtime result");
    const okShot = shotResults.find((r) => r.ok === true);
    assert(okShot, "at least one screenshot should succeed: " + JSON.stringify(shotResults));
    assert.strictEqual(okShot.uploaded, true, "screenshot should be uploaded to provider");
    // ===== 断言 3：有 screenshot.uploaded 事件 =====
    const uploadEvents = events.filter((e) => e.type === "screenshot.uploaded");
    assert(uploadEvents.length > 0, "should emit screenshot.uploaded event");
    assert.strictEqual(uploadEvents[0].uploaded, true, "screenshot.uploaded should be true");
    // ===== 断言 4：截图文件真实存在 =====
    const shotPath = path.join(workspace, "screenshots", "deepseek-shot.png");
    assert(fs.existsSync(shotPath), "screenshot file should exist: " + shotPath);
    const stat = fs.statSync(shotPath);
    assert(stat.size > 1000, "screenshot file should be non-trivial size, got " + stat.size);
    // ===== 断言 5：最终 answer 非空 =====
    assert(result.answer && result.answer.trim(), "final answer should be non-empty");
    console.log("[assert] final answer preview: " + String(result.answer).slice(0, 200));
    console.log("");
    console.log("DEEPSEEK_SCREENSHOT_FLOW_OK");
    console.log("status=" + result.status);
    console.log("steps=" + result.step);
    console.log("screenshot=" + shotPath + " (" + stat.size + " bytes)");
    console.log("conversationId=" + (result.conversationId || "(none)"));
}
main().catch((error) => {
    console.error("");
    console.error("DEEPSEEK SCREENSHOT FLOW TEST FAILED:");
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
