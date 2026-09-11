/**

跨平台 Chrome 自动探测。

目标：打包成 exe 分发给其他用户时，不依赖开发者本机的 chromePath，

而是自动在各平台常见安装位置查找 Chrome / Edge 可执行文件。

查找优先级：

环境变量 BROWSER_CHROME_PATH（用户手动指定）

环境变量 CHROME_PATH（兼容旧配置）

用户数据目录下的配置文件（Electron 桌面版首次启动时写入）

系统常见安装路径（按平台）

由 config/agent-config.js 提供的默认路径

注意：Electron 打包后 asar 内的模块不能直接读 asar 外的文件，

因此这里只做“查找”，读写用户配置由 electron 主进程负责。
*/

const fs = require("fs");
const path = require("path");
const os = require("os");

function exists(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch (error) {
        return false;
    }
}

function getWindowsCandidates() {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\Program Files (x86)";

    return [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFiles, "Google", "Chrome Beta", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome Beta", "Application", "chrome.exe"),
        path.join(programFiles, "Google", "Chrome SxS", "Application", "chrome.exe"),
        // Microsoft Edge（基于 Chromium，同样支持 CDP）
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
}

function getMacCandidates() {
    return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
}

function getLinuxCandidates() {
    return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
    ];
}

function getPlatformCandidates() {
    if (process.platform === "win32") {
        return getWindowsCandidates();
    }

    if (process.platform === "darwin") {
        return getMacCandidates();
    }

    return getLinuxCandidates();
}

/**

依次尝试：显式路径 -> 环境变量 -> 平台常见路径 -> 额外候选列表

@param {Object} options

@param {string} [options.explicitPath] 用户配置文件中保存的路径

@param {string} [options.configPath] agent-config 中的默认 chromePath

@returns {string|null} 找到的 Chrome 可执行文件绝对路径，找不到返回 null
*/
function findChrome(options = {}) {
    const candidates = [];

    if (options.explicitPath) {
        candidates.push(options.explicitPath);
    }

    if (process.env.BROWSER_CHROME_PATH) {
        candidates.push(process.env.BROWSER_CHROME_PATH);
    }

    if (process.env.CHROME_PATH) {
        candidates.push(process.env.CHROME_PATH);
    }

    if (process.env.XML_AGENT_CHROME_PATH) {
        candidates.push(process.env.XML_AGENT_CHROME_PATH);
    }

    for (const candidate of getPlatformCandidates()) {
        candidates.push(candidate);
    }

    if (options.configPath) {
        candidates.push(options.configPath);
    }

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        if (exists(candidate)) {
            return candidate;
        }
    }

    return null;
}

module.exports = {
    findChrome,
    getPlatformCandidates,
};
