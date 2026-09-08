const { createProvider } = require("../providers");
const agentConfig = require("../config/agent-config");

async function testChatGPTSend() {
    console.log("=== Testing ChatGPT Provider Send ===");

    const provider = createProvider("chatgpt", {
        autoStart: agentConfig.browser.autoStart,
        startTimeout: agentConfig.browser.startTimeout,
        retryInterval: agentConfig.browser.retryInterval,
        chromePath: agentConfig.browser.chromePath,
        targetUrl: agentConfig.browser.targetUrls["chatgpt"],
    });

    try {
        console.log("Starting provider...");
        await provider.start();
        console.log("Provider started successfully");

        // 第一次发送
        console.log("\n--- Sending first message ---");
        const response1 = await provider.send("Hello, please respond with a short greeting");
        console.log("First response received:");
        console.log(response1.substring(0, 200) + "...");

        // 等待一下
        await provider.sleep(2000);

        // 第二次发送
        console.log("\n--- Sending second message ---");
        const response2 = await provider.send("Please say 'second message successful'");
        console.log("Second response received:");
        console.log(response2.substring(0, 200) + "...");

        console.log("\n✅ Test passed! Both messages sent and received.");
        return true;
    } catch (error) {
        console.error("\n❌ Test failed:", error.message);
        console.error(error.stack);
        return false;
    } finally {
        await provider.close();
        console.log("Provider closed");
    }
}

// 运行测试
testChatGPTSend()
    .then((success) => {
        process.exit(success ? 0 : 1);
    })
    .catch((error) => {
        console.error("Unhandled error:", error);
        process.exit(1);
    });
