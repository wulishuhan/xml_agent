/**
Agent 配置管理 API

设置面板（/api/agent/config）读写的是 agent / runtime / session 三段运行参数，
保存在用户主目录：~/.xml-agent/webui-agent-config.json

默认值与校验规则全部来自 `config/schema.js`（单一来源），
本文件只负责：读文件、合并默认值、原子写入、把结果应用到运行期。
*/

const fs = require("fs");
const path = require("path");
const os = require("os");
const schema = require("../config/schema");

function getStoreDir() {
    return path.join(os.homedir(), ".xml-agent");
}

function getAgentConfigPath() {
    return path.join(getStoreDir(), "webui-agent-config.json");
}

function readAgentConfig() {
    try {
        const configPath = getAgentConfigPath();
        if (!fs.existsSync(configPath)) {
            return mergeWithDefaults({});
        }
        const raw = fs.readFileSync(configPath, "utf8");
        return mergeWithDefaults(JSON.parse(raw));
    } catch (error) {
        return mergeWithDefaults({});
    }
}

/**
把用户配置合并到默认值之上。只合并设置面板管理的三块，
块内保留用户写入的额外键（与迁移前一致），缺失字段用 schema 默认值补齐。
*/
function mergeWithDefaults(userConfig) {
    const result = schema.defaultsForUI();
    const source = userConfig && typeof userConfig === "object" ? userConfig : {};
    for (const block of schema.UI_BLOCKS) {
        if (source[block] && typeof source[block] === "object") {
            result[block] = Object.assign({}, result[block], source[block]);
        }
    }
    return result;
}

/**
设置面板的部分校验：只校验实际提交的字段。
*/
function validateAgentConfig(config) {
    if (!config || typeof config !== "object") {
        return ["Invalid config object"];
    }
    return schema.validatePartial(config);
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

    // 同步到运行时环境变量与已加载的 agentConfig 单例（保存即生效）
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

/**
把配置应用到运行期：
1. 写回同名环境变量（env 名来自 schema，不再在本文件里维护一份映射）；
2. 就地改写已加载的 agentConfig 单例（运行期读的是它）。

只应用用户实际提供的字段，因此不会用默认值覆盖用户显式设置的环境变量。
*/
function applyToRuntime(config) {
    if (!config || typeof config !== "object") {
        return [];
    }
    let agentConfig = null;
    try {
        // eslint-disable-next-line global-require
        agentConfig = require("../config/agent-config");
    } catch (error) {
        agentConfig = null;
    }
    return schema.applyProvided(config, {
        target: agentConfig || {},
        env: process.env,
    });
}

module.exports = {
    getAgentConfigPath,
    readAgentConfig,
    mergeWithDefaults,
    writeAgentConfig,
    applyToRuntime,
    formatBytes,
    parseBytes,
};
