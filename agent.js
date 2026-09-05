const { createProvider } = require("./providers");
const { getFirstPrompt, getXmlErrorPrompt, getDonePrompt, getRuntimeErrorPrompt, getRuntimeOkPrompt, getSendErrorPrompt } = require("./prompts/index");
const { run, setWorkspace, getWorkspace } = require("./runtime");
const { buildWorkspaceManifest } = require("./workspace/manifest");
const { history, createHistoryRecord, saveHistory } = require("./workspace/history");
const { saveReport } = require("./workspace/report");
const { extractXML } = require("./parse/xml-parse");
const agentConfig = require("./config/agent-config");
// 获取命令行参数
function parseArgs() {
  const args = process.argv.slice(2);

  let workspace = null;
  let provider = "chatgpt";
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

    taskParts.push(arg);
  }

  return {
    workspace,
    provider,
    task: taskParts.join(" ").trim(),
  };
}

async function runStep({ provider, prompt, step, history, providerErrorState, }) {

  let response;

  try {
    response = await provider.send(prompt);

    // Provider 成功，重置连续错误次数
    providerErrorState.count = 0;
  } catch (error) {
    providerErrorState.count++;

    console.error("");
    console.error("Provider Error:");
    console.error(error.message);

    console.error(
      `Provider error count: ${providerErrorState.count}/${providerErrorState.max}`
    );

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
  console.log(response);

  /**
   * ==========================================================
   * XML Parser
   * ==========================================================
   */

  let action;

  try {
    action = extractXML(response);
  } catch (error) {
    console.error("XML Error:");
    console.error(error.message);

    return {
      stop: false,
      prompt: getXmlErrorPrompt(error),
    };
  }

  /**
   * ==========================================================
   * Runtime
   * ==========================================================
   */

  let result;

  try {
    result = run(action);
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

  /**
   * ==========================================================
   * History
   * ==========================================================
   */

  history.push(createHistoryRecord(step, action, result));

  /**
   * ==========================================================
   * answer
   * ==========================================================
   */

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

  /**
   * ==========================================================
   * done
   * ==========================================================
   */

  if (result.action === "done") {
    console.log("Agent requested done.");

    return {
      stop: true,
      prompt: null,
    };
  }

  /**
   * ==========================================================
   * Runtime Error
   * ==========================================================
   */

  if (result.ok === false) {
    return {
      stop: false,
      prompt: getRuntimeErrorPrompt(result),
    };
  }

  /**
   * ==========================================================
   * 正常 Runtime Result
   * ==========================================================
   */

  return {
    stop: false,
    prompt: getRuntimeOkPrompt(result),
  };
}

/**
 * Main Agent
 */

async function main() {
  /**
   * 解析：
   * --workspace
   * 和：
   * 用户任务
   */
  const { workspace, task, provider: providerName } = parseArgs();

  setWorkspace(workspace);

  const currentWorkspace = getWorkspace();

  console.log("");

  console.log("================================");

  console.log("XML Agent");

  console.log("================================");

  console.log("");

  console.log("Workspace:");

  console.log(currentWorkspace);

  console.log("");

  console.log("User Task:");

  console.log(task);

  console.log("");

  const manifest = buildWorkspaceManifest(currentWorkspace);

  console.log("Workspace files:");

  for (const entry of manifest) {
    console.log("  " + entry);
  }

  console.log("");

  const provider = createProvider(providerName);

  await provider.start();

  try {
    let prompt = getFirstPrompt(currentWorkspace, manifest, task);
    let step = 0;
    const MAX_STEPS = agentConfig.agent.maxSteps;
    const MAX_PROVIDER_ERRORS = agentConfig.agent.maxProviderErrors;
    const providerErrorState = {
      count: 0,
      max: MAX_PROVIDER_ERRORS,
    };

    while (step < MAX_STEPS) {
      step++;

      console.log("");
      console.log("================================");
      console.log(`Agent Step ${step}`);
      console.log("================================");

      const stepResult = await runStep({
        provider,
        prompt,
        step,
        history,
        providerErrorState,
      });

      if (stepResult.stop) {
        break;
      }

      prompt = stepResult.prompt;
    }

  } finally {

    await provider.close();

    const historyPath = saveHistory(currentWorkspace);

    const reportPath = saveReport(task, currentWorkspace);

    console.log("================================");

    console.log("Agent Files");

    console.log("================================");

    console.log("Workspace:", currentWorkspace);

    console.log("History:", historyPath);

    console.log("Report:", reportPath);
  }
}

/**
 * Start
 */

main()
  .then(() => {
    console.log("Node Agent finished.");

    process.exit(0);
  })
  .catch((error) => {
    console.error("Agent Error:");

    console.error(error);

    process.exit(1);
  });
