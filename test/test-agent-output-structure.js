const { spawn } = require("child_process");
const path = require("path");

// 测试 agent.js 输出是否包含结构化标记
function testAgentOutputStructure() {
    console.log("=== Testing Agent Output Structure ===\n");

    const workspace = path.resolve(__dirname, "..");
    const task = "分析当前项目结构";

    // 不使用 --background，直接捕获输出
    const args = ["agent.js", "--workspace", workspace, "--provider", "chatgpt", task];

    console.log("Command: node " + args.join(" "));
    console.log("");

    const agentProcess = spawn("node", args, {
        cwd: workspace,
        shell: true,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });

    let outputBuffer = "";
    let hasStructuredMarkers = false;
    let markerCount = 0;
    let startTime = Date.now();

    agentProcess.stdout.on("data", (data) => {
        const output = data.toString();
        outputBuffer += output;

        console.log("[STDOUT]", output.trim());

        // 检测结构化标记
        const markers = [
            "[AI_RESPONSE]",
            "[RUNTIME_STATUS]",
            "[AGENT_STEP]",
            "[XML_ACTION]",
            "[PROVIDER]",
            "[SYSTEM]",
        ];

        for (const marker of markers) {
            if (output.includes(marker)) {
                hasStructuredMarkers = true;
                markerCount++;
                console.log("✅ Found marker:", marker);
            }
        }
    });

    agentProcess.stderr.on("data", (data) => {
        console.error("[STDERR]", data.toString().trim());
    });

    agentProcess.on("close", (code) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log("\n=== Test Results ===");
        console.log("Agent exit code:", code);
        console.log("Elapsed time:", elapsed + "s");
        console.log("Has structured markers:", hasStructuredMarkers);
        console.log("Marker count:", markerCount);
        console.log("Total output length:", outputBuffer.length);

        if (hasStructuredMarkers) {
            console.log("✅ PASS: Agent output contains structured markers");
        } else {
            console.log("❌ FAIL: Agent output does NOT contain structured markers");
            console.log("\nFirst 1000 chars of output:");
            console.log(outputBuffer.substring(0, 1000));
        }

        process.exit(0);
    });

    // 超时处理 - 给 agent 一些时间启动
    setTimeout(() => {
        console.log("\n⏱️ Test timeout after 30s, killing agent...");
        agentProcess.kill("SIGINT");
        process.exit(1);
    }, 30000);
}

testAgentOutputStructure();
