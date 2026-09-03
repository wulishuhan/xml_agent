const { createProvider } = require("./providers");
const { getFirstPrompt, getXmlErrorPrompt, getDonePrompt, getRuntimeErrorPrompt, getRuntimeOkPrompt } = require("./prompts/index");
const { run, setWorkspace, getWorkspace } = require("./runtime");
const { buildWorkspaceManifest } = require("./workspace/manifest");
const { history, createHistoryRecord, saveHistory } = require("./workspace/history");
const { saveReport } = require("./workspace/report");
const { extractXML } = require("./parse/xml-parse");

/**
 * ============================================================
 * Command Line Arguments
 * ============================================================
 * 使用方式：
 * node agent.js --workspace "D:\\project\\my-project" "这是个什么项目"
 * 也支持：
 * node agent.js --workspace=D:\\project\\my-project "这是个什么项目"
 */

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

/**
 * ============================================================
 * Main Agent
 * ============================================================
 */

async function main() {
  /**
   * 解析：
   *
   * --workspace
   *
   * 和：
   *
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

  /**
   * ==========================================================
   * Browser
   * ==========================================================
   */

  const provider = createProvider(providerName);

  await provider.start();

  try {
    let prompt = getFirstPrompt(currentWorkspace, manifest, task);

    let step = 0;

    const MAX_STEPS = 50;

    while (step < MAX_STEPS) {
      step++;

      console.log("");

      console.log("================================");

      console.log(`Agent Step ${step}`);

      console.log("================================");

      const response = await provider.send(prompt);

      console.log("");

      console.log(response);

      let xml;

      try {
        xml = extractXML(response);
      } catch (error) {
        console.error("XML Parse Error:");

        console.error(error.message);

        prompt = getXmlErrorPrompt(error);

        continue;
      }

      console.log("XML Action:");

      console.log(xml);

      /**
       * ======================================================
       * Runtime
       * ======================================================
       */

      let result;

      try {
        result = run(xml);
      } catch (error) {
        console.error("");

        console.error("Runtime Error:");

        console.error(error.message);

        result = {
          ok: false,
          action: "runtime_error",
          error: error.message,
        };
      }

      console.log("");

      console.log("Runtime Result:");

      console.log(JSON.stringify(result, null, 2));

      /**
       * ======================================================
       * History
       * ======================================================
       */

      history.push(createHistoryRecord(step, xml, result));

      /**
       * ======================================================
       * answer
       * ======================================================
       */

      if (result.action === "answer" && result.ok) {
        console.log("");

        console.log("================================");

        console.log("Agent Answer");

        console.log("================================");

        console.log("");

        console.log(result.content);

        /**
         * answer 已经成功生成,下一轮只要求 done。
         */

        prompt = getDonePrompt();

        continue;
      }

      /**
       * ======================================================
       * done
       * ======================================================
       */

      if (result.action === "done") {
        console.log("");

        console.log("Agent requested done.");

        break;
      }

      /**
       * ======================================================
       * Runtime Error
       * ======================================================
       */

      if (result.ok === false) {
        prompt = getRuntimeErrorPrompt(result);

        continue;
      }

      /**
       * ======================================================
       * 正常 Runtime Result
       * ======================================================
       */

      prompt = getRuntimeOkPrompt(result);
    }

    /**
     * ========================================================
     * MAX STEPS
     * ========================================================
     */

    if (step >= MAX_STEPS) {
      console.log("");

      console.log("Maximum Agent steps reached.");
    }
  } finally {
    /**
     * ========================================================
     * 不关闭 Chrome
     * ========================================================
     */

    await provider.close();
    /**
     * ========================================================
     * 保存 History
     * ========================================================
     */

    const historyPath = saveHistory(currentWorkspace);

    /**
     * ========================================================
     * 保存 Report
     * ========================================================
     */

    const reportPath = saveReport(task, currentWorkspace);

    console.log("");

    console.log("================================");

    console.log("Agent Files");

    console.log("================================");

    console.log("Workspace:", currentWorkspace);

    console.log("History:", historyPath);

    console.log("Report:", reportPath);

    console.log("");
  }
}

/**
 * ============================================================
 * Start
 * ============================================================
 */

main()
  .then(() => {
    console.log("");

    console.log("Node Agent finished.");

    process.exit(0);
  })
  .catch((error) => {
    console.error("");

    console.error("Agent Error:");

    console.error(error);

    process.exit(1);
  });
