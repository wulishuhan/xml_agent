/**
 * 拟人化配置契约单测
 *
 * 覆盖：新字段默认值、环境变量覆盖、listEnvFields 包含新 env、
 *       浏览器设置归一化不受新字段影响（表单只管理 agent/runtime/session 三块）。
 *
 * 运行：node test/unit/test-config-humanize.js
 */

const schema = require("../../config/schema");
const agentConfig = require("../../config/agent-config");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

async function main() {
    const defaults = schema.buildDefaults();
    check("humanize 默认 true", defaults.browser.humanize === true);
    check("humanizeMaxChars 默认 800", defaults.browser.humanizeMaxChars === 800);
    check(
        "typingDelay 默认 15/60",
        defaults.browser.typingDelayMinMs === 15 && defaults.browser.typingDelayMaxMs === 60
    );
    check(
        "stepDelay 默认 800/3500",
        defaults.browser.stepDelayMinMs === 800 && defaults.browser.stepDelayMaxMs === 3500
    );
    check("stableTimeJitter 默认 0.35", defaults.browser.stableTimeJitter === 0.35);
    check("retryJitter 默认 0.3", defaults.browser.retryJitter === 0.3);
    check("throttleCooldownMs 默认 60000", defaults.browser.throttleCooldownMs === 60000);
    check("maxConcurrentSessions 默认 1", defaults.browser.maxConcurrentSessions === 1);
    // 技能自动安装：默认开，只同步 builtin + user，不覆盖工作区已有副本
    check("skills.autoInstall 默认 true", defaults.skills.autoInstall === true);
    check(
        "skills.autoInstallSources 默认 builtin+user",
        JSON.stringify(defaults.skills.autoInstallSources) === '["builtin","user"]'
    );
    check("skills.autoInstallOverwrite 默认 false", defaults.skills.autoInstallOverwrite === false);

    const envNames = schema.listEnvFields().map((field) => field.env[0]);
    for (const name of [
        "BROWSER_HUMANIZE",
        "BROWSER_HUMANIZE_MAX_CHARS",
        "BROWSER_TYPING_DELAY_MIN_MS",
        "BROWSER_TYPING_DELAY_MAX_MS",
        "BROWSER_STEP_DELAY_MIN_MS",
        "BROWSER_STEP_DELAY_MAX_MS",
        "BROWSER_STABLE_TIME_JITTER",
        "BROWSER_RETRY_JITTER",
        "BROWSER_THROTTLE_COOLDOWN_MS",
        "BROWSER_MAX_CONCURRENT_SESSIONS",
        "SKILLS_AUTO_INSTALL",
        "SKILLS_AUTO_INSTALL_SOURCES",
        "SKILLS_AUTO_INSTALL_OVERWRITE",
    ]) {
        check("env 映射 " + name, envNames.indexOf(name) !== -1);
    }

    const envConfig = schema.buildConfig({
        BROWSER_MAX_CONCURRENT_SESSIONS: "2",
        BROWSER_HUMANIZE: "false",
        BROWSER_HUMANIZE_MAX_CHARS: "0",
    });
    check("env 覆盖 maxConcurrentSessions", envConfig.browser.maxConcurrentSessions === 2);
    check("env 覆盖 humanize", envConfig.browser.humanize === false);
    check("env 覆盖 humanizeMaxChars=0", envConfig.browser.humanizeMaxChars === 0);

    // 浏览器设置归一化不应引入新字段（表单只管理 UI_BLOCKS 三块）
    const browserSettings = schema.normalizeBrowserSettings({});
    check("浏览器设置不含 humanize 字段", browserSettings.humanize === undefined);
    check(
        "浏览器设置不含 maxConcurrentSessions",
        browserSettings.maxConcurrentSessions === undefined
    );

    // agent-config 单例投影包含新字段
    check("agentConfig 含 maxConcurrentSessions", agentConfig.browser.maxConcurrentSessions === 1);
    check("agentConfig 含 humanize", agentConfig.browser.humanize === true);

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("FAILED: " + error.stack);
    process.exitCode = 1;
});
