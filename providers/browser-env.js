/**
浏览器相关的环境变量契约（叶子模块，不 require 任何项目内模块）

Electron 主进程在启动时按当前设置写入这批变量，provider 侧读取。
此前"变量名清单"存在两份（providers/options.js 与 providers/browser-agent.js），
而且两份不一致：一个认 BROWSER_CHROME_PATH，另一个只认 CHROME_PATH 与
XML_AGENT_CHROME_PATH，导致"启动参数"和"自动探测"可能选中不同浏览器。

放在叶子模块里，两边共用同一份清单，也不会引入 require 环
（options → index → registry → chatgpt → browser-chat → browser-agent）。
*/

// 优先级从高到低。BROWSER_* 由主进程按用户设置写入，其余为手动兜底。
const EDGE_PATH_ENVS = ["BROWSER_EDGE_PATH", "EDGE_PATH", "XML_AGENT_EDGE_PATH"];
const CHROME_PATH_ENVS = ["BROWSER_CHROME_PATH", "CHROME_PATH", "XML_AGENT_CHROME_PATH"];
const CDP_URL_ENVS = ["BROWSER_CDP_URL", "XML_AGENT_CDP_URL"];

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

/**
按优先级取第一个非空环境变量值。
@param {string[]} names
@param {object} [env] 可注入替身，便于测试
@returns {string}
*/
function firstEnv(names, env) {
    const source = env || process.env;
    for (const name of names) {
        const value = source[name];
        if (value && String(value).trim()) {
            return String(value).trim();
        }
    }
    return "";
}

/**
归一化浏览器类型：只认 chrome / edge，其余一律按 chrome 处理。
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
按当前浏览器类型读可执行文件路径的环境变量。
*/
function browserPathFromEnv(browserType, env) {
    return firstEnv(
        normalizeBrowserType(browserType) === "edge" ? EDGE_PATH_ENVS : CHROME_PATH_ENVS,
        env
    );
}

/**
按当前浏览器类型读 CDP 地址的环境变量。
*/
function cdpUrlFromEnv(env) {
    return firstEnv(CDP_URL_ENVS, env);
}

module.exports = {
    EDGE_PATH_ENVS,
    CHROME_PATH_ENVS,
    CDP_URL_ENVS,
    DEFAULT_CDP_URL,
    firstEnv,
    normalizeBrowserType,
    browserPathFromEnv,
    cdpUrlFromEnv,
};
