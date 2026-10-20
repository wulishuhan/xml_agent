const assert = require("assert");
const path = require("path");
const finder = require("../electron/chrome-finder");
const launcher = require("../electron/chrome-launcher");
const settingsModule = require("../electron/settings");
const browserAgentModule = require("../providers/browser-agent");
const agentConfig = require("../config/agent-config");
let passed = 0;
function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log("PASS " + name);
    } catch (error) {
        console.error("FAIL " + name + ": " + error.message);
        process.exitCode = 1;
    }
}
// 1. 浏览器类型归一化
check("normalizeBrowserType edge", () => {
    assert.strictEqual(finder.normalizeBrowserType("edge"), "edge");
    assert.strictEqual(finder.normalizeBrowserType("msedge"), "edge");
    assert.strictEqual(finder.normalizeBrowserType("Microsoft-Edge"), "edge");
    assert.strictEqual(finder.normalizeBrowserType("EDGE"), "edge");
});
check("normalizeBrowserType chrome default", () => {
    assert.strictEqual(finder.normalizeBrowserType("chrome"), "chrome");
    assert.strictEqual(finder.normalizeBrowserType(""), "chrome");
    assert.strictEqual(finder.normalizeBrowserType(undefined), "chrome");
    assert.strictEqual(finder.normalizeBrowserType("firefox"), "chrome");
});
// 2. 路径推断浏览器类型
check("detectBrowserTypeFromPath", () => {
    assert.strictEqual(finder.detectBrowserTypeFromPath("C:/x/msedge.exe"), "edge");
    assert.strictEqual(
        finder.detectBrowserTypeFromPath(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        ),
        "edge"
    );
    assert.strictEqual(finder.detectBrowserTypeFromPath("C:/x/chrome.exe"), "chrome");
    assert.strictEqual(finder.detectBrowserTypeFromPath("/usr/bin/google-chrome"), "chrome");
});
// 3. Edge 候选路径
check("getPlatformCandidates edge returns msedge candidates", () => {
    const edgeCandidates = finder.getPlatformCandidates("edge");
    assert.ok(Array.isArray(edgeCandidates));
    assert.ok(edgeCandidates.length > 0);
    const joined = edgeCandidates.join("|").toLowerCase();
    assert.ok(
        joined.includes("msedge") || joined.includes("microsoft edge"),
        "edge candidates should mention msedge/microsoft edge"
    );
});
check("getPlatformCandidates chrome excludes edge", () => {
    const chromeCandidates = finder.getPlatformCandidates("chrome");
    const joined = chromeCandidates.join("|").toLowerCase();
    assert.ok(!joined.includes("msedge"), "chrome candidates should not include msedge");
});
// 4. buildLaunchArgs
check("buildLaunchArgs includes remote debugging port", () => {
    const args = launcher.buildLaunchArgs({
        port: 9333,
        userDataDir: "C:/tmp/p",
        browserType: "chrome",
    });
    assert.ok(args.includes("--remote-debugging-port=9333"));
    assert.ok(args.includes("--user-data-dir=C:/tmp/p"));
});
check("buildLaunchArgs edge specific flags", () => {
    const args = launcher.buildLaunchArgs({
        port: 9222,
        userDataDir: "C:/tmp/e",
        browserType: "edge",
    });
    assert.ok(args.includes("--remote-debugging-port=9222"));
    assert.ok(
        args.some((a) => a.includes("msEdgeSidebarV2")),
        "edge args should include msEdge features"
    );
});
// 5. settings 归一化
check("settings normalizeBrowserType", () => {
    assert.strictEqual(settingsModule.normalizeBrowserType("edge"), "edge");
    assert.strictEqual(settingsModule.normalizeBrowserType("chrome"), "chrome");
});
check("settings default browserType", () => {
    assert.strictEqual(settingsModule.DEFAULT_SETTINGS.browserType, "chrome");
});
// 6. BrowserAgent 构造函数读取 browserType
check("BrowserAgent respects options.browserType=edge", () => {
    const agent = new browserAgentModule.BrowserAgent({
        browserType: "edge",
        autoStart: false,
    });
    assert.strictEqual(agent.browserType, "edge");
    assert.strictEqual(agent.getBrowserLabel(), "Edge");
});
check("BrowserAgent defaults to chrome", () => {
    const prevType = process.env.BROWSER_TYPE;
    delete process.env.BROWSER_TYPE;
    delete process.env.XML_AGENT_BROWSER_TYPE;
    const agent = new browserAgentModule.BrowserAgent({ autoStart: false });
    assert.strictEqual(agent.browserType, "chrome");
    if (prevType !== undefined) process.env.BROWSER_TYPE = prevType;
});
check("BrowserAgent reads BROWSER_TYPE env", () => {
    const prev = process.env.BROWSER_TYPE;
    process.env.BROWSER_TYPE = "edge";
    const agent = new browserAgentModule.BrowserAgent({ autoStart: false });
    assert.strictEqual(agent.browserType, "edge");
    if (prev === undefined) delete process.env.BROWSER_TYPE;
    else process.env.BROWSER_TYPE = prev;
});
check("BrowserAgent edge launch args contain edge flags", () => {
    const agent = new browserAgentModule.BrowserAgent({ browserType: "edge", autoStart: false });
    const args = agent.buildLaunchArgs(9222, "C:/tmp/e");
    assert.ok(args.includes("--remote-debugging-port=9222"));
    assert.ok(args.some((a) => a.includes("msEdgeSidebarV2")));
});
// 7. agent-config 归一化
check("agent-config exports normalizeBrowserType", () => {
    assert.strictEqual(agentConfig.normalizeBrowserType("edge"), "edge");
    assert.strictEqual(agentConfig.normalizeBrowserType("chrome"), "chrome");
});
check("agent-config has browserType field", () => {
    assert.ok(
        agentConfig.browser.browserType === "chrome" || agentConfig.browser.browserType === "edge"
    );
});
console.log("\n" + passed + " checks passed");
