
/**
Electron 桌面版的用户级配置持久化。
目标：把“浏览器路径 / 浏览器类型”这类跟具体机器绑定的信息保存到用户数据目录，
让用户可以在 UI 中手动指定或自动探测，而不是写死在项目里。
存储位置：app.getPath("userData")/settings.json
*/
const fs = require("fs");
const path = require("path");
// 每种浏览器类型独立的 CDP URL，避免 Chrome 与 Edge 争用同一端口。
const DEFAULT_CDP_URLS = {
chrome: "http://127.0.0.1:9222",
edge: "http://127.0.0.1:9223",
};
const DEFAULT_SETTINGS = {
// 浏览器类型：chrome | edge
browserType: "chrome",
// 选中的浏览器可执行文件路径；留空表示按 browserType 自动探测
chromePath: "",
// 各浏览器类型对应的 CDP URL。优先使用该字段，
// 未设置时按 browserType 回退到 DEFAULT_CDP_URLS。
cdpUrls: {
chrome: DEFAULT_CDP_URLS.chrome,
edge: DEFAULT_CDP_URLS.edge,
},
// 兼容旧字段：保留当前所选类型的 CDP URL。
cdpUrl: DEFAULT_CDP_URLS.chrome,
autoStartChrome: true,
// 是否以无界面（headless）模式启动浏览器。默认 false，即有可见窗口。
headless: false,
focusCdpPage: true,
};
function getSettingsPath(app) {
const userDataDir = app.getPath("userData");
fs.mkdirSync(userDataDir, { recursive: true });
return path.join(userDataDir, "settings.json");
}
function normalizeBrowserType(value) {
const text = String(value || "")
.trim()
.toLowerCase();
if (text === "edge" || text === "msedge" || text === "microsoft-edge") {
return "edge";
}
return "chrome";
}
function normalizeBoolean(value, defaultValue) {
if (value === undefined || value === null) {
return defaultValue;
}
if (typeof value === "boolean") {
return value;
}
const text = String(value).trim().toLowerCase();
if (text === "true" || text === "1") {
return true;
}
if (text === "false" || text === "0") {
return false;
}
return defaultValue;
}
function normalizeCdpUrl(value, fallback) {
if (typeof value !== "string" || !value.trim()) {
return fallback;
}
const trimmed = value.trim();
try {
// 仅接受 http/https 协议，避免写入非法值。
const parsed = new URL(trimmed);
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
return fallback;
}
return trimmed;
} catch (error) {
return fallback;
}
}
/**
根据用户传入的原始 settings（未合并默认值）构造 cdpUrls。
若用户显式提供 cdpUrls，则逐字段合并到默认值之上。

否则若存在旧字段 cdpUrl，则把它视为当前所选浏览器类型的端口（迁移）。

其余情况使用默认端口。
*/
function buildCdpUrls(rawSettings, browserType) {
const raw = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
const providedUrls =
raw.cdpUrls && typeof raw.cdpUrls === "object" ? raw.cdpUrls : null;
const urls = {
chrome: DEFAULT_CDP_URLS.chrome,
edge: DEFAULT_CDP_URLS.edge,
};
if (providedUrls) {
urls.chrome = normalizeCdpUrl(providedUrls.chrome, DEFAULT_CDP_URLS.chrome);
urls.edge = normalizeCdpUrl(providedUrls.edge, DEFAULT_CDP_URLS.edge);
return urls;
}
// 旧字段迁移
const legacy = normalizeCdpUrl(raw.cdpUrl, "");
if (legacy) {
urls[browserType] = legacy;
}
return urls;
}

function normalizeSettings(settings) {
const raw = settings && typeof settings === "object" ? settings : {};
const browserType = normalizeBrowserType(raw.browserType);
const cdpUrls = buildCdpUrls(raw, browserType);
const merged = Object.assign({}, DEFAULT_SETTINGS, raw);
merged.browserType = browserType;
merged.cdpUrls = cdpUrls;
// cdpUrl 始终反映当前所选浏览器的端口，供旧代码读取。
merged.cdpUrl = cdpUrls[browserType];
merged.autoStartChrome = normalizeBoolean(raw.autoStartChrome, true);
merged.headless = normalizeBoolean(raw.headless, false);
merged.focusCdpPage = normalizeBoolean(raw.focusCdpPage, true);
merged.chromePath = typeof raw.chromePath === "string" ? raw.chromePath : "";
return merged;
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
const type = normalizeBrowserType(browserType);
const urls = settings && settings.cdpUrls ? settings.cdpUrls : {};
return normalizeCdpUrl(urls[type], DEFAULT_CDP_URLS[type]);
}
module.exports = {
DEFAULT_SETTINGS,
DEFAULT_CDP_URLS,
getSettingsPath,
readSettings,
writeSettings,
normalizeBrowserType,
normalizeSettings,
resolveCdpUrl,
};
