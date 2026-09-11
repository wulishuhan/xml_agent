const path = require("path");
const fs = require("fs");
const net = require("net");
const os = require("os");
const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");

const { findChrome, getPlatformCandidates } = require("./chrome-finder");
const { launchChromeWithCdp, checkCdpServer } = require("./chrome-launcher");
const { readSettings, writeSettings, getSettingsPath } = require("./settings");

const HOST = "127.0.0.1";
const PORT_START = 3000;
const PORT_END = 3999;

let mainWindow = null;
let serverModule = null;
let serverInstance = null;
let currentPort = null;
let shuttingDown = false;
let chromeProcessPid = null;

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

function getChromeUserDataDir() {
    return path.join(app.getPath("userData"), "chrome-agent-profile");
}

function resolveChromePath(settings) {
    // 1. 用户在设置里指定的路径
    // 2. 环境变量
    // 3. 平台常见路径自动探测
    return findChrome({
        explicitPath: settings.chromePath,
        configPath: "",
    });
}

async function ensureChromeCdp(settings) {
    const cdpUrl = settings.cdpUrl || "http://127.0.0.1:9222";

    const already = await checkCdpServer(cdpUrl);

    if (already) {
        return { ok: true, message: "CDP already running at " + cdpUrl };
    }

    if (!settings.autoStartChrome) {
        return {
            ok: false,
            message:
                "CDP not running at " +
                cdpUrl +
                " and autoStartChrome is disabled. Please start Chrome manually with --remote-debugging-port.",
        };
    }

    const chromePath = resolveChromePath(settings);

    if (!chromePath) {
        return {
            ok: false,
            message:
                "Chrome executable not found. Please install Chrome or set chromePath in Settings.\nCandidates:\n" +
                getPlatformCandidates().join("\n"),
        };
    }

    const userDataDir = getChromeUserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });

    const result = await launchChromeWithCdp({
        chromePath,
        cdpUrl,
        userDataDir,
        startTimeout: 30000,
        retryInterval: 500,
    });

    if (result.started) {
        chromeProcessPid = result.pid;
        return { ok: true, message: "Started Chrome: " + chromePath };
    }

    // 即使启动失败，如果之后能连上 CDP 也视为成功
    const retry = await checkCdpServer(cdpUrl);

    if (retry) {
        return { ok: true, message: "CDP available after start attempt" };
    }

    return { ok: false, message: "Failed to start Chrome: " + result.reason };
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

function registerIpcHandlers() {
    ipcMain.handle("settings:read", () => {
        return readSettings(app);
    });

    ipcMain.handle("settings:write", (event, next) => {
        return writeSettings(app, next);
    });

    ipcMain.handle("settings:path", () => {
        return getSettingsPath(app);
    });

    ipcMain.handle("chrome:detect", () => {
        const settings = readSettings(app);
        const candidates = getPlatformCandidates();
        const found = findChrome({
            explicitPath: settings.chromePath,
            configPath: "",
        });

        return { found, candidates };
    });

    ipcMain.handle("chrome:launch", async () => {
        const settings = readSettings(app);
        const result = await ensureChromeCdp(settings);
        return result;
    });

    ipcMain.handle("chrome:status", async () => {
        const settings = readSettings(app);
        const cdpUrl = settings.cdpUrl || "http://127.0.0.1:9222";
        const running = await checkCdpServer(cdpUrl);
        const chromePath = resolveChromePath(settings);

        return {
            cdpUrl,
            cdpRunning: running,
            chromePath: chromePath || "",
            autoStartChrome: settings.autoStartChrome !== false,
        };
    });

    ipcMain.handle("app:port", () => currentPort);

    ipcMain.handle("dialog:pickChrome", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Select Chrome executable",
            properties: ["openFile"],
            filters:
                process.platform === "win32"
                    ? [{ name: "Chrome", extensions: ["exe"] }]
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

    if (settings.chromePath) {
        process.env.BROWSER_CHROME_PATH = settings.chromePath;
    }

    if (settings.cdpUrl) {
        process.env.BROWSER_CDP_URL = settings.cdpUrl;
    }

    process.env.BROWSER_AUTO_START = settings.autoStartChrome === false ? "false" : "true";

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

    // 尝试自动准备 Chrome（不阻塞界面）
    ensureChromeCdp(settings)
        .then((result) => {
            console.log("[Electron] Chrome CDP: " + result.message);
        })
        .catch((error) => {
            console.warn("[Electron] Chrome CDP setup failed:", error.message);
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
