/**

验证 Electron 桌面版用户配置读写逻辑（settings.js）。

由于 settings.js 依赖 app.getPath("userData")，

这里用一个假的 app 对象替代，避免依赖 Electron 运行时。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const settings = require(path.join(__dirname, "..", "electron", "settings.js"));

function makeFakeApp(userDataDir) {
    return {
        getPath(name) {
            if (name === "userData") {
                return userDataDir;
            }

            throw new Error("Unexpected app.getPath: " + name);
        },
    };
}

function main() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xml-agent-settings-"));
    const app = makeFakeApp(userDataDir);

    try {
        const defaults = settings.readSettings(app);

        assert.strictEqual(defaults.chromePath, "", "default chromePath should be empty");
        assert.strictEqual(defaults.cdpUrl, "http://127.0.0.1:9222", "default cdpUrl");
        assert.strictEqual(defaults.autoStartChrome, true, "default autoStartChrome");

        const written = settings.writeSettings(app, {
            chromePath: "C:/Some/Chrome/chrome.exe",
            cdpUrl: "http://127.0.0.1:9223",
            autoStartChrome: false,
        });

        assert.strictEqual(written.chromePath, "C:/Some/Chrome/chrome.exe");
        assert.strictEqual(written.cdpUrl, "http://127.0.0.1:9223");
        assert.strictEqual(written.autoStartChrome, false);

        const reloaded = settings.readSettings(app);

        assert.strictEqual(reloaded.chromePath, "C:/Some/Chrome/chrome.exe");
        assert.strictEqual(reloaded.cdpUrl, "http://127.0.0.1:9223");
        assert.strictEqual(reloaded.autoStartChrome, false);

        const settingsPath = settings.getSettingsPath(app);

        assert.ok(fs.existsSync(settingsPath), "settings file should exist after write");

        console.log("Electron settings test passed: read/write/persist ok");
    } finally {
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch (e) {
            // ignore
        }
    }
}

try {
    main();
} catch (error) {
    console.error("Electron settings test failed:", error.message);
    process.exitCode = 1;
}
