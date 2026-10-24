const path = require("path");
const fs = require("fs");
const browserSettings = require("../webui/browser-settings");
const { takeScreenshot } = require("../webui/screenshot-api");
async function run() {
    const workspace = path.resolve(__dirname, "..", "test-output-screenshot");
    fs.mkdirSync(workspace, { recursive: true });
    // 1. 确保 CDP 浏览器可用（复用浏览器设置模块）
    const settings = browserSettings.readSettings();
    console.log("BROWSER_TYPE:" + settings.browserType);
    console.log("CDP_URL:" + browserSettings.resolveCdpUrl(settings, settings.browserType));
    const statusBefore = await browserSettings.getStatus();
    console.log("STATUS_BEFORE:" + JSON.stringify(statusBefore));
    if (!statusBefore.cdpRunning) {
        console.log("CDP not running, launching...");
        const launched = await browserSettings.ensureBrowserCdp(settings);
        console.log("LAUNCH_RESULT:" + JSON.stringify(launched));
        if (!launched.ok) {
            console.log("SKIP: unable to start CDP browser: " + launched.message);
            return;
        }
    }
    const statusAfter = await browserSettings.getStatus();
    console.log("STATUS_AFTER:" + JSON.stringify(statusAfter));
    if (!statusAfter.cdpRunning) {
        throw new Error("CDP still not running after launch");
    }
    // 2. 截取指定 URL 的浏览器页面（新开临时页截图）
    const urlResult = await takeScreenshot({
        workspace: workspace,
        source: "browser_page",
        url: "https://example.com",
        path: "screenshots/cdp-example.png",
        timeout: 30000,
    });
    console.log("URL_RESULT:" + JSON.stringify(urlResult));
    if (!urlResult.ok) {
        throw new Error("browser_page url screenshot failed: " + urlResult.error);
    }
    // 3. 不指定 URL，截取当前活动页面
    const activeResult = await takeScreenshot({
        workspace: workspace,
        source: "browser_page",
        path: "screenshots/cdp-active.png",
        timeout: 30000,
    });
    console.log("ACTIVE_RESULT:" + JSON.stringify(activeResult));
    if (!activeResult.ok) {
        throw new Error("browser_page active screenshot failed: " + activeResult.error);
    }
    console.log("CDP SCREENSHOT TEST PASSED");
    process.exit(0);
}
run().catch((error) => {
    console.error("CDP TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
