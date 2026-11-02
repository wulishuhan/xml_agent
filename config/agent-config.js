/**
Agent Configuration

本文件现在只是 `config/schema.js` 的投影：
默认值、环境变量名、校验规则全部来自 schema（单一来源），这里不再持有任何字面量。

导出面保持不变（webui / electron / runtime / providers 都按这个形状读取）：
    agent:   { maxSteps, maxProviderErrors }
    runtime: { maxFileSize, maxReadSize, maxExecTimeout, maxExecOutputSize }
    session: { maxSessions, maxDiskBytes, warnThreshold }
    plugins: { enabled, dirs, maxPromptChars, storeRoot }
    browser: { autoStart, startTimeout, retryInterval, cdpUrl, browserType, chromePath,
               edgePath, reuseExistingPage, focusCdpPage, targetUrls, headless }

支持的环境变量详见 config/schema.js 的 FIELDS 声明（每行都标了 env 名）。

注意：运行期会被 applyToRuntime / browser-settings.applyToRuntime 就地改写，
因此读取方应当**每次使用时读取字段**，不要把值缓存到模块级常量里
（v1.1.0 起内置动作已改为调用时读取）。
*/

const schema = require("./schema");

const agentConfig = schema.buildConfig(process.env);

module.exports = agentConfig;
module.exports.normalizeBrowserType = schema.normalizeBrowserType;
