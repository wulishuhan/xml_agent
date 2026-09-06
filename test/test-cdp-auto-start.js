
/**

CDP 自动启动验证测试

验证自动检测和启动 CDP 服务器功能
*/

// 设置 Chrome 路径 - 使用正斜杠避免反斜杠转义问题
process.env.CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const { createProvider } = require("../providers");
const net = require("net");

// 测试配置
var TEST_CDP_PORT = 9223;
var TEST_CDP_URL = "http://127.0.0.1:" + TEST_CDP_PORT;

console.log("============================================================");
console.log("CDP Auto-Start Test Suite");
console.log("============================================================");
console.log("");
console.log("Test CDP URL: " + TEST_CDP_URL);
console.log("Test Port: " + TEST_CDP_PORT);
console.log("Chrome Path: " + process.env.CHROME_PATH);
console.log("");

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function checkPort(port, timeout) {
    timeout = timeout || 3000;
    return new Promise(function (resolve) {
        var socket = new net.Socket();
        socket.setTimeout(timeout);
        socket.once("connect", function () {
            socket.destroy();
            resolve(true);
        });
        socket.once("timeout", function () {
            socket.destroy();
            resolve(false);
        });
        socket.once("error", function () {
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, "127.0.0.1");
    });
}

function testProviderConnection(providerName, options) {
    options = options || {};
    var cdpUrl = options.cdpUrl || TEST_CDP_URL;
    var autoStart = options.autoStart !== undefined ? options.autoStart : true;
    var startTimeout = options.startTimeout || 30000;

    console.log("--- Testing " + providerName + " ---");
    console.log(" CDP URL: " + cdpUrl);
    console.log(" autoStart: " + autoStart);

    var provider = null;
    return new Promise(function (resolve) {
        try {
            provider = createProvider(providerName, {
                cdpUrl: cdpUrl,
                autoStart: autoStart,
                startTimeout: startTimeout
            });

            console.log(" Starting " + providerName + "...");
            var startTime = Date.now();

            provider.start().then(function () {
                var elapsed = Date.now() - startTime;
                console.log(" ✅ " + providerName + " connected successfully in " + elapsed + "ms");
                resolve({ success: true, provider: provider, elapsed: elapsed });
            }).catch(function (error) {
                console.log(" ❌ " + providerName + " failed: " + error.message);
                resolve({ success: false, error: error.message });
            });
        } catch (error) {
            console.log(" ❌ " + providerName + " failed: " + error.message);
            resolve({ success: false, error: error.message });
        }
    }).then(function (result) {
        if (provider && provider.close) {
            try {
                provider.close();
                console.log(" Closed " + providerName + " connection");
            } catch (e) { }
        }
        return result;
    });
}

function runTests() {
    var overallSuccess = true;
    var results = [];

    console.log("Test 1: Check initial CDP port state");
    console.log("------------------------------------------------------------");

    return checkPort(TEST_CDP_PORT).then(function (initialPortOpen) {
        if (initialPortOpen) {
            console.log("⚠️ Port " + TEST_CDP_PORT + " is already open.");
        } else {
            console.log("✅ Port " + TEST_CDP_PORT + " is closed (expected state)");
        }
        console.log("");

        console.log("Test 2: ChatGPT Provider with auto-start");
        console.log("------------------------------------------------------------");

        return testProviderConnection("chatgpt", {
            cdpUrl: TEST_CDP_URL,
            autoStart: true,
            startTimeout: 30000
        });
    }).then(function (chatgptResult) {
        results.push({ provider: "chatgpt", success: chatgptResult.success, elapsed: chatgptResult.elapsed, error: chatgptResult.error });
        if (!chatgptResult.success) overallSuccess = false;
        console.log("");
        return sleep(2000);
    }).then(function () {
        console.log("Test 3: Verify CDP server is running");
        console.log("------------------------------------------------------------");
        return checkPort(TEST_CDP_PORT, 5000);
    }).then(function (portOpen) {
        if (portOpen) {
            console.log("✅ CDP server is running on port " + TEST_CDP_PORT);
        } else {
            console.log("❌ CDP server is NOT running on port " + TEST_CDP_PORT);
            overallSuccess = false;
        }
        console.log("");

        console.log("Test 4: Qwen Provider connecting to existing CDP");
        console.log("------------------------------------------------------------");
        return testProviderConnection("qwen", {
            cdpUrl: TEST_CDP_URL,
            autoStart: true,
            startTimeout: 30000
        });
    }).then(function (qwenResult) {
        results.push({ provider: "qwen", success: qwenResult.success, elapsed: qwenResult.elapsed, error: qwenResult.error });
        if (!qwenResult.success) overallSuccess = false;
        console.log("");

        console.log("Test 5: autoStart: false behavior");
        console.log("------------------------------------------------------------");
        var FAIL_PORT = 9224;
        return testProviderConnection("qwen", {
            cdpUrl: "http://127.0.0.1:" + FAIL_PORT,
            autoStart: false,
            startTimeout: 5000,
            targetUrl:"https://chat.qwen.ai"
        });
    }).then(function (failResult) {
        if (!failResult.success) {
            console.log("✅ Expected failure with autoStart: false (" + failResult.error + ")");
        } else {
            console.log("⚠️ Unexpected: provider connected with autoStart: false");
            overallSuccess = false;
        }
        console.log("");

        console.log("Test 6: Reuse existing CDP server");
        console.log("------------------------------------------------------------");
        return sleep(1000);
    }).then(function () {
        return testProviderConnection("chatgpt", {
            cdpUrl: TEST_CDP_URL,
            autoStart: true,
            startTimeout: 30000
        });
    }).then(function (reuseResult) {
        results.push({ provider: "chatgpt-reuse", success: reuseResult.success, elapsed: reuseResult.elapsed, error: reuseResult.error });
        if (!reuseResult.success) overallSuccess = false;
        console.log("");

        console.log("============================================================");
        console.log("Test Summary");
        console.log("============================================================");
        console.log("");

        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            var status = r.success ? "✅" : "❌";
            var detail = r.success ? ("(" + r.elapsed + "ms)") : ("(" + r.error + ")");
            console.log(" " + status + " " + r.provider + ": " + detail);
        }
        console.log("");
        console.log("Overall: " + (overallSuccess ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"));
        console.log("");

        if (!overallSuccess) {
            console.log("Troubleshooting tips:");
            console.log(" 1. Make sure Chrome is installed and accessible");
            console.log(" 2. Set CHROME_PATH environment variable");
            console.log(" 3. Check if port " + TEST_CDP_PORT + " is blocked");
        }

        return overallSuccess;
    });
}

if (require.main === module) {
    runTests().then(function (success) {
        process.exit(success ? 0 : 1);
    }).catch(function (error) {
        console.error("Test suite error:", error);
        process.exit(1);
    });
}

module.exports = { runTests: runTests };
