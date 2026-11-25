const { spawn } = require("child_process");
const path = require("path");

// 测试 agent.js 输出是否包含真实 JSON 动作解析与运行时事件
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
        env: Object.assign({}, process.env, { LOG_LEVEL: "debug" }),
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

        // 只检测 Agent 实际发出的事件，不依赖提示词或旧协议标记。
        const markers = ["[action.parsed]", "[runtime.result]"];

        for (const marker of markers) {
            if (output.includes(marker)) {
                hasStructuredMarkers = true;
                markerCount++;
                console.log("Found event:", marker);
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
            console.log("PASS: Agent output contains JSON action/runtime events");
        } else {
            console.log("FAIL: Agent output does NOT contain JSON action/runtime events");
            console.log("\nFirst 1000 chars of output:");
            console.log(outputBuffer.substring(0, 1000));
            process.exitCode = 1;
        }

        process.exit(process.exitCode || 0);
    });

    // 超时处理 - 给 agent 一些时间启动
    setTimeout(() => {
        console.log("\nTest timeout after 30s, killing agent...");
        agentProcess.kill("SIGINT");
        process.exit(1);
    }, 30000);
}

testAgentOutputStructure();
