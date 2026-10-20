
const path = require("path");
const fs = require("fs");
const net = require("net");
const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");
const {
findBrowser,
getPlatformCandidates,
normalizeBrowserType,
detectBrowserTypeFromPath,
} = require("./chrome-finder");
const { launchChromeWithCdp, checkCdpServer, getCdpVersionInfo } = require("./chrome-launcher");
const {
readSettings,
writeSettings,
getSettingsPath,
resolveCdpUrl,
DEFAULT_CDP_URLS,
} = require("./settings");
const HOST = "127.0.0.1";
const PORT_START = 3000;
const PORT_END = 3999;
let mainWindow = null;
let serverModule = null;
let serverInstance = null;
let currentPort = null;
let shuttingDown = false;
// 记录通过本应用启动的浏览器进程，便于切换浏览器时精确关闭旧的浏览器。
// { pid: number, browserType: "chrome"|"edge", cdpUrl: string } | null
let launchedBrowser = null;
function isPortFree(port) {
return new Promise((resolve) => {
const tester = net.createServer();
tester.once("error", () => resolve(false));
tester.once("listening", () => tester.close(() => resolve(true)));
tester.listen(port, HOST);
});
}
async function findFreePort(start = PORT_START, end = PORT_END) {
for (let port = start; port <= end; port += 1) {
// eslint-disable-next-line no-await-in-loop
const free = await isPortFree(port);
if (free) {
return port;
}
}
throw new Error("No free port found in range " + start + "-" + end);
}
function resolveServerModule() {
const candidates = [
path.join(__dirname, "..", "webui", "server.js"),
path.join(app.getAppPath(), "webui", "server.js"),
path.join(process.resourcesPath || "", "app", "webui", "server.js"),
];
for (const candidate of candidates) {
try {
// eslint-disable-next-line global-require
return require(candidate);
} catch (error) {
if (error && error.code === "MODULE_NOT_FOUND") {
continue;
}
throw error;
}
}
throw new Error("Unable to locate webui/server.js");
}
function startBackend(port) {
if (serverInstance) {
return Promise.resolve(serverInstance);
}
if (!serverModule) {
serverModule = resolveServerModule();
}
return new Promise((resolve, reject) => {
try {
const instance = serverModule.startServer({ port });
const onError = (error) => {
reject(error);
};
instance.once("error", onError);
const ready = () => {
instance.removeListener("error", onError);
serverInstance = instance;
resolve(instance);
};
if (instance.listening) {
ready();
return;
}
instance.once("listening", ready);
} catch (error) {
reject(error);
}
});
}
/**
用户数据目录：Chrome 与 Edge 分别使用独立 profile，避免两者互相覆盖登录态。
*/
function getBrowserUserDataDir(browserType) {
const type = normalizeBrowserType(browserType);
const folder = type === "edge" ? "edge-agent-profile" : "chrome-agent-profile";
return path.join(app.getPath("userData"), folder);
}
/**
解析浏览器可执行文件。
优先级：
用户在设置里指定的路径（且类型匹配时直接使用）
若指定路径与所选浏览器类型不匹配，则按类型重新自动探测
平台常见路径自动探测（allowCrossBrowser=true，保证能找到任一可用浏览器）
*/
function resolveBrowser(settings) {
const browserType = normalizeBrowserType(settings.browserType);
const explicitPath = (settings.chromePath || "").trim();
const candidates = getPlatformCandidates(browserType);
if (explicitPath) {
const explicitType = detectBrowserTypeFromPath(explicitPath);
// 用户显式指定的路径优先使用；当类型不一致时仍然使用用户路径，并回填类型。
return {
path: explicitPath,
browserType: explicitType,
requestedType: browserType,
candidates,
source: "explicit",
};
}
const found = findBrowser({
browserType,
allowCrossBrowser: true,
});
return {
path: found || "",
browserType: found ? detectBrowserTypeFromPath(found) : browserType,
requestedType: browserType,
candidates,
source: found ? "auto" : "none",
};
}
/**
优雅关闭一个由本应用启动的浏览器进程（及其子进程）。
Windows 下使用 taskkill /T /F 关闭整棵进程树，其它平台使用 kill。
*/
function killBrowserProcess(pid) {
if (!pid) {
return Promise.resolve();
}
return new Promise((resolve) => {
try {
const { spawn } = require("child_process");
if (process.platform === "win32") {
const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
stdio: "ignore",
windowsHide: true,
});
child.on("close", () => resolve());
child.on("error", () => resolve());
} else {
try {
process.kill(pid, "SIGTERM");
} catch (error) {
// ignore
}
resolve();
}
} catch (error) {
resolve();
}
});
}
/**
关闭当前记录的浏览器进程，并等待 CDP 端口释放。
*/
async function closeLaunchedBrowser() {
if (!launchedBrowser) {
return;
}
const { pid, cdpUrl } = launchedBrowser;
console.log("[Electron] Closing previous browser pid=" + pid + " cdp=" + cdpUrl);
await killBrowserProcess(pid);
launchedBrowser = null;
// 等待端口释放，最多 5 秒
const start = Date.now();
while (Date.now() - start < 5000) {
// eslint-disable-next-line no-await-in-loop
const running = await checkCdpServer(cdpUrl);
if (!running) {
return;
}
// eslint-disable-next-line no-await-in-loop
await new Promise((r) => setTimeout(r, 300));
}
}
/**
确保指定浏览器类型的 CDP 可用。
若已存在 CDP，先检查其浏览器类型是否与请求一致：
一致则直接复用；
不一致（例如用户从 Chrome 切换到 Edge）则关闭旧浏览器后启动新浏览器。
*/
async function ensureBrowserCdp(settings) {
const requestedType = normalizeBrowserType(settings.browserType);
const cdpUrl = resolveCdpUrl(settings, requestedType);
const already = await checkCdpServer(cdpUrl);
if (already) {
const version = await getCdpVersionInfo(cdpUrl);
const connectedType =
version.browserType !== "unknown" ? version.browserType : requestedType;
if (connectedType === requestedType) {
return {
ok: true,
browserType: connectedType,
cdpUrl,
message:
"CDP already running at " +
cdpUrl +
" (" +
(version.browser || "unknown") +
")",
};
}
// 端口上运行的是另一种浏览器：先关闭它，再启动请求的浏览器。
console.log(
"[Electron] CDP at " +
cdpUrl +
" is " +
connectedType +
" but " +
requestedType +
" requested. Restarting..."
);
if (launchedBrowser && launchedBrowser.cdpUrl === cdpUrl) {
await closeLaunchedBrowser();
} else {
// 该浏览器不是本进程启动的，无法安全关闭；提示用户。
return {
ok: false,
browserType: requestedType,
cdpUrl,
message:
"Port " +
cdpUrl +
" is in use by " +
connectedType +
". Close that browser manually or configure a separate CDP URL for " +
(requestedType === "edge" ? "Edge" : "Chrome") +
".",
};
}
}
if (!settings.autoStartChrome) {
return {
ok: false,
browserType: requestedType,
cdpUrl,
message:
"CDP not running at " +
cdpUrl +
" and autoStartChrome is disabled. Please start the browser manually with --remote-debugging-port.",
};
}
const resolved = resolveBrowser(settings);
const browserPath = resolved.path;
if (!browserPath) {
const typeLabel = requestedType === "edge" ? "Edge" : "Chrome";
return {
ok: false,
browserType: requestedType,
cdpUrl,
message:
typeLabel +
" executable not found. Please install " +
typeLabel +
" or set the browser path in Settings.\nCandidates:\n" +
resolved.candidates.join("\n"),
};
}
const userDataDir = getBrowserUserDataDir(resolved.browserType);
fs.mkdirSync(userDataDir, { recursive: true });
const result = await launchChromeWithCdp({
chromePath: browserPath,
cdpUrl,
userDataDir,
browserType: resolved.browserType,
headless: settings.headless === true,
startTimeout: 30000,
retryInterval: 500,
});
if (result.started) {
launchedBrowser = {
pid: result.pid,
browserType: resolved.browserType,
cdpUrl,
};
return {
ok: true,
browserType: resolved.browserType,
cdpUrl,
message:
"Started " +
(resolved.browserType === "edge" ? "Edge" : "Chrome") +
": " +
browserPath,
};
}
// 即使启动失败，如果之后能连上 CDP 也视为成功
const retry = await checkCdpServer(cdpUrl);
if (retry) {
const version = await getCdpVersionInfo(cdpUrl);
return {
ok: true,
browserType:
version.browserType !== "unknown" ? version.browserType : resolved.browserType,
cdpUrl,
message: "CDP available after start attempt",
};
}
return {
ok: false,
browserType: resolved.browserType,
cdpUrl,
message:
"Failed to start " +
(resolved.browserType === "edge" ? "Edge" : "Chrome") +
": " +
result.reason,
};
}
function writePortFile(port) {
try {
const userDataDir = app.getPath("userData");
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, "xml-agent-port.txt"), String(port), "utf8");
} catch (error) {
console.warn("[Electron] Failed to write port file:", error.message);
}
}
/**
把用户配置同步到环境变量，让 provider 侧（browser-agent.js）也能读到。
需要在启动内置服务之前调用，因为 agent 会在服务进程中读取这些 env。
*/
function applySettingsToEnv(settings) {
const browserType = normalizeBrowserType(settings.browserType);
// 把浏览器类型同步给 provider 层，用于日志与默认路径选择。
process.env.BROWSER_TYPE = browserType;
process.env.XML_AGENT_BROWSER_TYPE = browserType;
// 明确写入或清空 chromePath，避免切换浏览器后仍残留上一次的路径。
if (settings.chromePath) {
if (browserType === "edge") {
process.env.BROWSER_EDGE_PATH = settings.chromePath;
process.env.EDGE_PATH = settings.chromePath;
delete process.env.BROWSER_CHROME_PATH;
delete process.env.CHROME_PATH;
} else {
process.env.BROWSER_CHROME_PATH = settings.chromePath;
process.env.CHROME_PATH = settings.chromePath;
delete process.env.BROWSER_EDGE_PATH;
delete process.env.EDGE_PATH;
}
} else {
delete process.env.BROWSER_CHROME_PATH;
delete process.env.CHROME_PATH;
delete process.env.BROWSER_EDGE_PATH;
delete process.env.EDGE_PATH;
}
// 按所选浏览器类型解析独立端口，确保 Chrome/Edge 不共用端口。
const cdpUrl = resolveCdpUrl(settings, browserType);
process.env.BROWSER_CDP_URL = cdpUrl;
process.env.XML_AGENT_CDP_URL = cdpUrl;
process.env.BROWSER_AUTO_START = settings.autoStartChrome === false ? "false" : "true";
// 无界面模式开关
process.env.BROWSER_HEADLESS = settings.headless === true ? "true" : "false";
// 焦点跳转开关：true = 激活 CDP 页面标签（bringToFront），false = 不抢焦点
process.env.BROWSER_FOCUS_CDP_PAGE = settings.focusCdpPage === false ? "false" : "true";
}
/**
读取指定浏览器的 CDP 状态。
*/
async function getBrowserStatus(settings) {
const requestedType = normalizeBrowserType(settings.browserType);
const cdpUrl = resolveCdpUrl(settings, requestedType);
const running = await checkCdpServer(cdpUrl);
let connectedBrowserType = "unknown";
let connectedBrowser = "";
if (running) {
const version = await getCdpVersionInfo(cdpUrl);
connectedBrowserType = version.browserType;
connectedBrowser = version.browser;
}
const resolved = resolveBrowser(settings);
return {
browserType: requestedType,
headless: settings.headless === true,
cdpUrl,
cdpRunning: running,
connectedBrowserType,
connectedBrowser,
browserPath: resolved.path || "",
chromePath: resolved.path || "",
autoStartChrome: settings.autoStartChrome !== false,
focusCdpPage: settings.focusCdpPage !== false,
typeMatches: running ? connectedBrowserType === requestedType : false,
};
}
function registerIpcHandlers() {
ipcMain.handle("settings:read", () => {
return readSettings(app);
});
ipcMain.handle("settings:write", (event, next) => {
const saved = writeSettings(app, next);
// 保存后立即同步到 env，使后续启动的 agent session 使用新配置
applySettingsToEnv(saved);
return saved;
});
ipcMain.handle("settings:path", () => {
return getSettingsPath(app);
});
ipcMain.handle("browser:detect", (event, browserType) => {
const settings = readSettings(app);
const requestedType = normalizeBrowserType(
browserType !== undefined && browserType !== null ? browserType : settings.browserType
);
const candidates = getPlatformCandidates(requestedType);
const found = findBrowser({
browserType: requestedType,
allowCrossBrowser: false,
});
return {
browserType: requestedType,
found: found || "",
candidates,
};
});
// 兼容旧的 chrome:detect 名称：默认返回当前所选浏览器类型的结果。
ipcMain.handle("chrome:detect", () => {
const settings = readSettings(app);
const browserType = normalizeBrowserType(settings.browserType);
return {
browserType,
found: findBrowser({ browserType, allowCrossBrowser: false }) || "",
candidates: getPlatformCandidates(browserType),
candidatesAll: getPlatformCandidates(browserType),
};
});
ipcMain.handle("browser:launch", async () => {
const settings = readSettings(app);
return ensureBrowserCdp(settings);
});
ipcMain.handle("chrome:launch", async () => {
const settings = readSettings(app);
return ensureBrowserCdp(settings);
});
/**
切换浏览器：当用户从 Chrome 切到 Edge（或反之）时，
关闭旧的浏览器进程并在独立端口上启动新的浏览器。
*/
ipcMain.handle("browser:switch", async (event, browserType) => {
const settings = readSettings(app);
const targetType = normalizeBrowserType(
browserType !== undefined && browserType !== null ? browserType : settings.browserType
);
const nextSettings = Object.assign({}, settings, { browserType: targetType });
// 先关闭本应用启动的旧浏览器（若存在），确保旧 CDP 端口释放
if (launchedBrowser) {
await closeLaunchedBrowser();
}
applySettingsToEnv(nextSettings);
return ensureBrowserCdp(nextSettings);
});
ipcMain.handle("browser:status", async () => {
const settings = readSettings(app);
return getBrowserStatus(settings);
});
ipcMain.handle("chrome:status", async () => {
const settings = readSettings(app);
return getBrowserStatus(settings);
});
ipcMain.handle("app:port", () => currentPort);
ipcMain.handle("dialog:pickBrowser", async () => {
const result = await dialog.showOpenDialog(mainWindow, {
title: "Select browser executable",
properties: ["openFile"],
filters:
process.platform === "win32"
? [{ name: "Browser", extensions: ["exe"] }]
: [{ name: "All files", extensions: ["*"] }],
});
if (result.canceled || !result.filePaths || !result.filePaths.length) {
return "";
}
return result.filePaths[0];
});
ipcMain.handle("dialog:pickChrome", async () => {
const result = await dialog.showOpenDialog(mainWindow, {
title: "Select Chrome / Edge executable",
properties: ["openFile"],
filters:
process.platform === "win32"
? [{ name: "Browser", extensions: ["exe"] }]
: [{ name: "All files", extensions: ["*"] }],
});
if (result.canceled || !result.filePaths || !result.filePaths.length) {
return "";
}
return result.filePaths[0];
});
}
function createWindow(appUrl) {
mainWindow = new BrowserWindow({
width: 1280,
height: 860,
minWidth: 940,
minHeight: 640,
backgroundColor: "#0b1016",
title: "XML Agent",
autoHideMenuBar: true,
webPreferences: {
contextIsolation: true,
nodeIntegration: false,
sandbox: true,
preload: path.join(__dirname, "preload.js"),
additionalArguments: ["--xml-agent-port=" + String(currentPort || "")],
},
});
mainWindow.on("closed", () => {
mainWindow = null;
});
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
if (url.startsWith(appUrl)) {
return { action: "allow" };
}
shell.openExternal(url).catch(() => {});
return { action: "deny" };
});
return mainWindow;
}
async function loadApp(window, appUrl) {
try {
await window.loadURL(appUrl);
} catch (error) {
const message = [
"无法加载 XML Agent 界面。",
"",
"地址: " + appUrl,
"错误: " + (error && error.message ? error.message : String(error)),
].join("\n");
dialog.showErrorBox("XML Agent 启动失败", message);
}
}
async function bootstrap() {
let port;
try {
port = await findFreePort();
} catch (error) {
dialog.showErrorBox(
"XML Agent 启动失败",
"无法找到可用端口。\n\n" + (error && error.message ? error.message : String(error))
);
app.quit();
return;
}
currentPort = port;
process.env.PORT = String(port);
process.env.XML_AGENT_PORT = String(port);
writePortFile(port);
// 把用户配置同步到环境变量，让 provider 侧（browser-agent.js）也能读到
const settings = readSettings(app);
applySettingsToEnv(settings);
try {
await startBackend(port);
} catch (error) {
dialog.showErrorBox(
"XML Agent 启动失败",
[
"无法启动内置服务。",
"",
"端口: " + port,
"错误: " + (error && error.message ? error.message : String(error)),
].join("\n")
);
app.quit();
return;
}
const appUrl = "http://" + HOST + ":" + port + "/xml_agent_web";
console.log("[Electron] XML Agent is running at " + appUrl);
console.log("[Electron] Settings file: " + getSettingsPath(app));
// 尝试自动准备浏览器 CDP（不阻塞界面）
ensureBrowserCdp(settings)
.then((result) => {
console.log("[Electron] Browser CDP: " + result.message);
})
.catch((error) => {
console.warn("[Electron] Browser CDP setup failed:", error.message);
});
const window = createWindow(appUrl);
await loadApp(window, appUrl);
}
async function shutdown() {
if (shuttingDown) {
return;
}
shuttingDown = true;
if (serverModule && typeof serverModule.shutdown === "function") {
try {
await serverModule.shutdown();
} catch (error) {
console.error("[Electron] Shutdown error:", error.message);
}
}
serverInstance = null;
}
app.on("window-all-closed", () => {
if (process.platform !== "darwin") {
app.quit();
}
});
app.on("before-quit", (event) => {
if (shuttingDown) {
return;
}
event.preventDefault();
shutdown()
.catch(() => {})
.then(() => {
app.exit(0);
});
});
app.on("activate", () => {
if (BrowserWindow.getAllWindows().length === 0) {
bootstrap().catch(() => {});
}
});
if (!app.requestSingleInstanceLock()) {
app.quit();
} else {
app.on("second-instance", () => {
if (!mainWindow) {
return;
}
if (mainWindow.isMinimized()) {
mainWindow.restore();
}
mainWindow.focus();
});
app.whenReady().then(() => {
registerIpcHandlers();
return bootstrap();
});
}
