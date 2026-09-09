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
        chromePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        // chromePath: "C:/Users/hunte/AppData/Local/Google/Chrome/Application/chrome.exe",

        // 默认复用已有 Provider Page。
        // 如果需要为每个 Agent Session 创建独立 Page，手动改为 false。
        // Page 仍然共享 CDP BrowserContext，因此可以复用登录状态。
        reuseExistingPage: true,

        // web ai url
        targetUrls: {
            deepseek: "https://chat.deepseek.com",
            qwen: "https://chat.qwen.ai",
            chatgpt: "https://chatgpt.com",
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
