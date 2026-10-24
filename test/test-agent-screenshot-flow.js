const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { EventEmitter } = require("events");
// 验证 Agent 在收到 screenshot action 后的完整链路：
// runtime 执行截图 -> attachScreenshotToProvider 调用 provider.uploadImages 上传给大模型。
// 为避免依赖真实 CDP 浏览器，直接构造 Agent 实例并调用 runStep，
// 不进入 provider.start()。
function buildMockProvider() {
    const provider = new EventEmitter();
    provider.name = "MockProvider";
    provider.currentConversationId = "mock-cid";
    provider.uploadedPaths = [];
    provider.uploadImages = async function (imagePaths) {
        for (const p of imagePaths) {
            if (!fs.existsSync(p)) {
                throw new Error("upload file does not exist: " + p);
            }
            provider.uploadedPaths.push(p);
        }
        return { ok: true, count: imagePaths.length };
    };
    provider.close = async function () {};
    return provider;
}
async function run() {
    const { Agent } = require("../agent-core");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-flow-"));
    fs.mkdirSync(path.join(workspace, "screenshots"), { recursive: true });
    try {
        const agent = new Agent({
            workspace: workspace,
            task: "测试截图上传给大模型的完整流程",
            provider: "chatgpt",
            browserType: "chrome",
            maxSteps: 5,
        });
        const events = [];
        agent.on("event", (e) => events.push(e));
        // 手动设置 provider（跳过 start）
        const mockProvider = buildMockProvider();
        agent.provider = mockProvider;
        agent.status = "running";
        // 直接构造 action 并调用 runtime + attach 链路
        const action = {
            action: "screenshot",
            node: {
                "@_source": "screen",
                "@_path": "screenshots/flow.png",
            },
        };
        let result = await agent.runtime.run(action);
        assert(result.ok, "screenshot should succeed: " + JSON.stringify(result));
        assert.strictEqual(result.action, "screenshot");
        // 走 attach 链路：把截图上传给 provider
        result = await agent.attachScreenshotToProvider(result);
        // 断言：截图文件生成
        const screenshotPath = path.join(workspace, "screenshots", "flow.png");
        assert(fs.existsSync(screenshotPath), "screenshot file should exist: " + screenshotPath);
        // 断言：截图被上传给 provider
        assert.strictEqual(mockProvider.uploadedPaths.length, 1, "one image should be uploaded");
        assert(
            mockProvider.uploadedPaths[0].endsWith("flow.png"),
            "uploaded path should end with flow.png"
        );
        // 断言：runtime 结果带 uploaded 标记
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.uploaded, true);
        assert.strictEqual(result.uploadCount, 1);
        // 断言：返回给大模型的结果包含 path/width/height
        assert(result.path, "result should contain path");
        assert(result.width > 0, "width should be > 0");
        assert(result.height > 0, "height should be > 0");
        // 断言：emitEvent 中有 screenshot.uploaded 事件
        const uploadEvents = events.filter((e) => e.type === "screenshot.uploaded");
        assert.strictEqual(uploadEvents.length, 1, "should emit one screenshot.uploaded event");
        assert.strictEqual(uploadEvents[0].uploaded, true);
        // 验证 runtime 返回给大模型 JSON 时可以序列化
        const promptPreview = JSON.stringify(result, null, 2);
        assert(promptPreview.indexOf("flow.png") !== -1);
        console.log("FLOW_OK");
        console.log("uploadedCount=" + mockProvider.uploadedPaths.length);
        console.log("screenshotBytes=" + fs.statSync(screenshotPath).size);
        console.log("resultPath=" + result.path);
        console.log("resultSize=" + result.width + "x" + result.height);
    } finally {
        try {
            fs.rmSync(workspace, { recursive: true, force: true });
        } catch (e) {
            // ignore
        }
    }
}
run().catch((error) => {
    console.error("FLOW TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
