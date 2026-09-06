
const { createProvider } = require("./providers");
const { getFirstPrompt, getXmlErrorPrompt, getDonePrompt, getRuntimeErrorPrompt, getRuntimeOkPrompt, getSendErrorPrompt } = require("./prompts/index");
const { run, setWorkspace, getWorkspace } = require("./runtime");
const { buildWorkspaceManifest } = require("./workspace/manifest");
const { history, createHistoryRecord, saveHistory } = require("./workspace/history");
const { saveReport } = require("./workspace/report");
const { extractXML } = require("./parse/xml-parse");
const agentConfig = require("./config/agent-config");

function parseArgs() {
    const args = process.argv.slice(2);

    let workspace = null;
    let provider = "chatgpt";
    let background = false;
    const taskParts = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--workspace") {
            workspace = args[++i];
            continue;
        }

        if (arg.startsWith("--workspace=")) {
            workspace = arg.substring("--workspace=".length);
            continue;
        }

        if (arg === "--provider") {
            provider = args[++i];
            continue;
        }

        if (arg.startsWith("--provider=")) {
            provider = arg.substring("--provider=".length);
            continue;
        }

        if (arg === "--background") {
            background = true;
            continue;
        }

        taskParts.push(arg);
    }

    return {
        workspace,
        provider,
        task: taskParts.join(" ").trim(),
        background,
    };
}

async function runStep({ provider, prompt, step, history, providerErrorState }) {
    let response;

    console.log("[AGENT_STEP] Step " + step + " starting");
    console.log("[PROVIDER] Sending prompt to provider...");

    try {
        response = await provider.send(prompt);

        providerErrorState.count = 0;

        console.log("[AI_RESPONSE] Received response from provider");
        console.log("[AI_RESPONSE] Response length: " + (response ? response.length : 0));
    } catch (error) {
        providerErrorState.count++;

        console.error("");
        console.error("Provider Error:");
        console.error(error.message);

        console.error("Provider error count: " + providerErrorState.count + "/" + providerErrorState.max);

        if (providerErrorState.count >= providerErrorState.max) {
            return {
                stop: true,
                prompt: null,
            };
        }

        return {
            stop: false,
            prompt: getSendErrorPrompt(error),
        };
    }

    console.log("");
    console.log("[AI_RESPONSE] Full response:");
    console.log(response);

    let action;

    console.log("[XML_ACTION] Parsing XML from response...");

    try {
        action = extractXML(response);
        console.log("[XML_ACTION] Parsed action: " + JSON.stringify(action));
    } catch (error) {
        console.error("XML Error:");
        console.error(error.message);

        return {
            stop: false,
            prompt: getXmlErrorPrompt(error),
        };
    }

    let result;

    console.log("[RUNTIME_STATUS] Executing action: " + action.action);

    try {
        result = run(action);
        console.log("[RUNTIME_STATUS] Result: " + JSON.stringify(result));
    } catch (error) {
        console.error("Runtime Error:");
        console.error(error.message);

        result = {
            ok: false,
            action: "runtime_error",
            error: error.message,
        };
    }

    console.log("Runtime Result:");
    console.log(JSON.stringify(result, null, 2));

    history.push(createHistoryRecord(step, action, result));

    if (result.action === "answer" && result.ok) {
        console.log("");
        console.log("================================");
        console.log("Agent Answer");
        console.log("================================");
        console.log("");

        console.log(result.content);

        return {
            stop: false,
            prompt: getDonePrompt(),
        };
    }

    if (result.action === "done") {
        console.log("Agent requested done.");

        return {
            stop: true,
            prompt: null,
        };
    }

    if (result.ok === false) {
        return {
            stop: false,
            prompt: getRuntimeErrorPrompt(result),
        };
    }

    return {
        stop: false,
        prompt: getRuntimeOkPrompt(result),
    };
}

async function main() {
    const { workspace, task, provider: providerName, background } = parseArgs();

    if (background) {
        process.on('SIGINT', function () {
            console.log('Received SIGINT in background mode, ignoring...');
        });
        console.log('[SYSTEM] Running in background mode');
    }

    setWorkspace(workspace);

    const currentWorkspace = getWorkspace();

    console.log("");
    console.log("================================");
    console.log("XML Agent");
    console.log("================================");
    console.log("");
    console.log("[SYSTEM] Workspace:");
    console.log("[SYSTEM] " + currentWorkspace);
    console.log("");
    console.log("[SYSTEM] User Task:");
    console.log("[SYSTEM] " + task);
    console.log("");

    const manifest = buildWorkspaceManifest(currentWorkspace);

    console.log("[SYSTEM] Workspace files:");
    for (var i = 0; i < manifest.length; i++) {
        console.log("[SYSTEM] " + manifest[i]);
    }
    console.log("");

    console.log("[PROVIDER] Creating provider: " + providerName);

    const provider = createProvider(providerName, {
        autoStart: agentConfig.browser.autoStart,
        startTimeout: agentConfig.browser.startTimeout,
        retryInterval: agentConfig.browser.retryInterval,
        chromePath: agentConfig.browser.chromePath,
        targetUrl: agentConfig.browser.targetUrls[providerName]
    });

    console.log("[PROVIDER] Starting provider...");
    await provider.start();
    console.log("[PROVIDER] Provider started successfully");

    try {
        let prompt = getFirstPrompt(currentWorkspace, manifest, task);
        let step = 0;
        var MAX_STEPS = agentConfig.agent.maxSteps;
        var MAX_PROVIDER_ERRORS = agentConfig.agent.maxProviderErrors;
        const providerErrorState = {
            count: 0,
            max: MAX_PROVIDER_ERRORS,
        };

        while (step < MAX_STEPS) {
            step++;

            console.log("");
            console.log("================================");
            console.log("[AGENT_STEP] Step " + step);
            console.log("================================");

            const stepResult = await runStep({
                provider: provider,
                prompt: prompt,
                step: step,
                history: history,
                providerErrorState: providerErrorState,
            });

            if (stepResult.stop) {
                break;
            }

            prompt = stepResult.prompt;
        }

    } finally {
        console.log("[SYSTEM] Closing provider...");
        await provider.close();

        const historyPath = saveHistory(currentWorkspace);
        const reportPath = saveReport(task, currentWorkspace);

        console.log("================================");
        console.log("[SYSTEM] Agent Files");
        console.log("================================");
        console.log("[SYSTEM] Workspace:", currentWorkspace);
        console.log("[SYSTEM] History:", historyPath);
        console.log("[SYSTEM] Report:", reportPath);
    }
}

main()
    .then(function () {
        console.log("[SYSTEM] Node Agent finished.");
        process.exit(0);
    })
    .catch(function (error) {
        console.error("[SYSTEM] Agent Error:");
        console.error(error);
        process.exit(1);
    });
