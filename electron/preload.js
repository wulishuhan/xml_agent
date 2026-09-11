const { contextBridge, ipcRenderer } = require("electron");

// 优先从主进程通过 additionalArguments 传入的端口读取，
// 因为打包后的 Electron 主进程与渲染进程不共享 process.env。
function readPortFromArgv() {
    const prefix = "--xml-agent-port=";

    for (const arg of process.argv) {
        if (typeof arg === "string" && arg.startsWith(prefix)) {
            const value = Number(arg.substring(prefix.length));

            if (Number.isInteger(value) && value > 0) {
                return value;
            }
        }
    }

    return null;
}

const argvPort = readPortFromArgv();
const envPort = Number(process.env.XML_AGENT_PORT || process.env.PORT);
const port = argvPort || (Number.isInteger(envPort) && envPort > 0 ? envPort : 3000);

contextBridge.exposeInMainWorld("xmlAgentDesktop", {
    isElectron: true,
    platform: process.platform,
    port,
    baseUrl: "http://127.0.0.1:" + port,
    settings: {
        read: () => ipcRenderer.invoke("settings:read"),
        write: (next) => ipcRenderer.invoke("settings:write", next),
        path: () => ipcRenderer.invoke("settings:path"),
    },
    chrome: {
        detect: () => ipcRenderer.invoke("chrome:detect"),
        launch: () => ipcRenderer.invoke("chrome:launch"),
        status: () => ipcRenderer.invoke("chrome:status"),
        pickFile: () => ipcRenderer.invoke("dialog:pickChrome"),
    },
    app: {
        port: () => ipcRenderer.invoke("app:port"),
    },
});

module.exports = {};
