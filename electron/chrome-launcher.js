/**
启动带 CDP 的 Chrome / Edge。
与 providers/browser-agent.js 中的 startChromeCdpServer 逻辑类似，
但这里是 Electron 主进程侧的入口，便于在打包后的应用中：
使用用户配置的浏览器路径
使用用户数据目录（而非系统临时目录），确保登录状态持久保留
在启动前做端口占用检查
支持 Microsoft Edge（基于 Chromium，同样实现 CDP 协议）。
*/
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const CDP_HOST = "127.0.0.1";
// 用于从 /json/version 的 Browser 字段识别浏览器类型。
const EDGE_BROWSER_PATTERN = new RegExp("Edg/", "i");
const EDGE_WORD_PATTERN = new RegExp("Edge", "i");
const CHROME_BROWSER_PATTERN = new RegExp("Chrome", "i");
const CHROMIUM_BROWSER_PATTERN = new RegExp("Chromium", "i");
function isPortListening(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: CDP_HOST, port }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
        socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(false);
        });
    });
}
function checkCdpServer(cdpUrl) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(cdpUrl);
        } catch (error) {
            resolve(false);
            return;
        }
        const host = url.hostname || CDP_HOST;
        const port = parseInt(url.port, 10) || 9222;
        const healthUrl = "http://" + host + ":" + port + "/json/version";
        const request = http.get(healthUrl, { timeout: 3000 }, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on("timeout", () => {
            request.destroy();
            resolve(false);
        });
        request.on("error", () => resolve(false));
    });
}
/**
读取 CDP 端点信息，确认连接的是 Chrome 还是 Edge（/json/version 返回 Browser 字段）。
@returns {Promise<{ ok: boolean, browser: string, browserType: "chrome"|"edge"|"unknown" }>}
*/
function getCdpVersionInfo(cdpUrl) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(cdpUrl);
        } catch (error) {
            resolve({ ok: false, browser: "", browserType: "unknown" });
            return;
        }
        const host = url.hostname || CDP_HOST;
        const port = parseInt(url.port, 10) || 9222;
        const healthUrl = "http://" + host + ":" + port + "/json/version";
        const request = http.get(healthUrl, { timeout: 3000 }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                if (response.statusCode !== 200) {
                    resolve({ ok: false, browser: "", browserType: "unknown" });
                    return;
                }
                let browser = "";
                try {
                    const parsed = JSON.parse(body);
                    browser = parsed.Browser || "";
                } catch (error) {
                    browser = "";
                }
                let browserType = "unknown";
                if (EDGE_BROWSER_PATTERN.test(browser) || EDGE_WORD_PATTERN.test(browser)) {
                    browserType = "edge";
                } else if (
                    CHROME_BROWSER_PATTERN.test(browser) ||
                    CHROMIUM_BROWSER_PATTERN.test(browser)
                ) {
                    browserType = "chrome";
                }
                resolve({ ok: true, browser, browserType });
            });
        });
        request.on("timeout", () => {
            request.destroy();
            resolve({ ok: false, browser: "", browserType: "unknown" });
        });
        request.on("error", () => resolve({ ok: false, browser: "", browserType: "unknown" }));
    });
}
/**
构造启动参数。Chrome 与 Edge 均基于 Chromium。
注意：不要加 --no-startup-window，否则浏览器只在后台运行、不显示任何窗口，
用户会以为浏览器没有启动。这里默认以有界面模式启动，并附加 about:blank
确保一定存在一个可见窗口。
@param {Object} options
@param {number} options.port
@param {string} options.userDataDir
@param {"chrome"|"edge"} [options.browserType]
@param {boolean} [options.headless] 是否无界面模式（默认 false）
*/
function buildLaunchArgs(options) {
    const port = options.port;
    const userDataDir = options.userDataDir;
    const browserType = options.browserType === "edge" ? "edge" : "chrome";
    const headless = options.headless === true;
    const args = [
        "--remote-debugging-port=" + port,
        "--user-data-dir=" + userDataDir,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-component-update",
        "--disable-client-side-phishing-detection",
        "--disable-crash-reporter",
        "--disable-breakpad",
        // 确保有可见窗口
        "about:blank",
    ];
    if (browserType === "edge") {
        // 禁用 Edge 首次启动的导入/推荐等会干扰自动化的特性，但保留可见窗口。
        args.push("--disable-features=msEdgeSidebarV2,msEdgeIdentityFeatures,EdgeCollections");
        args.push("--disable-edge-shopping");
    }
    if (headless) {
        args.push("--headless=new");
        args.push("--disable-gpu");
    }
    return args;
}
/**
启动浏览器 CDP。若已在运行则直接返回 true。
@param {Object} options
@param {string} options.chromePath 浏览器可执行文件绝对路径
@param {string} options.cdpUrl 例如 http://127.0.0.1:9222
@param {string} options.userDataDir 用户数据目录（用于持久化登录）
@param {"chrome"|"edge"} [options.browserType]
@param {boolean} [options.headless]
@param {number} [options.startTimeout] 等待 CDP 就绪的时间
@param {number} [options.retryInterval]
@returns {Promise<{ started: boolean, pid: number|null, reason: string, browserType: string }>}
*/
async function launchChromeWithCdp(options) {
    const cdpUrl = options.cdpUrl || "http://127.0.0.1:9222";
    const chromePath = options.chromePath;
    const userDataDir = options.userDataDir;
    const browserType = options.browserType === "edge" ? "edge" : "chrome";
    const headless = options.headless === true;
    const startTimeout = options.startTimeout || 30000;
    const retryInterval = options.retryInterval || 500;
    if (!chromePath) {
        return {
            started: false,
            pid: null,
            reason: "browserPath is empty",
            browserType,
        };
    }
    if (!fs.existsSync(chromePath)) {
        return {
            started: false,
            pid: null,
            reason: "browserPath does not exist: " + chromePath,
            browserType,
        };
    }
    const alreadyRunning = await checkCdpServer(cdpUrl);
    if (alreadyRunning) {
        return {
            started: false,
            pid: null,
            reason: "CDP already running at " + cdpUrl,
            browserType,
        };
    }
    let url;
    try {
        url = new URL(cdpUrl);
    } catch (error) {
        return {
            started: false,
            pid: null,
            reason: "invalid cdpUrl: " + cdpUrl,
            browserType,
        };
    }
    const port = parseInt(url.port, 10) || 9222;
    if (await isPortListening(port)) {
        return {
            started: false,
            pid: null,
            reason: "port " + port + " is already in use by another process",
            browserType,
        };
    }
    const args = buildLaunchArgs({ port, userDataDir, browserType, headless });
    let child;
    try {
        child = spawn(chromePath, args, {
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
            // 有界面模式必须让窗口可见
            windowsHide: headless,
        });
        child.unref();
    } catch (error) {
        return {
            started: false,
            pid: null,
            reason: "spawn failed: " + error.message,
            browserType,
        };
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < startTimeout) {
        // eslint-disable-next-line no-await-in-loop
        const ready = await checkCdpServer(cdpUrl);
        if (ready) {
            return {
                started: true,
                pid: child.pid,
                reason: "CDP ready at " + cdpUrl,
                browserType,
            };
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }
    return {
        started: false,
        pid: child.pid,
        reason: "CDP did not become ready within " + startTimeout + "ms",
        browserType,
    };
}
module.exports = {
    checkCdpServer,
    getCdpVersionInfo,
    buildLaunchArgs,
    launchChromeWithCdp,
    isPortListening,
};
