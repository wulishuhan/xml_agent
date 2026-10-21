/**
Web 版（非 Electron）浏览器设置与 CDP 管理。
与 electron/settings.js 目标类似，但不依赖 Electron，配置保存在用户主目录：
~/.xml-agent/webui-browser.json
支持：
读写浏览器配置（browserType: chrome|edge, chromePath, cdpUrls）

探测本机 Chrome / Edge 可执行文件

启动带 CDP 的浏览器（独立端口：Chrome 9222 / Edge 9223）

切换浏览器：关闭本模块启动的旧浏览器进程，再启动目标浏览器

注意：纯 Node 环境下关闭其它浏览器进程需谨慎，这里只关闭"由本模块启动并记录了 pid"的进程。
*/
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");
const {
    findBrowser,
    getPlatformCandidates,
    normalizeBrowserType,
    detectBrowserTypeFromPath,
} = require("../electron/chrome-finder");
const {
    launchChromeWithCdp,
    checkCdpServer,
    getCdpVersionInfo,
} = require("../electron/chrome-launcher");
const DEFAULT_CDP_URLS = {
    chrome: "http://127.0.0.1:9222",
    edge: "http://127.0.0.1:9223",
};
function getStoreDir() {
    return path.join(os.homedir(), ".xml-agent");
}
function getSettingsPath() {
    return path.join(getStoreDir(), "webui-browser.json");
}
function getProfileDir(browserType) {
    const type = normalizeBrowserType(browserType);
    return path.join(
        getStoreDir(),
        type === "edge" ? "edge-agent-profile" : "chrome-agent-profile"
    );
}
function normalizeCdpUrl(value, fallback) {
    if (typeof value !== "string" || !value.trim()) {
        return fallback;
    }
    const trimmed = value.trim();
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return fallback;
        }
        return trimmed;
    } catch (error) {
        return fallback;
    }
}
function normalizeBoolean(value, defaultValue) {
    if (value === undefined || value === null) {
        return defaultValue;
    }
    if (typeof value === "boolean") {
        return value;
    }
    const text = String(value).trim().toLowerCase();
    if (text === "true" || text === "1") return true;
    if (text === "false" || text === "0") return false;
    return defaultValue;
}
function buildCdpUrls(raw, browserType) {
    const source = raw && typeof raw === "object" ? raw : {};
    const provided = source.cdpUrls && typeof source.cdpUrls === "object" ? source.cdpUrls : null;
    const urls = {
        chrome: DEFAULT_CDP_URLS.chrome,
        edge: DEFAULT_CDP_URLS.edge,
    };
    if (provided) {
        urls.chrome = normalizeCdpUrl(provided.chrome, DEFAULT_CDP_URLS.chrome);
        urls.edge = normalizeCdpUrl(provided.edge, DEFAULT_CDP_URLS.edge);
        return urls;
    }
    const legacy = normalizeCdpUrl(source.cdpUrl, "");
    if (legacy) {
        urls[browserType] = legacy;
    }
    return urls;
}
function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const browserType = normalizeBrowserType(source.browserType);
    const cdpUrls = buildCdpUrls(source, browserType);
    return {
        browserType,
        chromePath: typeof source.chromePath === "string" ? source.chromePath : "",
        cdpUrls,
        cdpUrl: cdpUrls[browserType],
        autoStartChrome: normalizeBoolean(source.autoStartChrome, true),
        headless: normalizeBoolean(source.headless, false),
    };
}
function readSettings() {
    try {
        if (!fs.existsSync(getSettingsPath())) {
            return normalizeSettings({});
        }
        const raw = fs.readFileSync(getSettingsPath(), "utf8");
        return normalizeSettings(JSON.parse(raw));
    } catch (error) {
        return normalizeSettings({});
    }
}
function writeSettings(next) {
    const merged = normalizeSettings(next);
    const dir = getStoreDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = getSettingsPath();
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
    applyToRuntime(merged);
    return merged;
}
function resolveCdpUrl(settings, browserType) {
    const type = normalizeBrowserType(browserType);
    const urls = settings && settings.cdpUrls ? settings.cdpUrls : {};
    return normalizeCdpUrl(urls[type], DEFAULT_CDP_URLS[type]);
}
function resolveBrowser(settings) {
    const browserType = normalizeBrowserType(settings.browserType);
    const explicitPath = (settings.chromePath || "").trim();
    if (explicitPath) {
        return {
            path: explicitPath,
            browserType: detectBrowserTypeFromPath(explicitPath),
        };
    }
    const found = findBrowser({ browserType, allowCrossBrowser: true });
    return {
        path: found || "",
        browserType: found ? detectBrowserTypeFromPath(found) : browserType,
    };
}
// 记录本模块启动的浏览器进程
let launchedBrowser = null;
function killBrowserProcess(pid) {
    if (!pid) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        try {
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
async function closeLaunchedBrowser() {
    if (!launchedBrowser) {
        return;
    }
    const { pid, cdpUrl } = launchedBrowser;
    await killBrowserProcess(pid);
    launchedBrowser = null;
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
        // 端口上运行的是另一种浏览器
        if (launchedBrowser && launchedBrowser.cdpUrl === cdpUrl) {
            await closeLaunchedBrowser();
        } else {
            return {
                ok: false,
                browserType: requestedType,
                cdpUrl,
                message:
                    "Port " +
                    cdpUrl +
                    " is in use by " +
                    connectedType +
                    ". Close that browser or configure a separate CDP URL for " +
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
                " and autoStartChrome is disabled. Start the browser manually with --remote-debugging-port.",
        };
    }
    const resolved = resolveBrowser(settings);
    if (!resolved.path) {
        const label = requestedType === "edge" ? "Edge" : "Chrome";
        return {
            ok: false,
            browserType: requestedType,
            cdpUrl,
            message:
                label +
                " executable not found. Install " +
                label +
                " or set the browser path in Settings.\nCandidates:\n" +
                getPlatformCandidates(requestedType).join("\n"),
        };
    }
    const userDataDir = getProfileDir(resolved.browserType);
    fs.mkdirSync(userDataDir, { recursive: true });
    const result = await launchChromeWithCdp({
        chromePath: resolved.path,
        cdpUrl,
        userDataDir,
        browserType: resolved.browserType,
        headless: settings.headless === true,
        startTimeout: 30000,
        retryInterval: 500,
    });
    if (result.started) {
        launchedBrowser = { pid: result.pid, browserType: resolved.browserType, cdpUrl };
        return {
            ok: true,
            browserType: resolved.browserType,
            cdpUrl,
            message:
                "Started " +
                (resolved.browserType === "edge" ? "Edge" : "Chrome") +
                ": " +
                resolved.path,
        };
    }
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
async function switchBrowser(browserType) {
    const settings = readSettings();
    const targetType = normalizeBrowserType(browserType || settings.browserType);
    const nextSettings = Object.assign({}, settings, { browserType: targetType });
    if (launchedBrowser) {
        await closeLaunchedBrowser();
    }
    const saved = writeSettings(nextSettings);
    const result = await ensureBrowserCdp(saved);
    return Object.assign({ settings: saved }, result);
}
async function getStatus() {
    const settings = readSettings();
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
        autoStartChrome: settings.autoStartChrome !== false,
        typeMatches: running ? connectedBrowserType === requestedType : false,
    };
}
function detect(browserType) {
    const type = normalizeBrowserType(browserType);
    const found = findBrowser({ browserType: type, allowCrossBrowser: false });
    return {
        browserType: type,
        found: found || "",
        candidates: getPlatformCandidates(type),
    };
}
/**
把浏览器设置同步到运行时的环境变量与 agentConfig，
使 Agent 会话真正使用所选浏览器（Web 版切换后必须调用）。
*/
function applyToRuntime(settings) {
    const s = normalizeSettings(settings);
    const browserType = normalizeBrowserType(s.browserType);
    const cdpUrl = resolveCdpUrl(s, browserType);
    process.env.BROWSER_TYPE = browserType;
    process.env.XML_AGENT_BROWSER_TYPE = browserType;
    process.env.BROWSER_CDP_URL = cdpUrl;
    process.env.XML_AGENT_CDP_URL = cdpUrl;
    process.env.BROWSER_AUTO_START = s.autoStartChrome === false ? "false" : "true";
    process.env.BROWSER_HEADLESS = s.headless === true ? "true" : "false";
    if (s.chromePath) {
        if (browserType === "edge") {
            process.env.BROWSER_EDGE_PATH = s.chromePath;
            process.env.EDGE_PATH = s.chromePath;
            delete process.env.BROWSER_CHROME_PATH;
            delete process.env.CHROME_PATH;
        } else {
            process.env.BROWSER_CHROME_PATH = s.chromePath;
            process.env.CHROME_PATH = s.chromePath;
            delete process.env.BROWSER_EDGE_PATH;
            delete process.env.EDGE_PATH;
        }
    } else {
        delete process.env.BROWSER_CHROME_PATH;
        delete process.env.CHROME_PATH;
        delete process.env.BROWSER_EDGE_PATH;
        delete process.env.EDGE_PATH;
    }
    // 同步到已加载的 agentConfig（单例），使新建的 Agent 会话立即生效
    try {
        // eslint-disable-next-line global-require
        const agentConfig = require("../config/agent-config");
        if (agentConfig && agentConfig.browser) {
            agentConfig.browser.browserType = browserType;
            agentConfig.browser.cdpUrl = cdpUrl;
            if (browserType === "edge") {
                agentConfig.browser.edgePath = s.chromePath || "";
                agentConfig.browser.chromePath = "";
            } else {
                agentConfig.browser.chromePath = s.chromePath || "";
                agentConfig.browser.edgePath = "";
            }
            agentConfig.browser.autoStart = s.autoStartChrome !== false;
        }
    } catch (error) {
        // agentConfig 不存在时忽略
    }
    return s;
}
module.exports = {
    DEFAULT_CDP_URLS,
    getSettingsPath,
    readSettings,
    writeSettings,
    resolveCdpUrl,
    applyToRuntime,
    detect,
    getStatus,
    ensureBrowserCdp,
    switchBrowser,
};
