/**
配置单一来源回归测试（config/schema.js）

锁死两类事情：
1. 行为等价：默认值、环境变量覆盖、校验文案与迁移前一致；
2. 不再漂移：agent-config / electron settings / webui browser-settings / agent-config-api
   四处的默认值必须来自 schema，任何一处重新写死字面量都会让本测试失败。

运行：node test/test-config-schema.js
*/

const assert = require("assert");
const path = require("path");

const schema = require("../config/schema");
const agentConfig = require("../config/agent-config");
const agentConfigApi = require("../webui/agent-config-api");
const electronSettings = require("../electron/settings");
const browserSettings = require("../webui/browser-settings");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function capture(fn) {
    try {
        fn();
        return null;
    } catch (error) {
        return error.message;
    }
}

console.log("=== 1. 默认值（与 1.0.7 / 1.1.0 基线一致） ===");
const defaults = schema.buildDefaults();
check("agent.maxSteps = 100", defaults.agent.maxSteps === 100);
check("agent.maxProviderErrors = 3", defaults.agent.maxProviderErrors === 3);
check("runtime.maxFileSize = 5MB", defaults.runtime.maxFileSize === 5 * 1024 * 1024);
check("runtime.maxReadSize = 2MB", defaults.runtime.maxReadSize === 2 * 1024 * 1024);
check("runtime.maxExecTimeout = 300000", defaults.runtime.maxExecTimeout === 300000);
check("runtime.maxExecOutputSize = 1MB", defaults.runtime.maxExecOutputSize === 1024 * 1024);
check("session.maxSessions = 100", defaults.session.maxSessions === 100);
check("session.maxDiskBytes = 200MB", defaults.session.maxDiskBytes === 200 * 1024 * 1024);
check("session.warnThreshold = 0.8", defaults.session.warnThreshold === 0.8);
check("browser.cdpUrl = edge 9223", defaults.browser.cdpUrl === "http://127.0.0.1:9223");
check(
    "browser.targetUrls 只作为覆盖表（provider 地址改由 provider 元数据声明）",
    Object.keys(defaults.browser.targetUrls).length === 0,
    JSON.stringify(defaults.browser.targetUrls)
);
// 默认浏览器统一为 edge（用户可在设置里切成 chrome）：
// 运行期兜底与桌面/Web 的"浏览器设置"默认值现在是同一个常量，不再分裂。
check(
    "默认浏览器统一为 edge",
    schema.DEFAULT_BROWSER_TYPE === "edge" &&
        defaults.browser.browserType === "edge" &&
        schema.browserSettingsDefaults().browserType === "edge"
);
check(
    "默认浏览器设置使用 Edge 的独立端口",
    schema.browserSettingsDefaults().cdpUrl === "http://127.0.0.1:9223"
);
check(
    "chrome 仍可选（显式传入时不被覆盖）",
    schema.normalizeBrowserSettings({ browserType: "chrome" }).browserType === "chrome" &&
        schema.normalizeBrowserSettings({ browserType: "chrome" }).cdpUrl ===
            "http://127.0.0.1:9222"
);

console.log("\n=== 2. 环境变量覆盖 ===");
const envConfig = schema.buildConfig({
    AGENT_MAX_STEPS: "7",
    RUNTIME_MAX_EXEC_TIMEOUT: "1234",
    WEBUI_MAX_SESSIONS: "9",
    WEBUI_WARN_THRESHOLD: "0.5",
    BROWSER_TYPE: "edge",
    BROWSER_EDGE_PATH: "C:/edge/msedge.exe",
    BROWSER_REUSE_PAGE: "true",
    BROWSER_HEADLESS: "true",
    XML_AGENT_PLUGINS: "0",
    XML_AGENT_STORE_ROOT: "D:/store",
});
check("AGENT_MAX_STEPS", envConfig.agent.maxSteps === 7, String(envConfig.agent.maxSteps));
check(
    "RUNTIME_MAX_EXEC_TIMEOUT",
    envConfig.runtime.maxExecTimeout === 1234,
    String(envConfig.runtime.maxExecTimeout)
);
check("WEBUI_MAX_SESSIONS", envConfig.session.maxSessions === 9);
check("WEBUI_WARN_THRESHOLD", envConfig.session.warnThreshold === 0.5);
check("BROWSER_TYPE=edge", envConfig.browser.browserType === "edge");
check("BROWSER_EDGE_PATH", envConfig.browser.edgePath === "C:/edge/msedge.exe");
check("BROWSER_REUSE_PAGE=true", envConfig.browser.reuseExistingPage === true);
check("BROWSER_HEADLESS=true", envConfig.browser.headless === true);
check("XML_AGENT_PLUGINS=0 关闭插件", envConfig.plugins.enabled === false);
check("XML_AGENT_STORE_ROOT", envConfig.plugins.storeRoot === "D:/store");

const laterWins = schema.buildConfig({
    BROWSER_TYPE: "chrome",
    XML_AGENT_BROWSER_TYPE: "msedge",
});
check(
    "XML_AGENT_BROWSER_TYPE 优先于 BROWSER_TYPE（与迁移前一致）",
    laterWins.browser.browserType === "edge",
    laterWins.browser.browserType
);

console.log("\n=== 3. 非法环境变量被忽略（不再抛错） ===");
const badEnv = schema.buildConfig({
    AGENT_MAX_STEPS: "abc",
    RUNTIME_MAX_READ_SIZE: "-5",
    WEBUI_WARN_THRESHOLD: "2",
    BROWSER_AUTO_START: "maybe",
});
check("非法 int 回落默认值", badEnv.agent.maxSteps === 100, String(badEnv.agent.maxSteps));
check("越界 int 回落默认值", badEnv.runtime.maxReadSize === 2 * 1024 * 1024);
check("越界 float 回落默认值", badEnv.session.warnThreshold === 0.8);
check("非法 boolean 回落默认值", badEnv.browser.autoStart === true);

console.log("\n=== 4. 校验文案（设置面板会直接展示） ===");
const validationCases = [
    [{ agent: { maxSteps: 0 } }, "agent.maxSteps must be a positive integer"],
    [{ agent: { maxSteps: 1.5 } }, "agent.maxSteps must be a positive integer"],
    [{ agent: { maxProviderErrors: -1 } }, "agent.maxProviderErrors must be a positive integer"],
    [{ runtime: { maxFileSize: 0 } }, "runtime.maxFileSize must be a positive integer"],
    [{ runtime: { maxReadSize: "abc" } }, "runtime.maxReadSize must be a positive integer"],
    [{ runtime: { maxExecTimeout: -1 } }, "runtime.maxExecTimeout must be a positive integer"],
    [
        { runtime: { maxExecOutputSize: -1 } },
        "runtime.maxExecOutputSize must be a positive integer",
    ],
    [{ session: { maxSessions: 0 } }, "session.maxSessions must be a positive integer"],
    [{ session: { maxDiskBytes: 0 } }, "session.maxDiskBytes must be a positive integer"],
    [{ session: { warnThreshold: 0 } }, "session.warnThreshold must be a number in (0, 1]"],
    [{ session: { warnThreshold: 1.5 } }, "session.warnThreshold must be a number in (0, 1]"],
];
for (const [partial, expected] of validationCases) {
    const errors = schema.validatePartial(partial);
    check(
        "文案一致：" + JSON.stringify(partial),
        errors.length === 1 && errors[0] === expected,
        JSON.stringify(errors)
    );
}
check("合法部分配置不报错", schema.validatePartial({ agent: { maxSteps: 200 } }).length === 0);
check(
    "只校验传入字段（未传的块不报错）",
    schema.validatePartial({ session: { maxSessions: 5 } }).length === 0
);
check(
    "非设置面板字段不参与部分校验",
    schema.validatePartial({ browser: { startTimeout: -1 } }).length === 0
);
check(
    "全量校验能报出非法配置（agent-config 加载时用）",
    schema.validateConfig({ agent: { maxSteps: 0 } }).length === 1 &&
        schema.validateConfig(schema.buildDefaults()).length === 0
);
check("非法环境变量不会让 buildConfig 抛错", Boolean(schema.buildConfig({ AGENT_MAX_STEPS: "0" })));

console.log("\n=== 5. 浏览器设置归一化（桌面版与 Web 版共用） ===");
const emptySettings = schema.normalizeBrowserSettings({});
check("默认 browserType=edge", emptySettings.browserType === "edge");
check("默认 cdpUrl=9223", emptySettings.cdpUrl === "http://127.0.0.1:9223");
check("chrome 端口仍为 9222", emptySettings.cdpUrls.chrome === "http://127.0.0.1:9222");
check("默认 autoStartChrome=true", emptySettings.autoStartChrome === true);
check(
    "非法 browserType 归一化为 chrome",
    schema.normalizeBrowserSettings({ browserType: "firefox" }).browserType === "chrome"
);
check(
    "msedge 归一化为 edge",
    schema.normalizeBrowserSettings({ browserType: "msedge" }).browserType === "edge"
);
const legacyMigrated = schema.normalizeBrowserSettings({
    browserType: "edge",
    cdpUrl: "http://127.0.0.1:9444",
});
check(
    "旧字段 cdpUrl 迁移到对应浏览器端口",
    legacyMigrated.cdpUrl === "http://127.0.0.1:9444",
    legacyMigrated.cdpUrl
);
check(
    "旧字段迁移不影响另一浏览器默认端口",
    legacyMigrated.cdpUrls.chrome === "http://127.0.0.1:9222"
);
const invalidUrl = schema.normalizeBrowserSettings({
    cdpUrls: { chrome: "ftp://nope", edge: "not-a-url" },
});
check(
    "非法 CDP URL 回退默认端口",
    invalidUrl.cdpUrls.chrome === "http://127.0.0.1:9222" &&
        invalidUrl.cdpUrls.edge === "http://127.0.0.1:9223",
    JSON.stringify(invalidUrl.cdpUrls)
);
check(
    "resolveCdpUrl 优先 cdpUrls[type]",
    schema.resolveCdpUrl({ cdpUrls: { edge: "http://127.0.0.1:9333" } }, "edge") ===
        "http://127.0.0.1:9333"
);
check(
    "resolveCdpUrl 缺失时回退该类型默认端口",
    schema.resolveCdpUrl({}, "edge") === "http://127.0.0.1:9223"
);
check(
    "profile 目录名按浏览器区分",
    schema.getProfileDirName("edge") === "edge-agent-profile" &&
        schema.getProfileDirName("chrome") === "chrome-agent-profile"
);

console.log("\n=== 6. 不再漂移：四处默认值必须同源 ===");
// 6.1 agent-config 是 schema 的纯投影
const projected = schema.buildConfig(process.env);
check(
    "config/agent-config.js 与 schema.buildConfig(process.env) 一致",
    JSON.stringify(agentConfig) === JSON.stringify(projected),
    Object.keys(agentConfig).join(",")
);

// 6.2 设置面板默认值来自 schema
const EXPECTED_UI_BLOCKS = ["agent", "runtime", "session"];
check(
    "agent-config-api 默认值只含三块",
    JSON.stringify(Object.keys(agentConfigApi.mergeWithDefaults({}))) ===
        JSON.stringify(EXPECTED_UI_BLOCKS),
    Object.keys(agentConfigApi.mergeWithDefaults({})).join(",")
);
check(
    "agent-config-api 默认值 === schema.defaultsForUI()",
    JSON.stringify(agentConfigApi.mergeWithDefaults({})) === JSON.stringify(schema.defaultsForUI())
);
check(
    "未传配置时 readAgentConfig 与默认值同源",
    JSON.stringify(agentConfigApi.mergeWithDefaults(undefined)) ===
        JSON.stringify(schema.defaultsForUI())
);

// 6.3 桌面版设置与 schema 同源
check(
    "electron DEFAULT_CDP_URLS 与 schema 相同",
    JSON.stringify(electronSettings.DEFAULT_CDP_URLS) === JSON.stringify(schema.DEFAULT_CDP_URLS)
);
check(
    "electron DEFAULT_SETTINGS 默认浏览器为 edge",
    electronSettings.DEFAULT_SETTINGS.browserType === "edge" &&
        electronSettings.DEFAULT_SETTINGS.cdpUrl === "http://127.0.0.1:9223"
);
check(
    "electron 归一化结果 = schema 结果 + focusCdpPage",
    JSON.stringify(electronSettings.normalizeSettings({ focusCdpPage: false })) ===
        JSON.stringify(Object.assign(schema.normalizeBrowserSettings({}), { focusCdpPage: false }))
);

// 6.4 Web 版设置与 schema 同源
check(
    "webui browser-settings 复用同一份 DEFAULT_CDP_URLS",
    browserSettings.DEFAULT_CDP_URLS === schema.DEFAULT_CDP_URLS
);
check(
    "webui 归一化结果 === schema 结果",
    JSON.stringify(browserSettings.normalizeSettings({ browserType: "edge" })) ===
        JSON.stringify(schema.normalizeBrowserSettings({ browserType: "edge" }))
);

// 6.5 环境变量名只出现在 schema 里
const schemaSource = require("fs").readFileSync(
    path.join(__dirname, "..", "config", "schema.js"),
    "utf8"
);
const apiSource = require("fs").readFileSync(
    path.join(__dirname, "..", "webui", "agent-config-api.js"),
    "utf8"
);
check(
    "agent-config-api 不再硬编码环境变量名",
    apiSource.indexOf("AGENT_MAX_STEPS") === -1 && apiSource.indexOf("WEBUI_MAX_SESSIONS") === -1
);
check(
    "schema 里声明了全部关键环境变量",
    ["AGENT_MAX_STEPS", "WEBUI_MAX_SESSIONS", "BROWSER_TYPE", "XML_AGENT_PLUGINS"].every(
        (name) => schemaSource.indexOf(name) !== -1
    )
);

console.log("\n=== 7. applyProvided（保存即生效）语义 ===");
const target = {};
const applied = schema.applyProvided(
    { session: { maxSessions: 5 }, agent: { maxSteps: 42 } },
    { target, env: {} }
);
check(
    "只应用传入字段",
    JSON.stringify(applied.sort()) === JSON.stringify(["agent.maxSteps", "session.maxSessions"]),
    JSON.stringify(applied)
);
check(
    "写入目标对象",
    target.agent.maxSteps === 42 && target.session.maxSessions === 5,
    JSON.stringify(target)
);
check("未传字段不写入", target.runtime === undefined, JSON.stringify(target.runtime));
const envTarget = {};
const envFile = {};
schema.applyProvided({ runtime: { maxReadSize: 1024 } }, { target: envTarget, env: envFile });
check(
    "环境变量名取自 schema（不是本文件的硬编码）",
    envFile.RUNTIME_MAX_READ_SIZE === "1024",
    JSON.stringify(envFile)
);
check(
    "applyProvided 只写传入字段对应的环境变量",
    Object.keys(envFile).length === 1,
    Object.keys(envFile).join(",")
);

// 保存即生效：applyToRuntime 必须同时改到 agentConfig 单例与同名环境变量
const previousSteps = agentConfig.agent.maxSteps;
const previousEnv = process.env.AGENT_MAX_STEPS;
agentConfigApi.applyToRuntime({ agent: { maxSteps: 55 } });
check(
    "applyToRuntime 就地改写 agentConfig 单例",
    agentConfig.agent.maxSteps === 55,
    String(agentConfig.agent.maxSteps)
);
check(
    "applyToRuntime 同步环境变量",
    process.env.AGENT_MAX_STEPS === "55",
    String(process.env.AGENT_MAX_STEPS)
);
check(
    "applyToRuntime 不触碰未提供的字段",
    agentConfig.session.maxSessions === 100,
    String(agentConfig.session.maxSessions)
);
agentConfig.agent.maxSteps = previousSteps;
if (previousEnv === undefined) {
    delete process.env.AGENT_MAX_STEPS;
} else {
    process.env.AGENT_MAX_STEPS = previousEnv;
}

console.log("");
console.log("Total: " + pass + "/" + total);
process.exit(pass === total ? 0 : 1);
