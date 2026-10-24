
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { EventEmitter } = require("events");
// 验证 Agent 会把用户预置图片一次性上传给模型（第一条 prompt 之前）。
// 为避免依赖真实 CDP 浏览器，这里直接构造 Agent 并注入 mock provider，
// 只调用 uploadPresetImages() 与 runStep 链路，不进入 provider.start()。
function buildMockProvider() {
const provider = new EventEmitter();
provider.name = "MockProvider";
provider.currentConversationId = "mock-cid";
provider.uploadCalls = [];
provider.uploadImages = async function (imagePaths) {
for (const p of imagePaths) {
if (!fs.existsSync(p)) {
throw new Error("upload file does not exist: " + p);
}
}
provider.uploadCalls.push(imagePaths.slice());
return { ok: true, count: imagePaths.length };
};
provider.close = async function () {};
return provider;
}
async function run() {
const { Agent, normalizePresetImages } = require("../agent-core");
let pass = 0;
let total = 0;
function check(name, ok, detail) {
total += 1;
if (ok) pass += 1;
console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}
// 1. normalizePresetImages 单测
check(
"normalize 去重去空",
JSON.stringify(normalizePresetImages(["a.png", "", "a.png", "b.png"])) ===
'["a.png","b.png"]'
);
check("normalize 非数组返回空", normalizePresetImages("a.png").length === 0);
check(
"normalize 上限 8",
normalizePresetImages(["1", "2", "3", "4", "5", "6", "7", "8", "9"]).length === 8
);
check(
"normalize 丢弃非字符串",
JSON.stringify(normalizePresetImages([1, null, "a.png"])) === '["a.png"]'
);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-preset-"));
fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });
const img1 = path.join(workspace, "uploads", "p1.png");
const img2 = path.join(workspace, "uploads", "p2.png");
fs.writeFileSync(img1, Buffer.from("fake-png-1"));
fs.writeFileSync(img2, Buffer.from("fake-png-2"));
try {
// 2. 正常上传两张
const agent = new Agent({
workspace: workspace,
task: "测试预置图片",
provider: "chatgpt",
browserType: "chrome",
maxSteps: 3,
images: ["uploads/p1.png", "uploads/p2.png"],
});
const events = [];
agent.on("event", (e) => events.push(e));
const mockProvider = buildMockProvider();
agent.provider = mockProvider;
agent.status = "running";
await agent.uploadPresetImages();
check("uploadImages 被调用一次", mockProvider.uploadCalls.length === 1);
check(
"一次上传 2 张",
mockProvider.uploadCalls[0] && mockProvider.uploadCalls[0].length === 2
);
const uploaded = mockProvider.uploadCalls[0] || [];
check(
"上传路径为绝对路径且落在 workspace 内",
uploaded.length === 2 &&
uploaded.every((p) => path.isAbsolute(p) && p.startsWith(workspace))
);
const uploadEvent = events.find((e) => e.type === "images.uploaded");
check("发出 images.uploaded 事件", !!uploadEvent);
check("事件中 uploadCount=2", uploadEvent && uploadEvent.uploadCount === 2);
check(
"images 写回 getResult",
Array.isArray(agent.getResult().images) && agent.getResult().images.length === 2
);
// 3. 缺失图片：只上传存在的，发出 images.missing
const agent2 = new Agent({
workspace: workspace,
task: "缺失图片测试",
provider: "chatgpt",
browserType: "chrome",
maxSteps: 3,
images: ["uploads/not-exist.png", "uploads/p1.png"],
});
const events2 = [];
agent2.on("event", (e) => events2.push(e));
const mockProvider2 = buildMockProvider();
agent2.provider = mockProvider2;
agent2.status = "running";
await agent2.uploadPresetImages();
check(
"缺失时只上传已存在的那张",
mockProvider2.uploadCalls.length === 1 && mockProvider2.uploadCalls[0].length === 1
);
const missingEvent = events2.find((e) => e.type === "images.missing");
check("发出 images.missing 事件", !!missingEvent && missingEvent.count === 1);
// 4. 没有 images：不调用 uploadImages
const agent3 = new Agent({
workspace: workspace,
task: "无图片测试",
provider: "chatgpt",
browserType: "chrome",
maxSteps: 3,
});
const mockProvider3 = buildMockProvider();
agent3.provider = mockProvider3;
agent3.status = "running";
await agent3.uploadPresetImages();
check("无 images 时不上传", mockProvider3.uploadCalls.length === 0);
// 5. 全部缺失：不上传，但有 images.missing
const agent4 = new Agent({
workspace: workspace,
task: "全部缺失",
provider: "chatgpt",
browserType: "chrome",
maxSteps: 3,
images: ["uploads/a.png", "uploads/b.png"],
});
const events4 = [];
agent4.on("event", (e) => events4.push(e));
const mockProvider4 = buildMockProvider();
agent4.provider = mockProvider4;
agent4.status = "running";
await agent4.uploadPresetImages();
check("全部缺失时不上传", mockProvider4.uploadCalls.length === 0);
const missingEvent4 = events4.find((e) => e.type === "images.missing");
check("全部缺失时发出 missing(count=2)", !!missingEvent4 && missingEvent4.count === 2);
// 6. provider 不支持 uploadImages：跳过且不报错
const agent5 = new Agent({
workspace: workspace,
task: "不支持上传",
provider: "chatgpt",
browserType: "chrome",
maxSteps: 3,
images: ["uploads/p1.png"],
});
const events5 = [];
agent5.on("event", (e) => events5.push(e));
agent5.provider = { close: async function () {} };
agent5.status = "running";
await agent5.uploadPresetImages();
const skipped = events5.find((e) => e.type === "images.upload_skipped");
check("provider 不支持时发出 upload_skipped", !!skipped);
} finally {
try {
fs.rmSync(workspace, { recursive: true, force: true });
} catch (e) {
// ignore
}
}
console.log("");
console.log("Total: " + pass + "/" + total);
process.exit(pass === total ? 0 : 1);
}
run().catch((error) => {
console.error("PRESET IMAGES TEST FAILED:", error && error.stack ? error.stack : error);
process.exit(1);
});
