/**
Provider 真机测试脚本（会真实连接 CDP 浏览器并发送消息）。
用法：
node test/test-provider-live.js deepseek
node test/test-provider-live.js chatgpt
node test/test-provider-live.js qwen
node test/test-provider-live.js glm
node test/test-provider-live.js all
可选参数：
--cid=<conversationId> 使用指定会话（例如已有会话 URL 中的 id）
--reuse 复用已有 Provider 页面（默认 false，会新建独立页面）
--new-page 强制新建独立页面
--prompt="..." 自定义发送内容
--timeout-ms=<number> 自定义 waitForInput / response 等待时间（毫秒）
约束：
需要在 127.0.0.1:9222 已启动带 CDP 的 Chrome
该 Chrome 中对应的 provider 页面已登录
该脚本不会修改项目文件，只做验证。
说明：
为了让真机测试更贴近现有 Chrome 里已登录的页面，默认行为是：
若未指定 --cid 且未指定 --new-page：优先复用已有页面
若指定 --cid：强制打开该会话 URL（不复用其它页面）
若指定 --new-page：强制新建独立页面
这样，普通使用者只想快速验证是否可发送/接收时，直接跑：
node test/test-provider-live.js glm
就能在已登录的 GLM 页面上执行。
*/
const path = require("path");
const projectRoot = path.join(__dirname, "..");
const DEFAULT_PROMPT = "请只回复两个字：收到";
const DEFAULT_INPUT_WAIT_MS = 120000;
const DEFAULT_RESPONSE_WAIT_MS = 5 * 60 * 1000;
function parseArgs(argv) {
    const args = {
        provider: "all",
        conversationId: null,
        reuse: null,
        newPage: false,
        prompt: DEFAULT_PROMPT,
        inputWaitMs: DEFAULT_INPUT_WAIT_MS,
        responseWaitMs: DEFAULT_RESPONSE_WAIT_MS,
    };
    for (const raw of argv) {
        if (!raw.startsWith("--")) {
            if (args.provider === "all" && raw) {
                args.provider = raw.toLowerCase();
            }
            continue;
        }

        const eq = raw.indexOf("=");
        const key = eq === -1 ? raw.substring(2) : raw.substring(2, eq);
        const value = eq === -1 ? "" : raw.substring(eq + 1);

        switch (key) {
            case "cid":
                args.conversationId = value || null;
                break;
            case "reuse":
                args.reuse = true;
                break;
            case "new-page":
            case "newPage":
                args.newPage = true;
                break;
            case "prompt":
                args.prompt = value || DEFAULT_PROMPT;
                break;
            case "timeout-ms": {
                const n = Number(value);

                if (Number.isFinite(n) && n > 0) {
                    args.inputWaitMs = n;
                    args.responseWaitMs = n;
                }
                break;
            }
            default:
                break;
        }
    }

    if (args.reuse === null) {
        args.reuse = !args.newPage && !args.conversationId;
    }

    return args;
}
async function testProvider(name, options) {
    const { createProvider } = require(path.join(projectRoot, "providers", "index.js"));
    const agentConfig = require(path.join(projectRoot, "config", "agent-config.js"));
    const provider = createProvider(name, {
        autoStart: false,
        cdpUrl: agentConfig.browser.cdpUrl,
        chromePath: agentConfig.browser.chromePath,
        targetUrl: agentConfig.browser.targetUrls[name],
        reuseExistingPage: options.reuse === true,
        conversationId: options.conversationId || null,
        responseTimeout: options.responseWaitMs,
        responseInitialTimeout: options.responseWaitMs,
    });

    const originalWaitForInput = provider.waitForInput.bind(provider);

    provider.waitForInput = function (timeout) {
        const effective = timeout || options.inputWaitMs;
        return originalWaitForInput(effective);
    };

    const startedAt = Date.now();

    console.log("[live] Starting provider: " + name);
    console.log("[live] reuseExistingPage: " + provider.reuseExistingPage);
    console.log("[live] conversationId: " + (provider.conversationId || "(none)"));
    console.log("[live] Target URL: " + provider.buildTargetUrl());

    await provider.start();

    console.log("[live] Provider started in " + (Date.now() - startedAt) + "ms");
    console.log("[live] Page URL after start: " + (provider.page ? provider.page.url() : "(none)"));
    console.log("[live] Sending prompt: " + options.prompt);

    const response = await provider.send(options.prompt);

    console.log("[live] Provider: " + name);
    console.log("[live] Response length: " + response.length);
    console.log("[live] Response head:");
    console.log(response.length > 200 ? response.substring(0, 200) + "..." : response);

    console.log("[live] conversationId: " + (provider.currentConversationId || "(none)"));

    await provider.close();

    return {
        provider: name,
        ok: true,
        conversationId: provider.currentConversationId,
        responseLength: response.length,
        responseHead: response.substring(0, 100),
    };
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const targets = [];

    if (!args.provider || args.provider === "all") {
        targets.push("deepseek", "chatgpt", "qwen", "glm");
    } else if (
        args.provider === "deepseek" ||
        args.provider === "chatgpt" ||
        args.provider === "qwen" ||
        args.provider === "glm"
    ) {
        targets.push(args.provider);
    } else {
        console.error("Usage: node test/test-provider-live.js [deepseek|chatgpt|qwen|glm|all]");
        process.exitCode = 2;
        return;
    }

    const results = [];

    for (const name of targets) {
        try {
            const result = await testProvider(name, args);
            results.push(result);
        } catch (error) {
            console.error("[live] Provider " + name + " failed: " + error.message);

            results.push({
                provider: name,
                ok: false,
                error: error.message,
            });
        }
    }

    console.log("");
    console.log("========== Live Test Summary ==========");

    for (const result of results) {
        if (result.ok) {
            console.log(
                "[OK] " +
                    result.provider +
                    " | conversationId=" +
                    (result.conversationId || "(none)") +
                    " | responseLength=" +
                    result.responseLength +
                    " | head=" +
                    JSON.stringify(result.responseHead)
            );
        } else {
            console.log("[FAIL] " + result.provider + " | " + result.error);
        }
    }

    const failed = results.filter((r) => !r.ok);

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}
main().catch((error) => {
    console.error("[live] Fatal error:", error.message);
    process.exitCode = 1;
});
