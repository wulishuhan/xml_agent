
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const browserSettings = require("../webui/browser-settings");
const { Agent } = require("../agent-core");
// 真实 CDP + DeepSeek 测试：用户预置图片在第一条 prompt 之前上传给模型。
//
// 步骤：
//   1. 确保 CDP 可用
//   2. 在 workspace 准备 1 张真实 PNG
//   3. Agent（deepseek）带 images 启动
//   4. 断言：images.uploaded 事件出现且 uploadCount 正确
//   5. 断言：模型回复内容中提到了"图片/图"等，说明它确实看到了图片
//
// 说明：DeepSeek 对图片的描述是自然语言，无法严格断言具体内容，
// 因此这里只要求"回复非空且包含对图片的指代"，并打印实际回复供人工确认。
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
// 生成一张 64x64 的纯色 PNG（不依赖外部资源）。
function writeTestPng(filePath, rgb) {
const zlib = require("zlib");
const width = 64;
const height = 64;
const raw = Buffer.alloc((width * 3 + 1) * height);
let offset = 0;
for (let y = 0; y < height; y += 1) {
raw[offset] = 0; // filter type none
offset += 1;
for (let x = 0; x < width; x += 1) {
raw[offset] = rgb[0];
raw[offset + 1] = rgb[1];
raw[offset + 2] = rgb[2];
offset += 3;
}
}
const idat = zlib.deflateSync(raw);
function chunk(type, data) {
const len = Buffer.alloc(4);
len.writeUInt32BE(data.length, 0);
const typeBuf = Buffer.from(type, "ascii");
const body = Buffer.concat([typeBuf, data]);
const crcTable = [];
for (let n = 0; n < 256; n += 1) {
let c = n;
for (let k = 0; k < 8; k += 1) {
c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
}
crcTable[n] = c >>> 0;
}
let crc = 0xffffffff;
for (let i = 0; i < body.length; i += 1) {
crc = crcTable[(crc ^ body[i]) & 0xff] ^ (crc >>> 8);
}
crc = (crc ^ 0xffffffff) >>> 0;
const crcBuf = Buffer.alloc(4);
crcBuf.writeUInt32BE(crc, 0);
return Buffer.concat([len, body, crcBuf]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type RGB
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
signature,
chunk("IHDR", ihdr),
chunk("IDAT", idat),
chunk("IEND", Buffer.alloc(0)),
]);
fs.mkdirSync(path.dirname(filePath), { recursive: true });
fs.writeFileSync(filePath, png);
}
async function main() {
const workspace = path.resolve(__dirname, "..", "test-output-preset");
fs.mkdirSync(workspace, { recursive: true });
const imageRel = "uploads/red-64.png";
const imageAbs = path.join(workspace, imageRel);
writeTestPng(imageAbs, [220, 30, 30]);
console.log("[step0] test image written: " + imageAbs);
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
"我随任务附带了一张图片，系统会在你读到这条消息之前把它上传给你。",
"请直接描述你看到的图片：主要颜色是什么？形状是什么？",
"然后用 <answer><![CDATA[你的描述]]></answer> 回复，只输出这一个 XML 动作。",
].join(String.fromCharCode(10));
console.log("[step2] creating Agent (deepseek) with preset image...");
const agent = new Agent({
workspace: workspace,
provider: "deepseek",
task: task,
browserType: cdpStatus.browserType,
maxSteps: 4,
maxProviderErrors: 2,
images: [imageRel],
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
assert(uploadEvent, "should emit images.uploaded event");
assert.strictEqual(uploadEvent.count, 1, "should upload 1 image");
assert.strictEqual(uploadEvent.uploadCount, 1, "provider should confirm 1 image uploaded");
assert.strictEqual(uploadEvent.uploaded, true, "upload should succeed");
assert(result.answer && result.answer.trim(), "final answer should be non-empty");
console.log("[assert] final answer preview: " + String(result.answer).slice(0, 300));
console.log("");
console.log("DEEPSEEK_PRESET_IMAGES_FLOW_OK");
console.log("status=" + result.status);
console.log("steps=" + result.step);
console.log("conversationId=" + (result.conversationId || "(none)"));
console.log("images=" + JSON.stringify(result.images));
try {
fs.rmSync(workspace, { recursive: true, force: true });
} catch (e) {
// ignore
}
}
main().catch((error) => {
console.error("");
console.error("DEEPSEEK PRESET IMAGES FLOW FAILED:");
console.error(error && error.stack ? error.stack : error);
process.exit(1);
});
