const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");

class AgentSession {
  constructor({ workspace, provider = "chatgpt", task }) {
    if (!workspace) {
      throw new Error("Workspace is required");
    }

    if (!task) {
      throw new Error("Task is required");
    }

    this.id = crypto.randomUUID();

    this.workspace = workspace;
    this.provider = provider;
    this.task = task;

    this.process = null;
    this.output = [];

    this.status = "created";
    this.exitCode = null;

    this.createdAt = Date.now();
    this.startedAt = null;
    this.finishedAt = null;
  }

  /**
   * 向 Session 输出中添加一条记录
   */
  addOutput(type, content) {
    this.output.push({
      type,
      content,
    });
  }

  /**
   * 启动 Agent
   */
  start() {
    if (this.process) {
      throw new Error("Agent session is already running");
    }

    if (!fs.existsSync(this.workspace)) {
      throw new Error("Workspace does not exist: " + this.workspace);
    }

    const projectRoot = path.join(__dirname, "..", "..");

    const args = ["agent.js", "--workspace", this.workspace, "--provider", this.provider, this.task];

    console.log(`[WebUI] Starting session ${this.id}: node ${args.join(" ")}`);

    this.addOutput("system", "🚀 Starting agent...");

    this.status = "running";
    this.startedAt = Date.now();
    this.exitCode = null;

    /**
     * 不使用 shell。
     *
     * process.execPath 就是当前 Node.js 可执行文件。
     * 这样比：
     *
     * spawn('node', ..., { shell: true })
     *
     * 更安全，也避免 task 中特殊字符被 shell 重新解析。
     */
    this.process = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    this.process.stdout.on("data", (data) => {
      const output = data.toString();

      console.log(`[Agent:${this.id}] ${output}`);

      this.addOutputLines("stdout", output);
    });

    this.process.stderr.on("data", (data) => {
      const output = data.toString();

      console.error(`[Agent:${this.id}] ${output}`);

      this.addOutputLines("stderr", output);
    });

    this.process.on("close", (code) => {
      this.exitCode = code;
      this.finishedAt = Date.now();

      if (this.status !== "stopped") {
        this.status = code === 0 ? "completed" : "error";
      }

      this.addOutput("system", `Agent exited with code ${code}`);

      console.log(`[WebUI] Session ${this.id} exited with code ${code}`);

      this.process = null;
    });

    this.process.on("error", (error) => {
      this.finishedAt = Date.now();
      this.status = "error";

      this.addOutput("stderr", "Agent process error: " + error.message);

      console.error(`[WebUI] Session ${this.id} process error:`, error);

      this.process = null;
    });

    return this;
  }

  /**
   * 将 stdout / stderr 按行保存
   */
  addOutputLines(type, output) {
    const lines = output.split("\n");

    for (const line of lines) {
      this.addOutput(type, line);
    }
  }

  /**
   * 停止 Agent
   */
  stop() {
    if (!this.process) {
      throw new Error("Agent process is not running");
    }

    this.addOutput("system", "⏹ Agent stopped by user");

    this.status = "stopped";

    /**
     * Windows 下 Node 子进程对 SIGINT 的支持和 Unix
     * 不完全一致，但保留 SIGINT 作为第一阶段的停止方式。
     */
    this.process.kill("SIGINT");
  }

  /**
   * 是否正在运行
   */
  isRunning() {
    return this.status === "running" && this.process !== null;
  }

  /**
   * 获取输出
   */
  getOutput() {
    return this.output;
  }

  /**
   * 获取 Session 信息
   *
   * 不直接把 ChildProcess 返回给 API。
   */
  getInfo() {
    return {
      id: this.id,
      workspace: this.workspace,
      provider: this.provider,
      task: this.task,

      status: this.status,
      running: this.isRunning(),

      pid: this.process ? this.process.pid : null,

      exitCode: this.exitCode,

      outputLength: this.output.length,

      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }
}

module.exports = {
  AgentSession,
};
