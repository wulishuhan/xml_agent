const fs = require("fs");
const path = require("path");

const { ChatGPTBrowser } = require("./browser");

const { run, setWorkspace, getWorkspace } = require("./runtime");

/**
 * ============================================================
 * Agent System Prompt
 * ============================================================
 */

const SYSTEM_PROMPT = `
你是一个运行在 Node.js Runtime 上的工程型 AI Agent。

你的任务不是直接修改电脑，而是：

1. 分析用户任务
2. 通过 XML Action 操作 Workspace
3. 根据 Runtime 返回结果继续工作
4. 最后通过 <answer> 返回真正的用户答案
5. 最后通过 <done/> 结束任务

============================================================
可用 XML Action
============================================================

1. 读取文件或者目录

<read path="package.json"/>

<read path="src"/>

---

2. 写入文件

<write path="src/example.js"><![CDATA[
console.log("hello");
]]></write>

注意：

- write 会自动创建父目录
- 不需要 mkdir
- 内容必须放在 CDATA 中

---

3. 执行命令

<exec command="npm test"/>

<exec command="node src/app.js"/>

---

4. 返回最终答案

<answer><![CDATA[
这里是给用户看的最终答案。
可以使用 Markdown。
]]></answer>

---

5. 结束 Agent

<done/>

============================================================
重要规则
============================================================

1. 你每次只能输出一个 XML Action。

2. 不允许输出 XML Action 之外的解释。

3. 不要使用 Markdown 代码块包裹 XML。

4. 如果需要了解项目结构，先使用 <read>。

5. 如果需要查看文件内容，使用 <read>。

6. 如果需要修改或者创建文件，使用 <write>。

7. 如果需要运行程序、测试或者命令，使用 <exec>。

8. Runtime 会把执行结果返回给你。

9. 必须根据 Runtime 的真实结果继续工作。

10. 不允许假设没有读取过的文件内容。

11. 不允许编造 Runtime 执行结果。

12. 如果 Runtime 返回错误，你应该分析错误并尝试修复。

13. 如果缺少依赖，可以使用 <exec> 安装依赖。

14. 不要因为项目比较大就一次读取所有文件。
    应该根据任务逐步探索。

15. 当前 Workspace 是一个已经存在的项目时，
    不要随意重建项目。

16. 优先理解现有项目，再进行修改。

17. 如果用户要求修改项目：
    修改完成后应该进行必要的验证。

18. 如果用户要求运行程序：
    使用 <exec>。

19. 如果用户要求解释、分析、介绍、总结或者回答问题，
    在完成必要的 read/exec 后，
    必须使用 <answer> 返回最终答案。

20. <answer> 是给用户看的最终答案。

21. <answer> 中可以使用 Markdown。

22. <answer> 必须直接回答用户的问题。

23. 不要只在 <answer> 中描述：
    "我执行了 read..."
    "我执行了 exec..."
    而应该真正回答用户的问题。

24. 如果用户要求修改项目，
    在完成修改和验证后，
    也应该使用 <answer> 简要说明：

    - 修改了什么
    - 修改了哪些文件
    - 验证结果

25. <done/> 只表示 Agent 生命周期结束。

26. <done/> 不能代替 <answer>。

27. 如果需要向用户返回答案：
    必须先输出 <answer>，
    然后再输出 <done/>。

28. 如果任务已经完成，
    但是不需要向用户返回额外说明，
    可以直接输出 <done/>。

29. answer 必须基于实际读取到的文件和 Runtime 返回结果。

30. 不允许编造项目结构、代码、测试结果或者运行结果。

31. 如果 read 一个目录，只能根据 Runtime 返回的 entries
    决定下一步读取哪些文件。

32. 如果用户的问题可以通过已经获得的信息回答，
    不需要继续读取无关文件。

============================================================
XML 示例
============================================================

读取：

<read path="package.json"/>

写入：

<write path="src/test.js"><![CDATA[
console.log("hello");
]]></write>

执行：

<exec command="npm test"/>

回答：

<answer><![CDATA[
这是一个 Node.js MVC 后端管理系统。
]]></answer>

结束：

<done/>

============================================================
当前目标
============================================================

请认真完成用户的任务。

记住：

read/write/exec = 工作工具

answer = 给用户最终答案

done = 结束 Agent
`;

/**
 * ============================================================
 * Command Line Arguments
 * ============================================================
 *
 * 使用方式：
 *
 * node agent.js --workspace "D:\\project\\my-project" "这是个什么项目"
 *
 * 也支持：
 *
 * node agent.js --workspace=D:\\project\\my-project "这是个什么项目"
 */

function parseArgs(argv) {
  let workspace = null;
  const taskParts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    /**
     * --workspace D:\project
     */
    if (arg === "--workspace") {
      if (i + 1 >= argv.length) {
        throw new Error("--workspace requires a path");
      }

      workspace = argv[++i];
      continue;
    }

    /**
     * --workspace=D:\project
     */
    if (arg.startsWith("--workspace=")) {
      workspace = arg.substring("--workspace=".length);

      if (!workspace) {
        throw new Error("--workspace requires a path");
      }

      continue;
    }

    /**
     * 其余参数全部作为任务
     */
    taskParts.push(arg);
  }

  const task = taskParts.join(" ").trim();

  if (!workspace) {
    throw new Error("Workspace is required.\n\n" + "Usage:\n" + 'node agent.js --workspace "D:\\\\project\\\\my-project" "你的任务"');
  }

  if (!task) {
    throw new Error("Task is required.\n\n" + "Usage:\n" + 'node agent.js --workspace "D:\\\\project\\\\my-project" "你的任务"');
  }

  return {
    workspace: path.resolve(workspace),
    task,
  };
}

/**
 * ============================================================
 * Workspace Manifest
 * ============================================================
 *
 * 注意：
 *
 * Manifest 扫描的是用户指定的 Workspace，
 * 而不是 Agent 自己所在的目录。
 *
 * 这里仍然只扫描第一层。
 *
 * 大型项目通过 <read> 按需探索。
 */

function buildWorkspaceManifest(dir) {
  const entries = [];

  const ignoredDirs = new Set(["node_modules", ".git", ".agent", "browser-profile", "browser_data", "chrome-profile", "chrome_data"]);

  let items;

  try {
    items = fs.readdirSync(dir, {
      withFileTypes: true,
    });
  } catch (error) {
    return entries;
  }

  items.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of items) {
    if (item.isDirectory() && ignoredDirs.has(item.name)) {
      continue;
    }

    if (item.isDirectory()) {
      entries.push(`${item.name}/`);
    } else {
      entries.push(item.name);
    }
  }

  return entries;
}

/**
 * ============================================================
 * History
 * ============================================================
 */

const history = [];

/**
 * 创建 History Record
 */
function createHistoryRecord(step, xml, result) {
  return {
    step,
    timestamp: new Date().toISOString(),
    xml,
    result,
  };
}

/**
 * ============================================================
 * Save History
 * ============================================================
 */

function saveHistory() {
  const workspace = getWorkspace();

  const agentDir = path.join(workspace, ".agent");

  fs.mkdirSync(agentDir, {
    recursive: true,
  });

  const historyPath = path.join(agentDir, "history.json");

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf8");

  return historyPath;
}

/**
 * ============================================================
 * Build Report
 * ============================================================
 */

function buildReport(task) {
  const lines = [];

  lines.push("# Agent Execution Report");

  lines.push("");

  lines.push("## Workspace");

  lines.push("");

  lines.push(getWorkspace());

  lines.push("");

  lines.push("## 任务");

  lines.push("");

  lines.push(task);

  lines.push("");

  lines.push("## 执行记录");

  lines.push("");

  if (history.length === 0) {
    lines.push("没有执行任何 Action。");
  }

  for (const item of history) {
    const result = item.result || {};

    lines.push(`### Step ${item.step} - ${result.action || "unknown"}`);

    lines.push("");

    lines.push(`时间：${item.timestamp}`);

    lines.push("");

    lines.push("XML：");

    lines.push("");

    lines.push("```xml");

    lines.push(item.xml);

    lines.push("```");

    lines.push("");

    /**
     * read
     */
    if (result.action === "read") {
      if (result.ok) {
        lines.push(`读取成功：\`${result.path}\``);

        if (result.type === "directory") {
          lines.push("");

          lines.push("目录内容：");

          for (const entry of result.entries || []) {
            lines.push(`- ${entry}`);
          }
        }
      } else {
        lines.push(`读取失败：${result.error || "unknown error"}`);
      }
    }

    /**
     * write
     */
    if (result.action === "write") {
      if (result.ok) {
        lines.push(`写入成功：\`${result.path}\``);
      } else {
        lines.push(`写入失败：${result.error || "unknown error"}`);
      }
    }

    /**
     * exec
     */
    if (result.action === "exec") {
      if (result.ok) {
        lines.push(`命令执行成功：\`${result.command}\``);
      } else {
        lines.push(`命令执行失败：\`${result.command}\``);

        if (result.error) {
          lines.push("");

          lines.push("错误：");

          lines.push("```text");

          lines.push(result.error);

          lines.push("```");
        }
      }

      if (result.stdout) {
        lines.push("");

        lines.push("stdout：");

        lines.push("```text");

        lines.push(result.stdout);

        lines.push("```");
      }

      if (result.stderr) {
        lines.push("");

        lines.push("stderr：");

        lines.push("```text");

        lines.push(result.stderr);

        lines.push("```");
      }
    }

    /**
     * answer
     */
    if (result.action === "answer") {
      lines.push("");

      lines.push("最终回答：");

      lines.push("");

      lines.push(result.content || "");
    }

    /**
     * done
     */
    if (result.action === "done") {
      lines.push("Agent 已结束。");
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * ============================================================
 * Save Report
 * ============================================================
 */

function saveReport(task) {
  const workspace = getWorkspace();

  const agentDir = path.join(workspace, ".agent");

  fs.mkdirSync(agentDir, {
    recursive: true,
  });

  const reportPath = path.join(agentDir, "report.md");

  const report = buildReport(task);

  fs.writeFileSync(reportPath, report, "utf8");

  return reportPath;
}

/**
 * ============================================================
 * XML Extractor
 * ============================================================
 */

function extractXML(response) {
  if (!response) {
    throw new Error("ChatGPT returned empty response");
  }

  let text = response.trim();

  /**
   * 去掉 Markdown XML 代码块
   */
  text = text.replace(/^```xml\s*/i, "");

  text = text.replace(/^```\s*/, "");

  text = text.replace(/\s*```$/i, "");

  text = text.trim();

  /**
   * read
   */
  if (text.startsWith("<read")) {
    if (!text.includes("/>")) {
      throw new Error("Incomplete read XML");
    }

    return text;
  }

  /**
   * write
   */
  if (text.startsWith("<write")) {
    if (!text.includes("<![CDATA[")) {
      throw new Error("Write XML missing CDATA");
    }

    if (!text.includes("]]></write>")) {
      throw new Error("Incomplete write XML");
    }

    return text;
  }

  /**
   * exec
   */
  if (text.startsWith("<exec")) {
    if (!text.includes("/>")) {
      throw new Error("Incomplete exec XML");
    }

    return text;
  }

  /**
   * answer
   */
  if (text.startsWith("<answer")) {
    if (!text.includes("<![CDATA[")) {
      throw new Error("Answer XML missing CDATA");
    }

    if (!text.includes("]]></answer>")) {
      throw new Error("Incomplete answer XML");
    }

    return text;
  }

  /**
   * done
   */
  if (text.startsWith("<done")) {
    if (!text.includes("<done/>") && !text.includes("<done />")) {
      throw new Error("Incomplete done XML");
    }

    return text;
  }

  throw new Error("ChatGPT did not return a supported XML Action.\n\n" + "Response:\n" + response);
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
  const { workspace, task } = parseArgs(process.argv.slice(2));

  /**
   * ==========================================================
   * 设置 Workspace
   * ==========================================================
   */

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

  /**
   * ==========================================================
   * Workspace Manifest
   * ==========================================================
   */

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

  const browser = new ChatGPTBrowser();

  await browser.start();

  try {
    /**
     * ========================================================
     * 第一轮 Prompt
     * ========================================================
     */

    let prompt = `
${SYSTEM_PROMPT}

============================================================
Workspace
============================================================

${currentWorkspace}

============================================================
Workspace Manifest
============================================================

${manifest.join("\n")}

============================================================
用户任务
============================================================

${task}

============================================================
现在开始工作
============================================================

请严格按照 XML Action 协议执行。

如果需要查看项目，先使用 read。

如果任务最终需要回答用户，
完成分析后必须使用：

<answer><![CDATA[
你的最终答案
]]></answer>

最后使用：

<done/>
`;

    let step = 0;

    const MAX_STEPS = 50;

    while (step < MAX_STEPS) {
      step++;

      console.log("");

      console.log("================================");

      console.log(`Agent Step ${step}`);

      console.log("================================");

      /**
       * ======================================================
       * 发送 Prompt
       * ======================================================
       */

      const response = await browser.send(prompt);

      console.log("");

      console.log("ChatGPT:");

      console.log(response);

      /**
       * ======================================================
       * 解析 XML
       * ======================================================
       */

      let xml;

      try {
        xml = extractXML(response);
      } catch (error) {
        console.error("");

        console.error("XML Parse Error:");

        console.error(error.message);

        prompt = `
你的上一条回复不是合法的 XML Action。

错误：

${error.message}

请不要解释。

请严格只输出一个合法 XML Action。

例如：

<read path="package.json"/>

或者：

<answer><![CDATA[
最终答案
]]></answer>

或者：

<done/>
`;

        continue;
      }

      console.log("");

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
         * answer 已经成功生成。
         *
         * 下一轮只要求 done。
         */

        prompt = `
用户答案已经成功生成。

最终答案已经显示给用户。

现在结束 Agent 生命周期。

只输出：

<done/>
`;

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
        prompt = `
Runtime 执行失败。

下面是 Runtime 的真实返回结果：

${JSON.stringify(result, null, 2)}

请分析这个错误。

如果可以修复：

1. 修复问题
2. 必要时再次执行验证

如果不能修复：

使用 <answer> 告诉用户真实错误。

不要编造 Runtime 结果。

只输出一个 XML Action。
`;

        continue;
      }

      /**
       * ======================================================
       * 正常 Runtime Result
       * ======================================================
       */

      prompt = `
上一轮 Runtime 已经执行完成。

Runtime 返回：

${JSON.stringify(result, null, 2)}

请根据这个真实结果继续完成用户任务。

如果还需要读取文件：

使用 <read>

如果需要修改文件：

使用 <write>

如果需要运行命令：

使用 <exec>

如果已经可以回答用户：

使用：

<answer><![CDATA[
最终答案
]]></answer>

如果已经完成并且不需要回答：

使用：

<done/>

只输出一个 XML Action。
`;
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

    await browser.close();

    /**
     * ========================================================
     * 保存 History
     * ========================================================
     */

    const historyPath = saveHistory();

    /**
     * ========================================================
     * 保存 Report
     * ========================================================
     */

    const reportPath = saveReport(task);

    console.log("");

    console.log("================================");

    console.log("Agent Files");

    console.log("================================");

    console.log("Workspace:", getWorkspace());

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
