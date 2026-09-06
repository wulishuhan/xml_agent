
const path = require("path");
const { setWorkspace, run } = require("../runtime");
const http = require("http");

// 设置 workspace
const workspacePath = path.resolve(__dirname, "..");
setWorkspace(workspacePath);

async function runTests() {
    console.log("=== Testing Background Exec ===\n");

    // 测试1: 后台启动服务器
    console.log("Test 1: Start a background process");
    const action1 = {
        action: "exec",
        node: {
            "@_command": "node test/test-server.js --background"
        }
    };

    const result1 = run(action1);
    console.log("Result 1:", JSON.stringify(result1, null, 2));

    if (result1.ok && result1.background) {
        console.log("✅ Background process started with PID:", result1.pid);
    } else {
        console.log("❌ Failed to start background process");
    }

    console.log("\n");

    // 测试2: 通过直接 HTTP 请求验证服务器是否运行
    console.log("Test 2: Verify background process by HTTP request");
    const serverRunning = await new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:9999', (res) => {
            resolve(true);
        });
        req.on('error', () => {
            resolve(false);
        });
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
        });
    });

    if (serverRunning) {
        console.log("✅ Background server is running and accessible");
    } else {
        console.log("⚠️ Background server may not be running");
    }

    console.log("\n");
    console.log("=== Test Complete ===");
}

runTests().catch(console.error);
