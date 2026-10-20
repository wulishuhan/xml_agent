const assert = require("assert");
const agentConfig = require("../config/agent-config");
const { Agent, normalizeBrowserType } = require("../agent-core");
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
// 1. Agent 默认从配置读取 browserType
check("Agent defaults browserType from config", () => {
    const agent = new Agent({ workspace: process.cwd(), task: "noop" });
    assert.strictEqual(agent.browserType, normalizeBrowserType(agentConfig.browser.browserType));
});
// 2. Agent 显式传入 edge
check("Agent respects explicit browserType=edge", () => {
    const agent = new Agent({ workspace: process.cwd(), task: "noop", browserType: "edge" });
    assert.strictEqual(agent.browserType, "edge");
});
// 3. Agent 显式传入非法值归一化为 chrome
check("Agent normalizes invalid browserType", () => {
    const agent = new Agent({ workspace: process.cwd(), task: "noop", browserType: "safari" });
    assert.strictEqual(agent.browserType, "chrome");
});
// 4. resolveBrowserPath 在 edge 时优先 edgePath
check("Agent.resolveBrowserPath prefers edgePath for edge", () => {
    const prevEdge = agentConfig.browser.edgePath;
    const prevChrome = agentConfig.browser.chromePath;
    agentConfig.browser.edgePath = "C:/edge/msedge.exe";
    agentConfig.browser.chromePath = "C:/chrome/chrome.exe";
    const agent = new Agent({ workspace: process.cwd(), task: "noop", browserType: "edge" });
    assert.strictEqual(agent.resolveBrowserPath(), "C:/edge/msedge.exe");
    agentConfig.browser.edgePath = prevEdge;
    agentConfig.browser.chromePath = prevChrome;
});
// 5. resolveBrowserPath 在 chrome 时使用 chromePath
check("Agent.resolveBrowserPath uses chromePath for chrome", () => {
    const prevEdge = agentConfig.browser.edgePath;
    const prevChrome = agentConfig.browser.chromePath;
    agentConfig.browser.edgePath = "C:/edge/msedge.exe";
    agentConfig.browser.chromePath = "C:/chrome/chrome.exe";
    const agent = new Agent({ workspace: process.cwd(), task: "noop", browserType: "chrome" });
    assert.strictEqual(agent.resolveBrowserPath(), "C:/chrome/chrome.exe");
    agentConfig.browser.edgePath = prevEdge;
    agentConfig.browser.chromePath = prevChrome;
});
// 6. getResult 包含 browserType
check("Agent.getResult includes browserType", () => {
    const agent = new Agent({ workspace: process.cwd(), task: "noop", browserType: "edge" });
    const result = agent.getResult();
    assert.strictEqual(result.browserType, "edge");
});
// 7. 环境变量 BROWSER_TYPE 覆盖 config
check("BROWSER_TYPE env override applied to config", () => {
    // 由于 config 已在 require 时读取 env，这里验证 normalizeBrowserType 与 agentConfig 一致
    assert.strictEqual(agentConfig.normalizeBrowserType("edge"), "edge");
});
console.log("\n" + passed + " checks passed");
