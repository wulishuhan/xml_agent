const path = require("path");
const net = require("net");
const { app, BrowserWindow, dialog, shell } = require("electron");

const HOST = "127.0.0.1";
const PORT_START = 3000;
const PORT_END = 3999;

let mainWindow = null;
let serverModule = null;
let serverInstance = null;
let shuttingDown = false;

function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();

        tester.once("error", () => {
            resolve(false);
        });

        tester.once("listening", () => {
            tester.close(() => resolve(true));
        });

        tester.listen(port, HOST);
    });
}

async function findFreePort(start = PORT_START, end = PORT_END) {
    // 如果用户显式指定 PORT，则只用这个端口
    if (process.env.PORT) {
        const explicit = Number(process.env.PORT);

        if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) {
            const free = await isPortFree(explicit);

            if (free) {
                return explicit;
            }

            throw new Error("Port " + explicit + " is not available (from env PORT)");
        }
    }

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
    // webui/server.js 位于项目根目录下的 webui 目录
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
        },
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    // 外部链接交给系统浏览器打开
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

    // 让 webui/server.js 启动时也使用同一个端口
    process.env.PORT = String(port);
    // 让 preload 能读到当前端口
    process.env.XML_AGENT_PORT = String(port);

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

    app.whenReady().then(bootstrap);
}
