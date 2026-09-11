/**

启动带 CDP 的 Chrome。

与 providers/browser-agent.js 中的 startChromeCdpServer 逻辑类似，

但这里是 Electron 主进程侧的入口，便于在打包后的应用中：

使用用户配置的 chromePath

使用用户数据目录（而非系统临时目录），确保登录状态持久保留

在启动前做端口占用检查
*/

const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const CDP_HOST = "127.0.0.1";

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

启动 Chrome CDP。若已在运行则直接返回 true。

@param {Object} options

@param {string} options.chromePath Chrome 可执行文件绝对路径

@param {string} options.cdpUrl 例如 http://127.0.0.1:9222

@param {string} options.userDataDir 用户数据目录（用于持久化登录）

@param {number} [options.startTimeout] 等待 CDP 就绪的时间

@param {number} [options.retryInterval]

@returns {Promise<{ started: boolean, pid: number|null, reason: string }>}
*/
async function launchChromeWithCdp(options) {
    const cdpUrl = options.cdpUrl || "http://127.0.0.1:9222";
    const chromePath = options.chromePath;
    const userDataDir = options.userDataDir;
    const startTimeout = options.startTimeout || 30000;
    const retryInterval = options.retryInterval || 500;

    if (!chromePath) {
        return { started: false, pid: null, reason: "chromePath is empty" };
    }

    if (!fs.existsSync(chromePath)) {
        return { started: false, pid: null, reason: "chromePath does not exist: " + chromePath };
    }

    const alreadyRunning = await checkCdpServer(cdpUrl);

    if (alreadyRunning) {
        return { started: false, pid: null, reason: "CDP already running at " + cdpUrl };
    }

    let url;

    try {
        url = new URL(cdpUrl);
    } catch (error) {
        return { started: false, pid: null, reason: "invalid cdpUrl: " + cdpUrl };
    }

    const port = parseInt(url.port, 10) || 9222;

    if (await isPortListening(port)) {
        return {
            started: false,
            pid: null,
            reason: "port " + port + " is already in use by another process",
        };
    }

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
    ];

    let child;

    try {
        child = spawn(chromePath, args, {
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
            windowsHide: true,
        });

        child.unref();
    } catch (error) {
        return { started: false, pid: null, reason: "spawn failed: " + error.message };
    }

    const startedAt = Date.now();

    while (Date.now() - startedAt < startTimeout) {
        // eslint-disable-next-line no-await-in-loop
        const ready = await checkCdpServer(cdpUrl);

        if (ready) {
            return { started: true, pid: child.pid, reason: "CDP ready at " + cdpUrl };
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }

    return {
        started: false,
        pid: child.pid,
        reason: "CDP did not become ready within " + startTimeout + "ms",
    };
}

module.exports = {
    checkCdpServer,
    launchChromeWithCdp,
    isPortListening,
};
