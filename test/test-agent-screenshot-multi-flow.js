const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { EventEmitter } = require("events");
// 验证 Agent 收到多目标 screenshot 后，会把所有成功截图一次性上传给 provider。
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
    const { Agent } = require("../agent-core");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-multiflow-"));
    try {
        const agent = new Agent({
            workspace: workspace,
            task: "多图上传流程测试",
            provider: "chatgpt",
            browserType: "chrome",
            maxSteps: 5,
        });
        const events = [];
        agent.on("event", (e) => events.push(e));
        const mockProvider = buildMockProvider();
        agent.provider = mockProvider;
        agent.status = "running";
        const action = {
            action: "screenshot",
            node: {
                target: [
                    { "@_source": "screen", "@_path": "shots/m1.png" },
                    { "@_source": "screen", "@_path": "shots/m2.png" },
                    { "@_source": "screen", "@_path": "shots/m3.png" },
                ],
            },
        };
        let result = await agent.runtime.run(action);
        assert.strictEqual(result.ok, true, "multi screenshot should succeed: " + result.error);
        assert.strictEqual(result.succeeded, 3);
        result = await agent.attachScreenshotToProvider(result);
        assert.strictEqual(mockProvider.uploadCalls.length, 1, "should upload in a single call");
        assert.strictEqual(mockProvider.uploadCalls[0].length, 3, "should upload 3 images at once");
        for (const p of mockProvider.uploadCalls[0]) {
            assert(fs.existsSync(p), "uploaded file should exist: " + p);
        }
        assert.strictEqual(result.uploaded, true);
        assert.strictEqual(result.uploadCount, 3);
        assert(Array.isArray(result.uploadedPaths));
        assert.strictEqual(result.uploadedPaths.length, 3);
        const uploadEvents = events.filter((e) => e.type === "screenshot.uploaded");
        assert.strictEqual(uploadEvents.length, 1);
        assert.strictEqual(uploadEvents[0].uploadCount, 3);
        assert.strictEqual(uploadEvents[0].paths.length, 3);
        // 单图回归：旧写法仍只上传 1 张
        const single = await agent.runtime.run({
            action: "screenshot",
            node: { "@_source": "screen", "@_path": "shots/single.png" },
        });
        const singleUploaded = await agent.attachScreenshotToProvider(single);
        assert.strictEqual(singleUploaded.uploaded, true);
        assert.strictEqual(singleUploaded.uploadCount, 1);
        assert.strictEqual(mockProvider.uploadCalls.length, 2);
        assert.strictEqual(mockProvider.uploadCalls[1].length, 1);
        console.log("MULTI_FLOW_OK");
        console.log("batchUploads=" + mockProvider.uploadCalls.length);
        console.log("firstBatchCount=" + mockProvider.uploadCalls[0].length);
        console.log("uploadedPaths=" + JSON.stringify(result.uploadedPaths));
    } finally {
        try {
            fs.rmSync(workspace, { recursive: true, force: true });
        } catch (e) {
            // ignore
        }
    }
}
run().catch((error) => {
    console.error("MULTI FLOW TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
