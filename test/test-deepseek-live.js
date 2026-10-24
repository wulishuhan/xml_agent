const assert = require("assert");
const path = require("path");
const fs = require("fs");
const browserSettings = require("../webui/browser-settings");
const { DeepSeekProvider, extractXmlFromCandidate } = require("../providers/deepseek");
const { extractXML } = require("../parse/xml-parse");
const { takeScreenshot } = require("../webui/screenshot-api");
// ============================================================
// DeepSeek CDP 浏览器端到端测试用例（真实连接 CDP + 真实对话）
//
// 前置：本机已安装 Chrome 或 Edge，且允许自动启动 CDP（端口 9222/9223）。
// 步骤：
//   1. 确保 CDP 浏览器可用（复用 webui/browser-settings）
//   2. DeepSeekProvider.start() 连接 CDP 并定位输入框
//   3. 发送一条极短任务，要求模型只回一个 XML action（截屏），验证：
//        a) 能拿到非空响应
//        b) 响应能被 extractXmlFromCandidate 提取为 XML
//        c) 能被 parse/xml-parse 解析为合法 action
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
            "请只回复下面这一行 XML，不要加任何解释、不要加代码块：",
            "<answer><![CDATA[deepseek-cdp-ok]]></answer>",
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
        console.log("[step4] extracting XML...");
        let candidate = extractXmlFromCandidate(response);
        let parsed = null;
        if (candidate) {
            parsed = extractXML(candidate);
        } else {
            // 兜底：万一模型回复里混入其它文本，直接尝试从全文解析
            try {
                parsed = extractXML(response);
            } catch (err) {
                parsed = null;
            }
        }
        console.log("[step4] candidate=" + (candidate ? candidate.slice(0, 120) : "null"));
        console.log("[step4] parsed action=" + (parsed ? parsed.action : "null"));
        assert(parsed, "should parse a valid XML action from DeepSeek response");
        assert(
            ["answer", "screenshot", "read", "write", "exec", "done"].indexOf(parsed.action) !== -1,
            "parsed action should be a known action, got " + parsed.action
        );
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
