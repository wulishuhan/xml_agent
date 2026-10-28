/**
Agent配置管理API
提供读取和写入agent-config.js配置的接口
配置保存在用户主目录：~/.xml-agent/webui-agent-config.json
*/
const fs = require("fs");
const path = require("path");
const os = require("os");

function getStoreDir() {
    return path.join(os.homedir(), ".xml-agent");
}

function getAgentConfigPath() {
    return path.join(getStoreDir(), "webui-agent-config.json");
}

// 默认配置值（与config/agent-config.js保持一致）
const DEFAULT_CONFIG = {
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
    session: {
        maxSessions: 100,
        maxDiskBytes: 200 * 1024 * 1024,
        warnThreshold: 0.8,
    },
};

function readAgentConfig() {
    try {
        const configPath = getAgentConfigPath();
        if (!fs.existsSync(configPath)) {
            return Object.assign({}, DEFAULT_CONFIG);
        }
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed = JSON.parse(raw);
        // 合并默认值，确保所有字段存在
        return mergeWithDefaults(parsed);
    } catch (error) {
        return Object.assign({}, DEFAULT_CONFIG);
    }
}

function mergeWithDefaults(userConfig) {
    const result = Object.assign({}, DEFAULT_CONFIG);
    if (userConfig && typeof userConfig === "object") {
        if (userConfig.agent && typeof userConfig.agent === "object") {
            result.agent = Object.assign({}, result.agent, userConfig.agent);
        }
        if (userConfig.runtime && typeof userConfig.runtime === "object") {
            result.runtime = Object.assign({}, result.runtime, userConfig.runtime);
        }
        if (userConfig.session && typeof userConfig.session === "object") {
            result.session = Object.assign({}, result.session, userConfig.session);
        }
    }
    return result;
}

function validateAgentConfig(config) {
    const errors = [];

    if (!config || typeof config !== "object") {
        return ["Invalid config object"];
    }

    // 验证agent配置
    if (config.agent) {
        if (config.agent.maxSteps !== undefined) {
            const val = Number(config.agent.maxSteps);
            if (!Number.isInteger(val) || val <= 0) {
                errors.push("agent.maxSteps must be a positive integer");
            }
        }
        if (config.agent.maxProviderErrors !== undefined) {
            const val = Number(config.agent.maxProviderErrors);
            if (!Number.isInteger(val) || val <= 0) {
                errors.push("agent.maxProviderErrors must be a positive integer");
            }
        }
    }

    // 验证runtime配置
    if (config.runtime) {
        if (config.runtime.maxFileSize !== undefined) {
            const val = Number(config.runtime.maxFileSize);
            if (!Number.isInteger(val) || val <= 0) {
                errors.push("runtime.maxFileSize must be a positive integer");
            }
        }
        if (config.runtime.maxReadSize !== undefined) {
            const val = Number(config.runtime.maxReadSize);
            if (!Number.isInteger(val) || val <= 0) {
                errors.push("runtime.maxReadSize must be a positive integer");
            }
        }
        if (config.runtime.maxExecTimeout !== undefined) {
            const val = Number(config.runtime.maxExecTimeout);
            if (!Number.isInteger(val) || val <= 0) {
                errors.push("runtime.maxExecTimeout must be a positive integer");
            }
        }
        if (config.runtime.maxExecOutputSize !== undefined) {
            const val = Number(config.runtime.maxExecOutputSize);
            if (!Number.isInteger(val) || val <= 0) {
                errors.push("runtime.maxExecOutputSize must be a positive integer");
            }
        }
    }

    // 验证session配置
    if (config.session) {
        if (config.session.maxSessions !== undefined) {
            const val = Number(config.session.maxSessions);
            if (!Number.isInteger(val) || val <= 0) {
                errors.push("session.maxSessions must be a positive integer");
            }
        }
        if (config.session.maxDiskBytes !== undefined) {
            const val = Number(config.session.maxDiskBytes);
            if (!Number.isInteger(val) || val <= 0) {
                errors.push("session.maxDiskBytes must be a positive integer");
            }
        }
        if (config.session.warnThreshold !== undefined) {
            const val = Number(config.session.warnThreshold);
            if (isNaN(val) || val <= 0 || val > 1) {
                errors.push("session.warnThreshold must be a number in (0, 1]");
            }
        }
    }

    return errors;
}

function writeAgentConfig(config) {
    const errors = validateAgentConfig(config);
    if (errors.length > 0) {
        throw new Error("Validation failed: " + errors.join("; "));
    }

    const merged = mergeWithDefaults(config);
    const dir = getStoreDir();
    fs.mkdirSync(dir, { recursive: true });

    const filePath = getAgentConfigPath();
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);

    // 同步到运行时环境变量
    applyToRuntime(merged);

    return merged;
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function parseBytes(value) {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return NaN;

    const trimmed = value.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
    if (!match) return parseInt(value, 10);

    const num = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
        case "b":
            return num;
        case "kb":
            return num * 1024;
        case "mb":
            return num * 1024 * 1024;
        case "gb":
            return num * 1024 * 1024 * 1024;
        default:
            return num;
    }
}

function applyToRuntime(config) {
    if (!config || typeof config !== "object") return;

    // 应用agent配置
    if (config.agent) {
        if (config.agent.maxSteps !== undefined) {
            process.env.AGENT_MAX_STEPS = String(config.agent.maxSteps);
        }
        if (config.agent.maxProviderErrors !== undefined) {
            process.env.AGENT_MAX_PROVIDER_ERRORS = String(config.agent.maxProviderErrors);
        }
    }

    // 应用runtime配置
    if (config.runtime) {
        if (config.runtime.maxFileSize !== undefined) {
            process.env.RUNTIME_MAX_FILE_SIZE = String(config.runtime.maxFileSize);
        }
        if (config.runtime.maxReadSize !== undefined) {
            process.env.RUNTIME_MAX_READ_SIZE = String(config.runtime.maxReadSize);
        }
        if (config.runtime.maxExecTimeout !== undefined) {
            process.env.RUNTIME_MAX_EXEC_TIMEOUT = String(config.runtime.maxExecTimeout);
        }
        if (config.runtime.maxExecOutputSize !== undefined) {
            process.env.RUNTIME_MAX_EXEC_OUTPUT_SIZE = String(config.runtime.maxExecOutputSize);
        }
    }

    // 应用session配置
    if (config.session) {
        if (config.session.maxSessions !== undefined) {
            process.env.WEBUI_MAX_SESSIONS = String(config.session.maxSessions);
        }
        if (config.session.maxDiskBytes !== undefined) {
            process.env.WEBUI_MAX_DISK_BYTES = String(config.session.maxDiskBytes);
        }
        if (config.session.warnThreshold !== undefined) {
            process.env.WEBUI_WARN_THRESHOLD = String(config.session.warnThreshold);
        }
    }

    // 同步到已加载的agentConfig单例
    try {
        const agentConfig = require("../config/agent-config");
        if (agentConfig) {
            if (config.agent) {
                if (config.agent.maxSteps !== undefined) {
                    agentConfig.agent.maxSteps = config.agent.maxSteps;
                }
                if (config.agent.maxProviderErrors !== undefined) {
                    agentConfig.agent.maxProviderErrors = config.agent.maxProviderErrors;
                }
            }
            if (config.runtime) {
                if (config.runtime.maxFileSize !== undefined) {
                    agentConfig.runtime.maxFileSize = config.runtime.maxFileSize;
                }
                if (config.runtime.maxReadSize !== undefined) {
                    agentConfig.runtime.maxReadSize = config.runtime.maxReadSize;
                }
                if (config.runtime.maxExecTimeout !== undefined) {
                    agentConfig.runtime.maxExecTimeout = config.runtime.maxExecTimeout;
                }
                if (config.runtime.maxExecOutputSize !== undefined) {
                    agentConfig.runtime.maxExecOutputSize = config.runtime.maxExecOutputSize;
                }
            }
            if (config.session) {
                if (!agentConfig.session) {
                    agentConfig.session = {};
                }
                if (config.session.maxSessions !== undefined) {
                    agentConfig.session.maxSessions = config.session.maxSessions;
                }
                if (config.session.maxDiskBytes !== undefined) {
                    agentConfig.session.maxDiskBytes = config.session.maxDiskBytes;
                }
                if (config.session.warnThreshold !== undefined) {
                    agentConfig.session.warnThreshold = config.session.warnThreshold;
                }
            }
        }
    } catch (error) {
        // agentConfig不存在时忽略
    }
}

module.exports = {
    getAgentConfigPath,
    readAgentConfig,
    writeAgentConfig,
    applyToRuntime,
    formatBytes,
    parseBytes,
};
