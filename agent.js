const { createProvider } = require("./providers");
const { getFirstPrompt, getXmlErrorPrompt, getDonePrompt, getRuntimeErrorPrompt, getRuntimeOkPrompt } = require("./prompts/index");
const { run, setWorkspace, getWorkspace } = require("./runtime");
const { buildWorkspaceManifest } = require("./workspace/manifest");
const { history, createHistoryRecord, saveHistory } = require("./workspace/history");
const { saveReport } = require("./workspace/report");
const { extractXML } = require("./parse/xml-parse");

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

    const MAX_PROVIDER_ERRORS = 3;

    let providerErrorCount = 0;

    while (step < MAX_STEPS) {
      step++;

      console.log("");
      console.log("================================");
      console.log(`Agent Step ${step}`);
      console.log("================================");

      let response;

      try {
        response = await provider.send(prompt);

        providerErrorCount = 0;
      } catch (error) {
        providerErrorCount++;

        console.error("Provider Error:");
        console.error(error.message);

        console.error(
          `Provider error count: ${providerErrorCount}/${MAX_PROVIDER_ERRORS}`
        );

        if (providerErrorCount >= MAX_PROVIDER_ERRORS) {
          console.error("Maximum Provider errors reached.");

          break;
        }
        prompt = `
        上一轮 Agent 调用模型时发生错误。

        错误信息：

        ${error.message}

        请继续完成用户任务。

        不要假设上一轮已经成功执行。
        不要编造 Runtime 结果。

        请重新输出一个 XML Action。
        `;

        continue;
      }

      console.log("");

      console.log(response);



      console.log("");

      let action;

      try {
        response = await provider.send(prompt);
        action = extractXML(response);
      } catch (error) {
        console.error(error.message);

        prompt = getXmlErrorPrompt(error);

        continue;
      }

      /**
       * Runtime
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
       * History
       */

      history.push(createHistoryRecord(step, action, result));

      /**
       * answer
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
       * done
       */

      if (result.action === "done") {
        console.log("Agent requested done.");
        break;
      }

      /**
       * Runtime Error
       */

      if (result.ok === false) {
        prompt = getRuntimeErrorPrompt(result);

        continue;
      }

      /**
       * 正常 Runtime Result
       */

      prompt = getRuntimeOkPrompt(result);
    }

    /**
     * MAX STEPS
     */

    if (step >= MAX_STEPS) {
      console.log("Maximum Agent steps reached.");
    }
  } finally {
    /**
     * 不关闭 Chrome
     */

    await provider.close();
    /**
     * 保存 History
     */

    const historyPath = saveHistory(currentWorkspace);

    /**
     * 保存 Report
     */

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
