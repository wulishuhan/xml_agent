const path = require("path");
const fs = require("fs");
const { createProvider } = require("../providers");
const { extractXML } = require("../parse/xml-parse");
const { buildWorkspaceManifest } = require("../workspace/manifest");
const { getFirstPrompt } = require("../prompts/first-prompt");
const {
    getRuntimeOkPrompt,
    getRuntimeErrorPrompt,
    getXmlErrorPrompt,
    getDonePrompt,
} = require("../prompts/index");
const { createRuntime } = require("../runtime");
const agentConfig = require("../config/agent-config");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEST_DIR = path.join(PROJECT_ROOT, "test-output-readme");

async function main() {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const srcReadme = fs.readFileSync(path.join(PROJECT_ROOT, "readme.md"), "utf8");
    fs.writeFileSync(path.join(TEST_DIR, "readme.md"), srcReadme, "utf8");
    fs.writeFileSync(
        path.join(TEST_DIR, "package.json"),
        JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2),
        "utf8"
    );

    const provider = createProvider("qwen", {
        autoStart: false,
        cdpUrl: agentConfig.browser.cdpUrl,
        chromePath: agentConfig.browser.chromePath,
        targetUrl: agentConfig.browser.targetUrls.qwen,
        reuseExistingPage: true,
        responseTimeout: 5 * 60 * 1000,
        responseInitialTimeout: 60 * 1000,
    });

    await provider.start();
    console.log("[test] connected:", provider.page ? provider.page.url() : "(none)");

    const runtime = createRuntime(TEST_DIR);
    const task =
        "更新 readme.md，在文件开头加一行说明：本文件由 XML Agent 自动更新。其他内容保持不变。";
    const manifest = buildWorkspaceManifest(TEST_DIR);

    let prompt = getFirstPrompt(TEST_DIR, manifest, task);
    let step = 0;
    const MAX_STEPS = 10;

    while (step < MAX_STEPS) {
        step++;
        console.log("\n\n========== STEP " + step + " ==========");

        let response;
        const t0 = Date.now();
        try {
            response = await provider.send(prompt);
        } catch (e) {
            console.log("[STEP " + step + "] SEND FAILED:", e.message);
            break;
        }
        console.log(
            "[STEP " + step + "] response length:",
            response.length,
            "elapsed:",
            Date.now() - t0,
            "ms"
        );

        console.log("[STEP " + step + "] ===== response head (first 500) =====");
        console.log(response.substring(0, 500));
        console.log("[STEP " + step + "] ===== response tail (last 200) =====");
        console.log(response.substring(Math.max(0, response.length - 200)));

        let action;
        try {
            action = extractXML(response);
            console.log("[STEP " + step + "] extractXML PASS:", action.action);
        } catch (e) {
            console.log("[STEP " + step + "] extractXML FAIL:", e.message);
            prompt = getXmlErrorPrompt(e);
            continue;
        }

        let result;
        try {
            result = await runtime.run(action);
        } catch (e) {
            result = { ok: false, action: "runtime_error", error: e.message };
        }

        console.log(
            "[STEP " + step + "] runtime result:",
            JSON.stringify({
                ok: result.ok,
                action: result.action,
                path: result.path,
                command: result.command,
                error: result.error,
                contentLength: result.content ? result.content.length : undefined,
            })
        );

        if (result.action === "answer" && result.ok) {
            console.log("[STEP " + step + "] ANSWER:", result.content);
            prompt = getDonePrompt();
            continue;
        }

        if (result.action === "done") {
            console.log("[STEP " + step + "] DONE");
            break;
        }

        if (result.ok === false) {
            prompt = getRuntimeErrorPrompt(result);
        } else {
            prompt = getRuntimeOkPrompt(result);
        }
    }

    await provider.close();

    // 校验 readme
    const finalReadme = fs.readFileSync(path.join(TEST_DIR, "readme.md"), "utf8");
    console.log("\n\n========== 最终 readme.md 前 300 字符 ==========");
    console.log(finalReadme.substring(0, 300));
    console.log("\n包含标记:", finalReadme.indexOf("本文件由 XML Agent 自动更新") !== -1);
}

main().catch((err) => {
    console.error("Fatal:", err && err.stack ? err.stack : err);
    process.exit(1);
});
