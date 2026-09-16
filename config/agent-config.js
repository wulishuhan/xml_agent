/**
Agent Configuration
支持环境变量覆盖：
AGENT_MAX_STEPS
AGENT_MAX_PROVIDER_ERRORS
RUNTIME_MAX_FILE_SIZE (bytes)
RUNTIME_MAX_READ_SIZE (bytes)
RUNTIME_MAX_EXEC_TIMEOUT (ms)
RUNTIME_MAX_EXEC_OUTPUT_SIZE (bytes)
BROWSER_AUTO_START (true/false)
BROWSER_START_TIMEOUT (ms)
BROWSER_RETRY_INTERVAL (ms)
BROWSER_CDP_URL
BROWSER_CHROME_PATH
BROWSER_REUSE_PAGE (true/false)
WEBUI_MAX_SESSIONS
WEBUI_MAX_DISK_BYTES (bytes)
WEBUI_WARN_THRESHOLD (0-1)
*/
const agentConfig = {
    agent: {
        maxSteps: 100,
        maxProviderErrors: 3,
    },
    runtime: {
        maxFileSize: 5 * 1024 * 1024,
        maxReadSize: 2 * 1024 * 1024,
        maxExecTimeout: 300000,
        maxExecOutputSize: 1024 * 1024,
    },

    // WebUI 会话存储限制。
    // 会话记录保存在 ~/.xml-agent/webui-sessions 下的 JSON 文件里，
    // 数量或体积过大会占用磁盘，这里提供上限与告警阈值。
    session: {
        // 允许保存的最大会话数量。达到后需先删除旧会话才能创建新会话。
        maxSessions: 100,
        // 会话存储目录允许占用的最大磁盘体积（bytes）。默认 200MB。
        maxDiskBytes: 200 * 1024 * 1024,
        // 告警阈值（0-1）：当数量或磁盘占用达到该比例时提示用户清理。
        warnThreshold: 0.8,
    },

    browser: {
        // 是否自动启动 CDP 服务器
        autoStart: true,
        // 启动 CDP 服务器超时时间（毫秒）
        startTimeout: 30000,
        // 重试间隔（毫秒）
        retryInterval: 1000,
        // CDP 服务器 URL
        cdpUrl: "http://127.0.0.1:9222",
        // Chrome.exe Path
        // chromePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        chromePath: "C:/Users/hunte/AppData/Local/Google/Chrome/Application/chrome.exe",

        // 默认值为 false：每个 Agent Session 都会创建独立 Page，
        // 避免新会话复用已有对话的标签页（导致多个 Session 串到同一个 Conversation）。
        // 如需在同一个 Provider 标签页中继续对话，可手动改为 true，
        // 或设置环境变量 BROWSER_REUSE_PAGE=true。
        // Page 仍然共享同一个 CDP BrowserContext，因此登录状态可以复用。
        reuseExistingPage: false,

        // web ai url
        targetUrls: {
            deepseek: "https://chat.deepseek.com",
            qwen: "https://chat.qwen.ai",
            chatgpt: "https://chatgpt.com",
            glm: "https://chat.z.ai",
        },
    },
};
// 环境变量覆盖
function applyEnvOverrides(config) {
    const env = process.env;
    if (env.AGENT_MAX_STEPS) {
        const val = parseInt(env.AGENT_MAX_STEPS, 10);
        if (!isNaN(val) && val > 0) config.agent.maxSteps = val;
    }
    if (env.AGENT_MAX_PROVIDER_ERRORS) {
        const val = parseInt(env.AGENT_MAX_PROVIDER_ERRORS, 10);
        if (!isNaN(val) && val > 0) config.agent.maxProviderErrors = val;
    }
    if (env.RUNTIME_MAX_FILE_SIZE) {
        const val = parseInt(env.RUNTIME_MAX_FILE_SIZE, 10);
        if (!isNaN(val) && val > 0) config.runtime.maxFileSize = val;
    }
    if (env.RUNTIME_MAX_READ_SIZE) {
        const val = parseInt(env.RUNTIME_MAX_READ_SIZE, 10);
        if (!isNaN(val) && val > 0) config.runtime.maxReadSize = val;
    }
    if (env.RUNTIME_MAX_EXEC_TIMEOUT) {
        const val = parseInt(env.RUNTIME_MAX_EXEC_TIMEOUT, 10);
        if (!isNaN(val) && val > 0) config.runtime.maxExecTimeout = val;
    }
    if (env.RUNTIME_MAX_EXEC_OUTPUT_SIZE) {
        const val = parseInt(env.RUNTIME_MAX_EXEC_OUTPUT_SIZE, 10);
        if (!isNaN(val) && val > 0) config.runtime.maxExecOutputSize = val;
    }
    if (env.WEBUI_MAX_SESSIONS) {
        const val = parseInt(env.WEBUI_MAX_SESSIONS, 10);
        if (!isNaN(val) && val > 0) config.session.maxSessions = val;
    }
    if (env.WEBUI_MAX_DISK_BYTES) {
        const val = parseInt(env.WEBUI_MAX_DISK_BYTES, 10);
        if (!isNaN(val) && val > 0) config.session.maxDiskBytes = val;
    }
    if (env.WEBUI_WARN_THRESHOLD) {
        const val = parseFloat(env.WEBUI_WARN_THRESHOLD);
        if (!isNaN(val) && val > 0 && val <= 1) config.session.warnThreshold = val;
    }
    if (env.BROWSER_AUTO_START) {
        const val = env.BROWSER_AUTO_START.toLowerCase();
        if (val === "true" || val === "1") config.browser.autoStart = true;
        else if (val === "false" || val === "0") config.browser.autoStart = false;
    }
    if (env.BROWSER_START_TIMEOUT) {
        const val = parseInt(env.BROWSER_START_TIMEOUT, 10);
        if (!isNaN(val) && val > 0) config.browser.startTimeout = val;
    }
    if (env.BROWSER_RETRY_INTERVAL) {
        const val = parseInt(env.BROWSER_RETRY_INTERVAL, 10);
        if (!isNaN(val) && val > 0) config.browser.retryInterval = val;
    }
    if (env.BROWSER_CDP_URL) {
        config.browser.cdpUrl = env.BROWSER_CDP_URL;
    }
    if (env.BROWSER_CHROME_PATH) {
        config.browser.chromePath = env.BROWSER_CHROME_PATH;
    }
    if (env.BROWSER_REUSE_PAGE) {
        const val = env.BROWSER_REUSE_PAGE.toLowerCase();
        if (val === "true" || val === "1") config.browser.reuseExistingPage = true;
        else if (val === "false" || val === "0") config.browser.reuseExistingPage = false;
    }
}
applyEnvOverrides(agentConfig);
function validateConfig(config) {
    if (!Number.isInteger(config.agent.maxSteps) || config.agent.maxSteps <= 0) {
        throw new Error("agent.maxSteps must be a positive integer");
    }
    if (!Number.isInteger(config.agent.maxProviderErrors) || config.agent.maxProviderErrors <= 0) {
        throw new Error("agent.maxProviderErrors must be a positive integer");
    }

    if (!Number.isInteger(config.runtime.maxFileSize) || config.runtime.maxFileSize <= 0) {
        throw new Error("runtime.maxFileSize must be a positive integer");
    }

    if (!Number.isInteger(config.runtime.maxReadSize) || config.runtime.maxReadSize <= 0) {
        throw new Error("runtime.maxReadSize must be a positive integer");
    }

    if (!Number.isInteger(config.runtime.maxExecTimeout) || config.runtime.maxExecTimeout <= 0) {
        throw new Error("runtime.maxExecTimeout must be a positive integer");
    }

    if (
        !Number.isInteger(config.runtime.maxExecOutputSize) ||
        config.runtime.maxExecOutputSize <= 0
    ) {
        throw new Error("runtime.maxExecOutputSize must be a positive integer");
    }

    if (config.session) {
        if (!Number.isInteger(config.session.maxSessions) || config.session.maxSessions <= 0) {
            throw new Error("session.maxSessions must be a positive integer");
        }

        if (!Number.isInteger(config.session.maxDiskBytes) || config.session.maxDiskBytes <= 0) {
            throw new Error("session.maxDiskBytes must be a positive integer");
        }

        if (
            typeof config.session.warnThreshold !== "number" ||
            config.session.warnThreshold <= 0 ||
            config.session.warnThreshold > 1
        ) {
            throw new Error("session.warnThreshold must be a number in (0, 1]");
        }
    }

    if (config.browser) {
        if (config.browser.startTimeout && config.browser.startTimeout <= 0) {
            throw new Error("browser.startTimeout must be a positive number");
        }

        if (config.browser.retryInterval && config.browser.retryInterval <= 0) {
            throw new Error("browser.retryInterval must be a positive number");
        }
    }
}
validateConfig(agentConfig);
module.exports = agentConfig;
