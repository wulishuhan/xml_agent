/**
 * Provider 实例化参数装配

Agent 创建 provider 时需要一长串参数（CDP 地址、浏览器可执行文件、超时、
目标 URL…）。这些参数的来源有三层优先级：

    环境变量（由 electron 主进程按当前设置写入） > config/schema 默认值 > 常量兜底

把这段装配逻辑放在编排器里，会让 Agent.run() 的主流程被 18 行配置噪音淹没，
所以集中到这里。约定：

- 本模块只做"读配置 + 归一化"，不创建 provider、不启动浏览器；
- 所有读取都在调用时发生（config 运行期可被 applyToRuntime 就地改写，
  因此不能用模块级常量缓存）；
- env 名称集中在本文件，其他模块不应再各自拼 env 名。
*/

const agentConfig = require("../config/agent-config");
const { getProviderMeta, resolveTargetUrl } = require("./index");
// 变量名清单与归一化规则由叶子模块统一提供，browser-agent 用的是同一份。
const {
    EDGE_PATH_ENVS,
    CHROME_PATH_ENVS,
    CDP_URL_ENVS,
    firstEnv,
    normalizeBrowserType,
    browserPathFromEnv,
    cdpUrlFromEnv,
} = require("./browser-env");

/**
 * 解析浏览器可执行文件路径：环境变量优先，其次是配置，最后回退到另一种浏览器。
 */
function resolveBrowserPath(browserType, env) {
    if (normalizeBrowserType(browserType) === "edge") {
        return (
            browserPathFromEnv("edge", env) ||
            agentConfig.browser.edgePath ||
            agentConfig.browser.chromePath ||
            ""
        );
    }
    return browserPathFromEnv("chrome", env) || agentConfig.browser.chromePath || "";
}

/**
 * 解析 CDP 调试地址：环境变量（主进程按 browserType 写入对应端口）优先。
 */
function resolveCdpUrl(env) {
    return cdpUrlFromEnv(env) || agentConfig.browser.cdpUrl;
}

/**
 * 装配创建 provider 所需的全部参数。
 *
 * @param {object} input
 * @param {string} input.providerName provider id
 * @param {string} input.browserType 已归一化的 chrome / edge
 * @param {boolean} input.focusCdpPage 是否把 CDP 页面带到前台
 * @param {string|null} input.conversationId 续接的会话 id
 * @returns {object} 可直接传给 createProvider(name, options)
 */
function buildProviderOptions(input = {}) {
    const providerName = input.providerName;
    const browserType = normalizeBrowserType(input.browserType);
    const meta = getProviderMeta(providerName);
    return {
        autoStart: agentConfig.browser.autoStart,
        startTimeout: agentConfig.browser.startTimeout,
        retryInterval: agentConfig.browser.retryInterval,
        cdpUrl: resolveCdpUrl(),
        // 保持旧字段 chromePath 兼容，同时显式传入 browserType。
        chromePath: resolveBrowserPath(browserType),
        browserType: browserType,
        targetUrl: resolveTargetUrl(providerName, agentConfig.browser.targetUrls),
        supportsImages: meta ? meta.supportsImages : true,
        reuseExistingPage: agentConfig.browser.reuseExistingPage,
        focusCdpPage: input.focusCdpPage,
        conversationId: input.conversationId || null,
    };
}

module.exports = {
    buildProviderOptions,
    normalizeBrowserType,
    resolveBrowserPath,
    resolveCdpUrl,
    EDGE_PATH_ENVS,
    CHROME_PATH_ENVS,
    CDP_URL_ENVS,
};
