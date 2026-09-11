/**

Electron 桌面版的用户级配置持久化。

目标：把“Chrome 路径”这类跟具体机器绑定的信息保存到用户数据目录，

让用户可以在 UI 中手动指定或自动探测，而不是写死在项目里。

存储位置：app.getPath("userData")/settings.json
*/

const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
    chromePath: "",
    cdpUrl: "http://127.0.0.1:9222",
    autoStartChrome: true,
};

function getSettingsPath(app) {
    const userDataDir = app.getPath("userData");
    fs.mkdirSync(userDataDir, { recursive: true });
    return path.join(userDataDir, "settings.json");
}

function readSettings(app) {
    const settingsPath = getSettingsPath(app);

    try {
        if (!fs.existsSync(settingsPath)) {
            return Object.assign({}, DEFAULT_SETTINGS);
        }

        const raw = fs.readFileSync(settingsPath, "utf8");
        const parsed = JSON.parse(raw);

        return Object.assign({}, DEFAULT_SETTINGS, parsed);
    } catch (error) {
        console.warn("[Electron] Failed to read settings:", error.message);
        return Object.assign({}, DEFAULT_SETTINGS);
    }
}

function writeSettings(app, settings) {
    const settingsPath = getSettingsPath(app);
    const merged = Object.assign({}, DEFAULT_SETTINGS, settings);

    try {
        fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf8");
        return merged;
    } catch (error) {
        console.error("[Electron] Failed to write settings:", error.message);
        throw error;
    }
}

module.exports = {
    DEFAULT_SETTINGS,
    getSettingsPath,
    readSettings,
    writeSettings,
};
