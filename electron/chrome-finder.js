/**
跨平台浏览器（Chrome / Edge）自动探测。
目标：打包成 exe 分发给其他用户时，不依赖开发者本机的 chromePath，
而是自动在各平台常见安装位置查找 Chrome / Edge 可执行文件。
查找优先级：
环境变量 BROWSER_CHROME_PATH / BROWSER_EDGE_PATH（用户手动指定）
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
function getWindowsChromeCandidates() {
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
    ];
}
function getWindowsEdgeCandidates() {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\Program Files (x86)";
    return [
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge Beta", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge Dev", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge SxS", "Application", "msedge.exe"),
    ];
}
// 保持向后兼容：旧的 getWindowsCandidates() 返回 Chrome + Edge 混合列表。
function getWindowsCandidates() {
    return getWindowsChromeCandidates().concat(getWindowsEdgeCandidates());
}
function getMacChromeCandidates() {
    return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
}
function getMacEdgeCandidates() {
    return [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
        "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
    ];
}
function getMacCandidates() {
    return getMacChromeCandidates().concat(getMacEdgeCandidates());
}
function getLinuxChromeCandidates() {
    return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ];
}
function getLinuxEdgeCandidates() {
    return [
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/microsoft-edge-beta",
        "/usr/bin/microsoft-edge-dev",
        "/opt/microsoft/msedge/msedge",
    ];
}
function getLinuxCandidates() {
    return getLinuxChromeCandidates().concat(getLinuxEdgeCandidates());
}
/**
按浏览器类型返回平台候选路径。
@param {"chrome"|"edge"} browserType
*/
function getPlatformCandidates(browserType) {
    const type = normalizeBrowserType(browserType);
    if (type === "edge") {
        if (process.platform === "win32") return getWindowsEdgeCandidates();
        if (process.platform === "darwin") return getMacEdgeCandidates();
        return getLinuxEdgeCandidates();
    }
    if (process.platform === "win32") return getWindowsChromeCandidates();
    if (process.platform === "darwin") return getMacChromeCandidates();
    return getLinuxChromeCandidates();
}
/**
规范化浏览器类型，仅允许 chrome / edge。
*/
function normalizeBrowserType(value) {
    const text = String(value || "")
        .trim()
        .toLowerCase();
    if (text === "edge" || text === "msedge" || text === "microsoft-edge") {
        return "edge";
    }
    return "chrome";
}
/**
根据可执行文件名/路径推断浏览器类型。
*/
function detectBrowserTypeFromPath(filePath) {
    const base = path.basename(String(filePath || "")).toLowerCase();
    if (base.indexOf("msedge") !== -1 || base === "microsoft edge") {
        return "edge";
    }
    return "chrome";
}
/**
依次尝试：显式路径 -> 环境变量 -> 平台常见路径 -> 额外候选列表
@param {Object} options
@param {string} [options.explicitPath] 用户配置文件中保存的路径
@param {string} [options.configPath] agent-config 中的默认 chromePath
@param {"chrome"|"edge"} [options.browserType] 仅探测指定浏览器（默认 chrome）
@param {boolean} [options.allowCrossBrowser] 为 true 时在所有浏览器中查找
@returns {string|null} 找到的可执行文件绝对路径，找不到返回 null
*/
function findBrowser(options = {}) {
    const browserType = normalizeBrowserType(options.browserType);
    const candidates = [];
    if (options.explicitPath) {
        candidates.push(options.explicitPath);
    }
    if (browserType === "edge") {
        if (process.env.BROWSER_EDGE_PATH) candidates.push(process.env.BROWSER_EDGE_PATH);
        if (process.env.XML_AGENT_EDGE_PATH) candidates.push(process.env.XML_AGENT_EDGE_PATH);
        if (process.env.EDGE_PATH) candidates.push(process.env.EDGE_PATH);
    } else {
        if (process.env.BROWSER_CHROME_PATH) candidates.push(process.env.BROWSER_CHROME_PATH);
        if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
        if (process.env.XML_AGENT_CHROME_PATH) {
            candidates.push(process.env.XML_AGENT_CHROME_PATH);
        }
    }
    for (const candidate of getPlatformCandidates(browserType)) {
        candidates.push(candidate);
    }
    if (options.configPath) {
        candidates.push(options.configPath);
    }
    // 兜底：如果指定浏览器没找到，且允许跨浏览器，则再尝试另一类浏览器。
    if (options.allowCrossBrowser) {
        const otherType = browserType === "edge" ? "chrome" : "edge";
        for (const candidate of getPlatformCandidates(otherType)) {
            candidates.push(candidate);
        }
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
/**
兼容旧调用：findChrome 默认查找 Chrome。
@param {Object} options
*/
function findChrome(options = {}) {
    return findBrowser(Object.assign({}, options, { browserType: "chrome" }));
}
/**
查找 Edge 可执行文件。
@param {Object} options
*/
function findEdge(options = {}) {
    return findBrowser(Object.assign({}, options, { browserType: "edge" }));
}
module.exports = {
    findChrome,
    findEdge,
    findBrowser,
    getPlatformCandidates,
    normalizeBrowserType,
    detectBrowserTypeFromPath,
};
