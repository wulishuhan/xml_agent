/**
Electron 桌面版的用户级配置持久化。
目标：把"浏览器路径 / 浏览器类型"这类跟具体机器绑定的信息保存到用户数据目录，
让用户可以在 UI 中手动指定或自动探测，而不是写死在项目里。
存储位置：app.getPath("userData")/settings.json

默认端口、浏览器设置归一化逻辑来自 `config/schema.js`（与 Web 版共用同一套实现），
本文件只负责 Electron 特有部分：settings.json 的读写、focusCdpPage 等桌面专属字段。
*/

const fs = require("fs");
const path = require("path");
const schema = require("../config/schema");

// 每种浏览器类型独立的 CDP URL，避免 Chrome 与 Edge 争用同一端口。
const DEFAULT_CDP_URLS = schema.DEFAULT_CDP_URLS;

const DEFAULT_SETTINGS = Object.assign(schema.browserSettingsDefaults(), {
    // 是否在激活 CDP 页面时把窗口焦点切到该页面标签（桌面版专有）。
    focusCdpPage: true,
});

function getSettingsPath(app) {
    const userDataDir = app.getPath("userData");
    fs.mkdirSync(userDataDir, { recursive: true });
    return path.join(userDataDir, "settings.json");
}

const normalizeBrowserType = schema.normalizeBrowserType;
const normalizeCdpUrl = schema.normalizeCdpUrl;
const normalizeBoolean = schema.normalizeBoolean;
const buildCdpUrls = schema.buildCdpUrls;

/**
归一化用户设置：
- 共用部分（browserType / chromePath / cdpUrls / cdpUrl / autoStartChrome / headless）
  交给 schema，保证与 Web 版行为完全一致；
- 桌面专有的 focusCdpPage 在此补充。
*/
function normalizeSettings(settings) {
    const raw = settings && typeof settings === "object" ? settings : {};
    const normalized = schema.normalizeBrowserSettings(raw);
    normalized.focusCdpPage = normalizeBoolean(raw.focusCdpPage, DEFAULT_SETTINGS.focusCdpPage);
    return normalized;
}

function readSettings(app) {
    const settingsPath = getSettingsPath(app);
    try {
        if (!fs.existsSync(settingsPath)) {
            return normalizeSettings({});
        }
        const raw = fs.readFileSync(settingsPath, "utf8");
        const parsed = JSON.parse(raw);
        return normalizeSettings(parsed);
    } catch (error) {
        console.warn("[Electron] Failed to read settings:", error.message);
        return normalizeSettings({});
    }
}

function writeSettings(app, settings) {
    const settingsPath = getSettingsPath(app);
    const merged = normalizeSettings(settings);
    const tmpPath = settingsPath + ".tmp";
    try {
        // 原子写入：先写临时文件，再重命名，避免进程崩溃时留下损坏的 JSON。
        fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
        fs.renameSync(tmpPath, settingsPath);
        return merged;
    } catch (error) {
        // 清理可能残留的临时文件
        try {
            if (fs.existsSync(tmpPath)) {
                fs.unlinkSync(tmpPath);
            }
        } catch (cleanupError) {
            // ignore
        }
        console.error("[Electron] Failed to write settings:", error.message);
        throw error;
    }
}

/**
解析指定浏览器类型的 CDP URL。
优先使用 settings.cdpUrls[type]，缺失时回退默认端口。
*/
function resolveCdpUrl(settings, browserType) {
    return schema.resolveCdpUrl(settings, browserType);
}

module.exports = {
    DEFAULT_SETTINGS,
    DEFAULT_CDP_URLS,
    getSettingsPath,
    readSettings,
    writeSettings,
    normalizeBrowserType,
    normalizeCdpUrl,
    normalizeBoolean,
    buildCdpUrls,
    normalizeSettings,
    resolveCdpUrl,
};
