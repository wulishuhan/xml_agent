const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const settingsModule = require("../electron/settings");
const finder = require("../electron/chrome-finder");
// 用临时目录模拟 Electron app.getPath("userData")
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xml-agent-settings-test-"));
const fakeApp = {
    getPath(name) {
        if (name === "userData") return tempDir;
        throw new Error("unexpected getPath: " + name);
    },
};
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
try {
    // 1. 首次读取返回默认值（browserType=chrome）
    check("readSettings returns defaults when file missing", () => {
        const settings = settingsModule.readSettings(fakeApp);
        assert.strictEqual(settings.browserType, "chrome");
        assert.strictEqual(settings.chromePath, "");
        assert.strictEqual(settings.cdpUrl, "http://127.0.0.1:9222");
        // 两浏览器使用独立默认端口
        assert.strictEqual(settings.cdpUrls.edge, "http://127.0.0.1:9223");
    });
    // 2. 写入 edge 设置并读回
    check("writeSettings persists browserType=edge", () => {
        const saved = settingsModule.writeSettings(fakeApp, {
            browserType: "edge",
            chromePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
            cdpUrls: {
                chrome: "http://127.0.0.1:9222",
                edge: "http://127.0.0.1:9333",
            },
            autoStartChrome: false,
            focusCdpPage: false,
        });
        assert.strictEqual(saved.browserType, "edge");
        const reread = settingsModule.readSettings(fakeApp);
        assert.strictEqual(reread.browserType, "edge");
        assert.strictEqual(reread.cdpUrl, "http://127.0.0.1:9333");
        assert.strictEqual(reread.cdpUrls.edge, "http://127.0.0.1:9333");
        assert.strictEqual(reread.autoStartChrome, false);
        assert.strictEqual(reread.focusCdpPage, false);
    });
    // 3. 非法 browserType 归一化为 chrome
    check("writeSettings normalizes invalid browserType", () => {
        const saved = settingsModule.writeSettings(fakeApp, {
            browserType: "firefox",
            chromePath: "",
        });
        assert.strictEqual(saved.browserType, "chrome");
    });
    // 4. 未指定 cdpUrls 时，cdpUrl 反映当前所选浏览器的独立默认端口
    check("writeSettings maps cdpUrl to per-browser default port", () => {
        const saved = settingsModule.writeSettings(fakeApp, {
            browserType: "edge",
        });
        assert.strictEqual(saved.browserType, "edge");
        // Edge 默认使用 9223，避免与 Chrome(9222) 冲突
        assert.strictEqual(saved.cdpUrl, "http://127.0.0.1:9223");
        assert.strictEqual(saved.cdpUrls.chrome, "http://127.0.0.1:9222");
        assert.strictEqual(saved.autoStartChrome, true);
        assert.strictEqual(saved.focusCdpPage, true);
    });
    // 5. findBrowser 使用 explicitPath 直接命中
    check("findBrowser honors explicitPath", () => {
        const tmpFile = path.join(tempDir, "msedge.exe");
        fs.writeFileSync(tmpFile, "fake", "utf8");
        const found = finder.findBrowser({
            explicitPath: tmpFile,
            browserType: "edge",
        });
        assert.strictEqual(found, tmpFile);
    });
    // 6. findEdge / findChrome 导出存在
    check("findEdge and findChrome exported", () => {
        assert.strictEqual(typeof finder.findEdge, "function");
        assert.strictEqual(typeof finder.findChrome, "function");
    });
} finally {
    // 清理临时目录
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
        console.error("Failed to clean temp dir: " + error.message);
    }
}
console.log("\n" + passed + " checks passed");
