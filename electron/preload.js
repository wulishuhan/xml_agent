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
    // 浏览器（Chrome / Edge）CDP 相关接口。
    browser: {
        detect: (browserType) => ipcRenderer.invoke("browser:detect", browserType),
        launch: () => ipcRenderer.invoke("browser:launch"),
        // 切换浏览器：关闭旧浏览器并在独立端口上启动目标浏览器
        switch: (browserType) => ipcRenderer.invoke("browser:switch", browserType),
        status: () => ipcRenderer.invoke("browser:status"),
        pickFile: () => ipcRenderer.invoke("dialog:pickBrowser"),
    },
    // 兼容旧接口名称（chrome.*），行为与新接口一致。
    chrome: {
        detect: () => ipcRenderer.invoke("chrome:detect"),
        launch: () => ipcRenderer.invoke("chrome:launch"),
        status: () => ipcRenderer.invoke("chrome:status"),
        pickFile: () => ipcRenderer.invoke("dialog:pickChrome"),
    },
    // 系统通知：任务完成后给用户发送 Windows 通知。
    notifications: {
        taskDone: (sessionInfo) => ipcRenderer.invoke("notify:task-done", sessionInfo),
        send: (payload) => ipcRenderer.invoke("notify:send", payload),
    },
    // 桌面端选择图片：返回本地绝对路径数组，供 Agent 启动时上传给模型。
    dialog: {
        pickImages: () => ipcRenderer.invoke("dialog:pickImages"),
    },
    app: {
        port: () => ipcRenderer.invoke("app:port"),
    },
});
module.exports = {};
