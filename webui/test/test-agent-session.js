const { AgentSession } = require("../session/agent-session");

let workspace = "D:/code/vue/ppl";
let provider = "deepseek";
let task = "这是什么项目";

const session = new AgentSession({
  workspace,
  provider: provider || "chatgpt",
  task,
});

console.log("get seesion id:", session.id);

/**
 * 启动 Agent
 */
try {
  session.start();

  console.log(`[WebUI] Session started: ${session.id}`);
} catch (error) {
  console.error(`[WebUI] Failed to start session ${session.id}:`, error);
}
