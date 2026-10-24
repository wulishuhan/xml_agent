
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const browserSettings = require("../webui/browser-settings");
const { Agent } = require("../agent-core");
// 复现桌面端场景：images 使用本地绝对路径（C:\Users\hunte\Desktop\img_test\1.png 等），
// 验证 Agent 在 provider.start() 后、第一条 prompt 前，是否能把这些绝对路径图片上传给 DeepSeek。
//
// 这个测试专门用来定位"桌面端选图后只发了提示词、没发图片"的问题：
// - 如果 images.missing 出现 -> 说明绝对路径在 Node 侧不存在（路径/权限/清理）
// - 如果 images.upload_error 出现 -> 说明 DeepSeek uploadImages 失败（按钮/缩略图校验）
// - 如果 images.uploaded 且 uploadCount=2 -> 说明后端链路正常，问题在前端没把路径传进来
const IMAGE_DIR = "C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "hunte" + String.fromCharCode(92) + "Desktop" + String.fromCharCode(92) + "img_test";
async function ensureCdp() {
const settings = browserSettings.readSettings();
const status = await browserSettings.getStatus();
console.log("[cdp] browserType=" + settings.browserType + " cdpUrl=" + status.cdpUrl);
console.log("[cdp] running=" + status.cdpRunning);
if (status.cdpRunning) {
return status;
}
const launched = await browserSettings.ensureBrowserCdp(settings);
console.log("[cdp] launch => " + JSON.stringify(launched));
if (!launched.ok) {
throw new Error("Unable to start CDP browser: " + launched.message);
}
const after = await browserSettings.getStatus();
if (!after.cdpRunning) {
throw new Error("CDP browser reported running but status check failed");
}
return after;
}
async function main() {
// 先确认两张图片在当前 Node 进程里确实存在
const imagePaths = [path.join(IMAGE_DIR, "1.png"), path.join(IMAGE_DIR, "2.png")];
for (const p of imagePaths) {
const exists = fs.existsSync(p);
console.log("[check] " + p + " exists=" + exists);
if (exists) {
console.log("[check]   size=" + fs.statSync(p).size + " bytes");
}
}
const existing = imagePaths.filter((p) => fs.existsSync(p));
if (!existing.length) {
console.log("SKIP: no images found under " + IMAGE_DIR);
return;
}
const workspace = path.resolve(__dirname, "..", "test-output-desktop-abs");
fs.mkdirSync(workspace, { recursive: true });
console.log("[step1] ensuring CDP browser...");
const cdpStatus = await ensureCdp();
console.log("[step1] ok, cdpUrl=" + cdpStatus.cdpUrl);
browserSettings.applyToRuntime(browserSettings.readSettings());
process.env.BROWSER_CDP_URL = cdpStatus.cdpUrl;
process.env.XML_AGENT_CDP_URL = cdpStatus.cdpUrl;
process.env.BROWSER_TYPE = cdpStatus.browserType;
process.env.XML_AGENT_BROWSER_TYPE = cdpStatus.browserType;
const task = [
"这是一个图片理解测试。",
"我随任务附带了图片，系统会在你读到这条消息之前把它们上传给你。",
"请简要描述你看到的图片内容（几张图、主要颜色或元素）。",
"然后用 <answer><![CDATA[你的描述]]></answer> 回复，只输出这一个 XML 动作。",
].join(String.fromCharCode(10));
console.log("[step2] creating Agent (deepseek) with absolute image paths...");
const agent = new Agent({
workspace: workspace,
provider: "deepseek",
task: task,
browserType: cdpStatus.browserType,
maxSteps: 4,
maxProviderErrors: 2,
images: existing,
});
const events = [];
agent.on("event", (e) => {
events.push(e);
if (e.type === "images.uploaded") {
console.log(
"[event] images.uploaded -> count=" +
e.count +
" uploadCount=" +
e.uploadCount +
" uploaded=" +
e.uploaded
);
} else if (e.type === "images.upload_error") {
console.log("[event] images.upload_error -> " + e.error);
} else if (e.type === "images.upload_skipped") {
console.log("[event] images.upload_skipped -> " + e.reason);
} else if (e.type === "images.missing") {
console.log("[event] images.missing -> " + JSON.stringify(e.paths));
} else if (e.type === "action.parsed") {
console.log("[event] action.parsed -> " + e.action);
} else if (e.type === "provider.response") {
console.log("[event] provider.response -> length=" + e.length);
} else if (e.type === "agent.completed") {
console.log("[event] agent.completed -> status=" + e.status + " steps=" + e.steps);
}
});
console.log("[step3] running agent...");
const result = await agent.run();
console.log("[step3] agent done. status=" + result.status + " steps=" + result.step);
const uploadEvent = events.find((e) => e.type === "images.uploaded");
const missingEvent = events.find((e) => e.type === "images.missing");
const errorEvent = events.find((e) => e.type === "images.upload_error");
console.log("");
console.log("SUMMARY:");
console.log("  images=" + JSON.stringify(existing));
console.log("  images.uploaded=" + (uploadEvent ? JSON.stringify(uploadEvent) : "NONE"));
console.log("  images.missing=" + (missingEvent ? JSON.stringify(missingEvent) : "NONE"));
console.log("  images.upload_error=" + (errorEvent ? JSON.stringify(errorEvent) : "NONE"));
console.log("  answer=" + String(result.answer || "").slice(0, 300));
assert(uploadEvent, "should emit images.uploaded event");
assert.strictEqual(uploadEvent.count, existing.length, "should upload all existing images");
assert.strictEqual(uploadEvent.uploadCount, existing.length, "provider confirm count");
assert.strictEqual(uploadEvent.uploaded, true, "upload should succeed");
assert(result.answer && result.answer.trim(), "final answer should be non-empty");
console.log("");
console.log("DESKTOP_ABSOLUTE_IMAGES_OK");
console.log("uploadCount=" + uploadEvent.uploadCount);
console.log("conversationId=" + (result.conversationId || "(none)"));
try {
fs.rmSync(workspace, { recursive: true, force: true });
} catch (e) {
// ignore
}
}
main().catch((error) => {
console.error("");
console.error("DESKTOP ABSOLUTE IMAGES TEST FAILED:");
console.error(error && error.stack ? error.stack : error);
process.exit(1);
});
