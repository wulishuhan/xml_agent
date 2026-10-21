const assert = require("assert");
const path = require("path");
const fs = require("fs");
const projectRoot = path.join(__dirname, "..");
const notifierPath = path.join(projectRoot, "electron", "notifier.js");
const mainPath = path.join(projectRoot, "electron", "main.js");
const preloadPath = path.join(projectRoot, "electron", "preload.js");
const desktopNotifyPath = path.join(
    projectRoot,
    "webui",
    "frontend",
    "src",
    "services",
    "desktop-notify.js"
);
assert.ok(fs.existsSync(notifierPath), "electron/notifier.js should exist");
assert.ok(fs.existsSync(desktopNotifyPath), "desktop-notify.js should exist");
const { shouldNotify, buildTaskNotification, buildNotificationPayload, notify } = require(
    notifierPath
);
// shouldNotify 仅在 completed 时返回 true
assert.strictEqual(shouldNotify("completed"), true, "completed should notify");
assert.strictEqual(shouldNotify("error"), false, "error should not notify");
assert.strictEqual(shouldNotify("stopped"), false, "stopped should not notify");
assert.strictEqual(shouldNotify(""), false, "empty should not notify");
// buildTaskNotification 生成标题与正文
const payload = buildTaskNotification({
    status: "completed",
    task: "Build a hello world app",
    provider: "chatgpt",
});
assert.ok(payload.title.includes("XML Agent"), "title should mention XML Agent");
assert.ok(payload.body.includes("hello world app"), "body should include task text");
assert.ok(payload.body.includes("chatgpt"), "body should include provider");
// 无 task 时回退到默认文案
const emptyPayload = buildTaskNotification({ status: "completed", provider: "deepseek" });
assert.ok(emptyPayload.body.includes("任务完成了"), "empty task should fall back to 任务完成了");
// buildNotificationPayload 归一化
const normalized = buildNotificationPayload({ title: "", body: "" });
assert.strictEqual(normalized.title, "XML Agent");
assert.strictEqual(normalized.body, "任务完成了");
// notify 使用自定义 send 时可被捕获
let captured = null;
const delivered = notify({
    payload: { title: "T", body: "B" },
    send: (p) => {
        captured = p;
        return true;
    },
});
assert.strictEqual(delivered, true, "custom send should report delivered");
assert.deepStrictEqual(captured, { title: "T", body: "B" });
// 无 electron 环境下 notify 应优雅返回 false，不抛错
assert.strictEqual(notify({ payload: { title: "x", body: "y" } }), false);
// main.js 与 preload.js 应包含通知接线
const mainSrc = fs.readFileSync(mainPath, "utf8");
assert.ok(mainSrc.includes("./notifier"), "main.js should require notifier");
assert.ok(mainSrc.includes("notify:task-done"), "main.js should register notify:task-done");
assert.ok(mainSrc.includes("notify:send"), "main.js should register notify:send");
const preloadSrc = fs.readFileSync(preloadPath, "utf8");
assert.ok(preloadSrc.includes("notifications"), "preload should expose notifications");
assert.ok(preloadSrc.includes("notify:task-done"), "preload should call notify:task-done");
console.log("All desktop-notify checks passed.");
