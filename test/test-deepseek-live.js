const assert = require("assert");
const path = require("path");
const fs = require("fs");
const browserSettings = require("../webui/browser-settings");
const { DeepSeekProvider } = require("../providers/deepseek");
const { extractAction } = require("../parse/json-action");
const { takeScreenshot } = require("../plugins/builtin/screenshot/engine/take-screenshot");
// ============================================================
// DeepSeek CDP 浏览器端到端测试用例（真实连接 CDP + 真实对话）
//
// 前置：本机已安装 Chrome 或 Edge，且允许自动启动 CDP（端口 9222/9223）。
// 步骤：
//   1. 确保 CDP 浏览器可用（复用 webui/browser-settings）
//   2. DeepSeekProvider.start() 连接 CDP 并定位输入框
//   3. 发送一条极短任务，要求模型只回一个 JSON action（answer），验证：
//        a) 能拿到非空响应
//        b) 响应能被 parse/json-action 的 extractAction 解析为合法动作
//        c) answer 内容符合预期
//        d) conversationId 被正确提取
//   4. 截图能力顺带验证：截当前 CDP 页面，确认落盘
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
    const workspace = path.resolve(__dirname, "..", "test-output-deepseek-live");
    fs.mkdirSync(workspace, { recursive: true });
    let provider = null;
    try {
        console.log("[step1] ensuring CDP browser...");
        const cdpStatus = await ensureCdp();
        console.log("[step1] ok, cdpUrl=" + cdpStatus.cdpUrl);
        console.log("[step2] creating DeepSeekProvider...");
        provider = new DeepSeekProvider({
            autoStart: true,
            cdpUrl: cdpStatus.cdpUrl,
            browserType: cdpStatus.browserType,
            targetUrl: "https://chat.deepseek.com",
            reuseExistingPage: true,
            focusCdpPage: false,
            responseTimeout: 5 * 60 * 1000,
            responseInitialTimeout: 2 * 60 * 1000,
            responseStableTime: 4000,
            responsePollInterval: 1000,
            inputTimeout: 120 * 1000,
        });
        console.log("[step2] provider.start()...");
        await provider.start();
        console.log("[step2] connected. page url=" + (provider.page ? provider.page.url() : "n/a"));
        console.log("[step3] sending prompt to DeepSeek...");
        const prompt = [
            "这是一个自动化能力测试。",
            "请只回复下面这一行 JSON，不要加任何解释、不要加代码块：",
            JSON.stringify({ action: "answer", params: { content: "deepseek-cdp-ok" } }),
        ].join(String.fromCharCode(10));
        const t0 = Date.now();
        const response = await provider.send(prompt);
        const cost = Date.now() - t0;
        console.log(
            "[step3] response received in " + cost + "ms, length=" + (response || "").length
        );
        console.log("[step3] response preview:");
        console.log(String(response || "").slice(0, 400));
        assert(response && response.trim(), "DeepSeek response should be non-empty");
        console.log("[step4] extracting JSON action...");
        const parsed = extractAction(response);
        console.log("[step4] parsed action=" + JSON.stringify(parsed));
        assert.strictEqual(parsed.action, "answer", "parsed action should be answer");
        assert.strictEqual(parsed.params.content, "deepseek-cdp-ok", "answer content should match");
        console.log("[step5] conversation id...");
        const cid = provider.refreshConversationId();
        console.log("[step5] conversationId=" + cid);
        assert(cid, "conversation id should be extracted from DeepSeek url");
        console.log("[step6] screenshot current CDP page...");
        const shot = await takeScreenshot({
            workspace: workspace,
            source: "browser_page",
            path: "screenshots/deepseek-live.png",
        });
        console.log("[step6] screenshot => " + JSON.stringify(shot));
        assert(shot && shot.ok, "screenshot of current CDP page should succeed");
        assert(shot.width > 0 && shot.height > 0, "screenshot should have positive dimensions");
        console.log("");
        console.log("DEEPSEEK_CDP_OK");
        console.log("conversationId=" + cid);
        console.log("action=" + parsed.action);
        console.log("screenshot=" + shot.path + " " + shot.width + "x" + shot.height);
    } finally {
        if (provider) {
            try {
                await provider.close();
                console.log("[cleanup] provider closed");
            } catch (error) {
                console.warn("[cleanup] provider close failed:", error.message);
            }
        }
    }
}
main().catch((error) => {
    console.error("");
    console.error("DEEPSEEK CDP TEST FAILED:");
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
