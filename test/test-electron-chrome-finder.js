/**

验证 Chrome 自动探测逻辑：

findChrome 在传入 explicitPath 时会优先使用该路径（当文件存在时）

findChrome 会遍历平台常见安装路径

找不到时返回 null，而不是抛异常

只测试纯逻辑，不依赖 Electron GUI。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const finder = require(path.join(__dirname, "..", "electron", "chrome-finder.js"));

async function main() {
    const candidates = finder.getPlatformCandidates();

    assert.ok(Array.isArray(candidates), "getPlatformCandidates should return an array");
    assert.ok(candidates.length > 0, "should have at least one platform candidate");

    // 用一个不存在但明显可见的路径作为 explicitPath，验证不会误用
    const missing = path.join(os.tmpdir(), "definitely-not-chrome-" + Date.now());

    const notFound = finder.findChrome({ explicitPath: missing, configPath: "" });

    assert.strictEqual(
        notFound === missing,
        false,
        "should not return a non-existent explicitPath"
    );

    // 创建一个假的 chrome.exe / chrome 文件，验证 explicitPath 优先命中
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-finder-test-"));
    const fakeName = process.platform === "win32" ? "chrome.exe" : "chrome";
    const fakePath = path.join(fakeDir, fakeName);

    fs.writeFileSync(fakePath, "stub", "utf8");

    try {
        const found = finder.findChrome({ explicitPath: fakePath, configPath: "" });
        assert.strictEqual(found, fakePath, "should return existing explicitPath");
    } finally {
        try {
            fs.unlinkSync(fakePath);
        } catch (e) {
            // ignore
        }

        try {
            fs.rmdirSync(fakeDir);
        } catch (e) {
            // ignore
        }
    }

    // 无 explicitPath、无环境变量、平台目录都不存在时，应该返回 null 或某个真实存在的路径
    const auto = finder.findChrome({ configPath: "" });

    if (auto !== null) {
        assert.ok(fs.existsSync(auto), "auto-detected path must exist");
    }

    console.log("Electron chrome finder test passed: candidates=" + candidates.length);
}

main().catch((error) => {
    console.error("Electron chrome finder test failed:", error.message);
    process.exitCode = 1;
});
