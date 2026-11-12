/**
独立浏览器引擎（playwright + CDP）

为什么不复用 provider 那条 CDP 连接：provider 那个浏览器里跑的是**模型自己**
（chatgpt.com / qwen 的页面）。插件要操作的是「另一块屏」——用户可以看着它跳转、
点击，模型也不会因为自己页面被点而断线。因此这里单独起一个实例、单独的
user-data-dir、单独的调试端口。

连接是懒建立的：第一次动作才启动浏览器，之后复用同一页；
插件重载 / 卸载时 dispose 负责断开并关掉「我们启动的那个」进程
（若连接的是用户自己开的浏览器，只断开、不杀进程）。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DEFAULT_PORT = 9333;
const READY_TIMEOUT_MS = 25000;

const state = {
    browser: null,
    context: null,
    page: null,
    launchedPid: null,
    port: null,
    profileDir: null,
};

const CANDIDATES = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function findExecutable(configured) {
    if (configured && fs.existsSync(configured)) {
        return configured;
    }
    for (const candidate of CANDIDATES) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return "";
}

/**
探测调试端口是不是真的能连。

只看 200 不够：浏览器刚启动时端口已经监听，但 DevTools 端点
还会短暂返回 404 / 空 body。所以顺带确认返回里带
`webSocketDebuggerUrl`，否则别的服务占了端口也会被当成 CDP。
*/
function pingCdp(port) {
    return new Promise((resolve) => {
        const request = http.get(
            { host: "127.0.0.1", port: port, path: "/json/version", timeout: 1500 },
            (response) => {
                if (response.statusCode !== 200) {
                    response.resume();
                    resolve(false);
                    return;
                }

                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => {
                    body += chunk;
                });
                response.on("end", () => {
                    resolve(body.indexOf("webSocketDebuggerUrl") !== -1);
                });
            }
        );
        request.on("timeout", () => {
            request.destroy();
            resolve(false);
        });
        request.on("error", () => resolve(false));
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
连 CDP，带重试。

playwright 的 connectOverCDP 会自己去请求 `/json/version/`，
浏览器刚起来那一刻这个路径可能还是 404 —— 单次连接会直接失败，
把"还在启动"误报成"没有调试端口"。
*/
async function connectCdp(chromium, port, attempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            return await chromium.connectOverCDP("http://127.0.0.1:" + port, {
                timeout: 15000,
            });
        } catch (error) {
            lastError = error;

            if (attempt < attempts) {
                // eslint-disable-next-line no-await-in-loop
                await sleep(600 * attempt);
            }
        }
    }

    throw lastError;
}

async function waitForCdp(port, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        // eslint-disable-next-line no-await-in-loop
        if (await pingCdp(port)) {
            return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(350);
    }
    return false;
}

function launch(options) {
    const port = options.port;
    const executable = findExecutable(options.executablePath);
    if (!executable) {
        throw new Error("找不到 Edge/Chrome，可执行文件路径请在插件配置 executablePath 里指定");
    }
    const profileDir = path.join(os.tmpdir(), "xml-agent-browser-profile-" + port);
    fs.mkdirSync(profileDir, { recursive: true });
    const child = spawn(
        executable,
        [
            "--remote-debugging-port=" + port,
            "--user-data-dir=" + profileDir,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=Translate",
            "about:blank",
        ],
        { stdio: "ignore", windowsHide: false, detached: false }
    );
    child.on("error", () => {});
    state.launchedPid = child.pid || null;
    state.profileDir = profileDir;
    return child;
}

async function ensurePage(options) {
    const port = Number(options.port) || DEFAULT_PORT;

    if (state.browser && state.page && state.port === port) {
        if (!state.page.isClosed()) {
            return state.page;
        }
        state.page = null;
    }

    // eslint-disable-next-line global-require
    const { chromium } = require("playwright");

    if (!(await pingCdp(port))) {
        launch({ port: port, executablePath: options.executablePath });
        const ready = await waitForCdp(port, READY_TIMEOUT_MS);
        if (!ready) {
            throw new Error("浏览器启动了但调试端口 " + port + " 没有响应");
        }
    }

    state.browser = await connectCdp(chromium, port);
    state.port = port;
    const contexts = state.browser.contexts();
    state.context = contexts.length > 0 ? contexts[0] : await state.browser.newContext();
    const pages = state.context.pages().filter((item) => !item.isClosed());
    state.page = pages.length > 0 ? pages[0] : await state.context.newPage();
    return state.page;
}

async function close(options) {
    const opts = options || {};
    try {
        if (state.browser) {
            await state.browser.close();
        }
    } catch (error) {
        // 连接可能已经断了
    }
    state.browser = null;
    state.context = null;
    state.page = null;
    state.port = null;

    if (opts.killLaunched !== false && state.launchedPid) {
        try {
            if (process.platform === "win32") {
                spawn("taskkill", ["/PID", String(state.launchedPid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                });
            } else {
                process.kill(state.launchedPid, "SIGKILL");
            }
        } catch (error) {
            // 进程可能已退出
        }
        state.launchedPid = null;
    }
}

function assertHttpUrl(raw) {
    let url;
    try {
        url = new URL(String(raw || "").trim());
    } catch (error) {
        throw new Error("url 不是合法地址：" + raw);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(
            "只允许 http/https，收到 " + url.protocol + "（file:// 与 javascript: 一律拒绝）"
        );
    }
    return url.toString();
}

function shorten(text, maxChars) {
    const value = String(text === undefined || text === null ? "" : text);
    const limit = Number(maxChars) || 4000;
    if (value.length <= limit) {
        return { text: value, truncated: false };
    }
    return { text: value.slice(0, limit), truncated: true };
}

async function pageInfo(page) {
    let title = "";
    try {
        title = await page.title();
    } catch (error) {
        title = "";
    }
    return { url: page.url(), title: title };
}

module.exports = {
    ensurePage,
    close,
    assertHttpUrl,
    shorten,
    pageInfo,
    findExecutable,
    state,
};
