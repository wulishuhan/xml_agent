/**

==========================================================

Agent Configuration

==========================================================
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
        chromePath: "C:/Users/hunte/AppData/Local/Google/Chrome/Application",

        // web ai url
        targetUrls: {
            deepseek: "https://chat.deepseek.com",
            qwen: "https://chat.qwen.ai",
            chatgpt: "https://chatgpt.com",
        },
    },
};

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
