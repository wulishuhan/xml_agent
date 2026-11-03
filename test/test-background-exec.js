const path = require("path");
const { setWorkspace, run, killAllProcesses, listProcesses } = require("../runtime");
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
            // 固定端口，方便下面用 HTTP 探活（--background 会被 exec 剥掉，故用 --port）
            "@_command": "node test/test-server.js --port=9999 --background",
        },
    };

    // run 是异步的（exec 走异步 child_process），必须 await，否则拿到的是 Promise
    const result1 = await run(action1);
    console.log("Result 1:", JSON.stringify(result1, null, 2));

    if (result1.ok && result1.background) {
        console.log("✅ Background process started with PID:", result1.pid);
    } else {
        console.log("❌ Failed to start background process");
    }

    console.log("\n");

    // 测试2: 通过直接 HTTP 请求验证服务器是否运行
    console.log("Test 2: Verify background process by HTTP request");
    // 后台进程刚 spawn 时还没开始 listen，等它一下再探活
    await new Promise((resolve) => setTimeout(resolve, 500));
    const serverRunning = await new Promise((resolve) => {
        const req = http.get("http://127.0.0.1:9999", (res) => {
            resolve(true);
        });
        req.on("error", () => {
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

    // 测试3: 后台进程在"停止会话"时必须被结束（回归：原来会留下孤儿进程占着端口）
    console.log("Test 3: Kill background processes");
    const before = listProcesses();
    console.log("Tracked processes:", before.length);
    const killed = await killAllProcesses("stopped");
    console.log("Killed:", killed);
    if (killed >= 1 && listProcesses().length === 0) {
        console.log("✅ Background process killed by killAllProcesses");
    } else {
        console.log("❌ Background process was not killed");
    }

    console.log("\n");
    console.log("=== Test Complete ===");
}

runTests().catch(console.error);
