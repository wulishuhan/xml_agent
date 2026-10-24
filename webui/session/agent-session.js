
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { Agent } = require("../../agent-core");
class AgentSession extends EventEmitter {
constructor({ workspace, provider = "chatgpt", task, conversationId = null, images = [] }) {
super();
if (!workspace) {
throw new Error("Workspace is required");
}
if (!task) {
throw new Error("Task is required");
}
// 程序内部 id，用于 WebUI 内部定位；与 provider 页面的会话 id 无关
this.id = crypto.randomUUID();
this.workspace = workspace;
this.provider = provider;
this.task = task;
// provider 页面的会话 id（DeepSeek/ChatGPT/Qwen URL 中的 id）
// 有值表示"继续已有会话"，无值表示"新会话"
this.conversationId = conversationId || null;
// 用户随任务附带的图片（相对 workspace 或绝对路径）。
// 进程重启后不会重新上传，因此仅作为运行时状态保留在内存。
this.images = Array.isArray(images) ? images.slice() : [];
this.agent = null;
this.output = [];
this.status = "created";
this.exitCode = null;
this.error = null;
this.createdAt = Date.now();
this.startedAt = null;
this.finishedAt = null;
// 记录本 session 内运行的次数（同一会话可多次运行，复用同一个 session）。
this.runCount = 0;
}
/**
从持久化数据恢复一个已经存在的会话实例。
只恢复可在进程重启后还原的状态；运行时字段（agent 等）不恢复。
恢复后的会话不会处于 running 状态（进程已重启，进程内的 Agent 已丢失）。
*/
restore(data) {
if (!data) {
return this;
}
if (typeof data.id === "string" && data.id) {
this.id = data.id;
}
if (Array.isArray(data.output)) {
this.output = data.output;
}
if (typeof data.status === "string") {
this.status = data.status;
}
if (data.conversationId) {
this.conversationId = data.conversationId;
}
if (typeof data.exitCode !== "undefined") {
this.exitCode = data.exitCode;
}
if (typeof data.error !== "undefined") {
this.error = data.error;
}
if (typeof data.createdAt === "number") {
this.createdAt = data.createdAt;
}
if (typeof data.startedAt === "number") {
this.startedAt = data.startedAt;
}
if (typeof data.finishedAt === "number") {
this.finishedAt = data.finishedAt;
}
if (typeof data.runCount === "number") {
this.runCount = data.runCount;
}
// 进程重启后，之前处于 running 的会话实际上已经中断
if (this.status === "running") {
this.status = "interrupted";
this.finishedAt = this.finishedAt || Date.now();
this.exitCode = this.exitCode === null ? 1 : this.exitCode;
}
return this;
}
addOutput(type, content, event = null) {
const record = {
id: crypto.randomUUID(),
type,
content,
timestamp: Date.now(),
};
if (event) {
record.event = event;
}
this.output.push(record);
this.emit("output", record);
return record;
}
handleAgentEvent(event) {
// provider.conversation 事件用于同步 provider 页面的会话 id，
// 不写入控制台，只更新 session 状态并广播给前端。
if (event.type === "provider.conversation") {
if (event.conversationId && event.conversationId !== this.conversationId) {
this.conversationId = event.conversationId;
this.emit("conversation", {
id: this.id,
conversationId: this.conversationId,
});
}
}
// 重要：runtime.result 里已经携带了 answer 的完整内容，
// 如果再把 answer 事件也写入 output，就会出现两条重复记录。
// 这里只广播事件，不再重复写入 output。
if (event.type === "answer") {
this.emit("agent.event", event);
return;
}
const content = this.formatEvent(event);
if (content !== null) {
this.addOutput(event.type.includes("error") ? "stderr" : "stdout", content, event);
}
this.emit("agent.event", event);
}
formatEvent(event) {
switch (event.type) {
case "agent.started":
return "🚀 Agent started";
case "step.started":
return "Agent step " + event.step;
case "provider.starting":
return "Starting provider: " + event.provider;
case "provider.started":
return "Provider started: " + event.provider;
case "provider.conversation":
return "Provider conversation id: " + event.conversationId;
case "provider.request":
return "Provider request (step " + event.step + ")";
case "provider.response":
return "Provider response received (" + event.length + " chars)";
case "provider.retry":
return (
"Provider retry (" +
event.count +
"/" +
event.max +
") after " +
event.delay +
"ms: " +
event.error
);
case "provider.error":
return "Provider error (" + event.count + "/" + event.max + "): " + event.error;
case "provider.closed":
return "Provider closed: " + event.provider;
case "provider.close_error":
return "Provider close error: " + event.error;
case "action.parsed":
return "XML action parsed: " + event.action;
case "action.parse_error":
return "XML parse error: " + event.error;
case "runtime.result":
return (
"Runtime action: " + event.action + "\n" + JSON.stringify(event.result, null, 2)
);
case "images.uploaded":
return (
"Images uploaded to model (" +
event.uploadCount +
"/" +
event.count +
")"
);
case "images.upload_skipped":
return "Images upload skipped: " + event.reason;
case "images.upload_error":
return "Images upload error: " + event.error;
case "images.missing":
return "Images missing (" + event.count + "): " + event.paths.join(", ");
case "agent.stopped":
return "⏹ Agent stopped by user";
case "agent.completed":
return "Agent completed with status: " + event.status;
case "agent.error":
return "Agent error: " + event.error;
default:
return null;
}
}
start() {
if (this.agent || this.status === "running") {
throw new Error("Agent session is already running");
}
this.status = "running";
this.startedAt = Date.now();
this.finishedAt = null;
this.exitCode = null;
this.error = null;
this.runCount += 1;
this.agent = new Agent({
workspace: this.workspace,
provider: this.provider,
task: this.task,
conversationId: this.conversationId,
images: this.images,
});
this.agent.on("event", (event) => {
this.handleAgentEvent(event);
});
this.addOutput("system", "🚀 Starting agent...");
this.run().catch(() => {
// run() already records the error and updates the session state.
});
return this;
}
/**
在同一个 session 内继续一次新的运行。
复用相同的 session id / conversationId，因此侧边栏不会新增会话。
追加新的运行输出（history 会累积多次回复）。
仅允许在非运行状态调用。
*/
resume(task, images) {
if (this.isRunning()) {
throw new Error("Agent session is already running");
}
if (typeof task === "string" && task.trim()) {
this.task = task.trim();
}
if (Array.isArray(images)) {
this.images = images.slice();
}
return this.start();
}
async run() {
if (!this.agent) {
throw new Error("Agent has not been created");
}
try {
const result = await this.agent.run();
if (this.status !== "stopped") {
this.status = result.status === "error" ? "error" : "completed";
}
// 从 result 中同步 conversationId
if (result.conversationId && result.conversationId !== this.conversationId) {
this.conversationId = result.conversationId;
this.emit("conversation", {
id: this.id,
conversationId: this.conversationId,
});
}
this.exitCode = this.status === "error" ? 1 : 0;
this.finishedAt = Date.now();
this.emit("finished", this.getInfo());
return result;
} catch (error) {
if (this.status !== "stopped") {
this.error = error.message;
this.status = "error";
this.exitCode = 1;
this.addOutput("stderr", "Agent process error: " + error.message);
this.emit("session.error", error);
}
this.finishedAt = Date.now();
this.emit("finished", this.getInfo());
throw error;
} finally {
this.agent = null;
}
}
async stop() {
if (!this.agent || this.status !== "running") {
throw new Error("Agent is not running");
}
const stopped = await this.agent.stop();
if (!stopped) {
return false;
}
this.status = "stopped";
this.finishedAt = Date.now();
this.addOutput("system", "⏹ Agent stopped by user");
return true;
}
isRunning() {
return this.status === "running" && this.agent !== null;
}
getOutput() {
return this.output;
}
getInfo() {
return {
id: this.id,
conversationId: this.conversationId,
workspace: this.workspace,
provider: this.provider,
task: this.task,
images: this.images.slice(),
status: this.status,
running: this.isRunning(),
pid: null,
exitCode: this.exitCode,
outputLength: this.output.length,
runCount: this.runCount,
createdAt: this.createdAt,
startedAt: this.startedAt,
finishedAt: this.finishedAt,
error: this.error,
};
}
}
module.exports = { AgentSession };
