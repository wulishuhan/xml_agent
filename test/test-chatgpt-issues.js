/**

ChatGPT 问题验证测试

测试三大核心问题：

无法获取回复

无法发送信息

回复未完成就插入新消息
*/

const agentConfig = require("../config/agent-config.js");
const { createProvider } = require("../providers");
const net = require("net");

// 使用独立端口避免干扰
const TEST_CDP_PORT = 9225;
const TEST_CDP_URL = "http://127.0.0.1:" + TEST_CDP_PORT;

console.log("============================================================");
console.log("ChatGPT Issue Validation Test Suite");
console.log("============================================================");
console.log("");
console.log("Test CDP URL: " + TEST_CDP_URL);
console.log("Test Port: " + TEST_CDP_PORT);
console.log("Chrome Path: " + agentConfig.browser.chromePath);
console.log("");

function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
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

// 测试结果记录
var testResults = [];
var overallSuccess = true;

function logTest(name, success, details) {
    var status = success ? "✅ PASS" : "❌ FAIL";
    console.log(" " + status + " - " + name);
    if (details) {
        console.log(" " + details);
    }
    testResults.push({ name: name, success: success, details: details });
    if (!success) overallSuccess = false;
}

// ============================================================
// 测试 1: 测试 getLastResponse 选择器是否有效
// ============================================================
async function testGetLastResponse(provider) {
    console.log("\n--- Test 1: getLastResponse() 选择器有效性 ---");

    try {
        // 获取当前页面的 assistant 消息数量
        const count = await provider.getAssistantCount();
        console.log(" 当前 assistant 消息数量: " + count);

        // 获取最后一条回复
        const response = await provider.getLastResponse();
        console.log(" 最后回复内容长度: " + (response ? response.length : 0));
        console.log(" 最后回复预览: " + (response ? response.substring(0, 100) : "(空)"));

        // 判断：如果页面有回复但 getLastResponse 返回空，则有问题
        if (count > 0 && (!response || response.trim().length === 0)) {
            logTest(
                "getLastResponse 能获取已有回复",
                false,
                "有 " + count + " 条 assistant 消息但返回空内容"
            );
            return false;
        } else if (count > 0 && response && response.trim().length > 0) {
            logTest(
                "getLastResponse 能获取已有回复",
                true,
                "成功获取 " + response.length + " 字符"
            );
            return true;
        } else {
            logTest("getLastResponse 能获取已有回复", true, "当前无回复消息（跳过验证）");
            return true;
        }
    } catch (error) {
        logTest("getLastResponse 能获取已有回复", false, error.message);
        return false;
    }
}

// ============================================================
// 测试 2: 测试 insertMessage 和发送功能
// ============================================================
async function testSendMessage(provider) {
    console.log("\n--- Test 2: send() 消息发送功能 ---");

    const testMessage = "Hello, this is a test message at " + new Date().toISOString();
    console.log(" 测试消息: " + testMessage);

    try {
        // 先获取当前状态
        const beforeCount = await provider.getAssistantCount();
        const beforeResponse = await provider.getLastResponse();
        console.log(" 发送前 assistant 数量: " + beforeCount);

        // 发送消息（设置较短的超时时间便于快速验证）
        const response = await Promise.race([
            provider.send(testMessage),
            new Promise(function (_, reject) {
                setTimeout(function () {
                    reject(new Error("send() 超时 (60s)"));
                }, 60000);
            }),
        ]);

        console.log(" 收到回复长度: " + response.length);
        console.log(" 回复预览: " + response.substring(0, 150));

        // 验证：回复不为空
        if (response && response.trim().length > 0) {
            logTest("send() 能成功发送并接收回复", true, "收到 " + response.length + " 字符回复");
            return true;
        } else {
            logTest("send() 能成功发送并接收回复", false, "回复为空");
            return false;
        }
    } catch (error) {
        logTest("send() 能成功发送并接收回复", false, error.message);
        return false;
    }
}

// ============================================================
// 测试 3: 测试响应完成前是否能插入新消息（问题复现）
// ============================================================
async function testInsertDuringResponse(provider) {
    console.log("\n--- Test 3: 响应未完成时插入新消息（问题复现测试） ---");

    try {
        // 发送一个会触发较长回复的消息
        const longMessage = "请详细介绍一下人工智能的发展历史，包括重要里程碑和关键人物。";
        console.log(" 发送长消息: " + longMessage);

        const beforeCount = await provider.getAssistantCount();

        // 启动发送但不等待完成（模拟问题场景）
        var sendPromise = provider.send(longMessage);

        // 等待 3 秒让回复开始生成
        console.log(" 等待 3 秒让回复开始生成...");
        await sleep(3000);

        // 检查是否已经开始生成（有新的 assistant 消息）
        const currentCount = await provider.getAssistantCount();
        console.log(" 当前 assistant 数量: " + currentCount);
        console.log(" 发送前数量: " + beforeCount);

        if (currentCount > beforeCount) {
            console.log(" ⚠️ 检测到新回复正在生成中...");

            // 尝试在回复未完成时获取输入框并插入新消息（模拟问题）
            try {
                const input = await provider.getInput();
                if (input) {
                    console.log(" ⚠️ 尝试在回复未完成时插入新消息...");
                    // 注意：这里只测试是否能获取到输入框，实际插入可能导致状态混乱
                    // 所以我们只检测输入框是否可用
                    logTest(
                        "响应完成前输入框状态",
                        true,
                        "回复生成中，输入框可用（可能导致误插入）"
                    );
                } else {
                    logTest("响应完成前输入框状态", false, "回复生成中但无法获取输入框");
                }
            } catch (inputError) {
                logTest("响应完成前输入框状态", false, "获取输入框失败: " + inputError.message);
            }

            // 等待回复完成
            console.log(" 等待回复完成...");
            await sendPromise;
            console.log(" ✅ 回复已完成");
            return true;
        } else {
            // 没有新回复，可能是发送失败
            logTest("响应完成前输入框状态", false, "消息未能触发回复生成");
            return false;
        }
    } catch (error) {
        logTest("响应完成前输入框状态", false, "测试异常: " + error.message);
        return false;
    }
}

// ============================================================
// 测试 4: 测试 waitForResponseStart 检测机制
// ============================================================
async function testWaitForResponseStart(provider) {
    console.log("\n--- Test 4: waitForResponseStart() 检测机制 ---");

    try {
        const beforeCount = await provider.getAssistantCount();
        const beforeResponse = await provider.getLastResponse();
        console.log(" 当前 assistant 数量: " + beforeCount);
        console.log(" 当前回复长度: " + (beforeResponse || "").length);

        // 发送测试消息
        const testMsg = "请用一句话回答：什么是人工智能？";
        console.log(" 发送测试消息: " + testMsg);

        // 直接测试 waitForResponseStart
        var startDetected = false;
        var startTime = Date.now();

        try {
            // 先发送消息
            await provider.insertMessage(testMsg);

            // 按 Enter 发送
            const input = await provider.getInput();
            if (input) {
                await input.press("Enter");
            } else {
                throw new Error("无法获取输入框");
            }

            // 等待输入框清空
            await provider.waitForInputClear(5000);

            // 调用 waitForResponseStart
            await provider.waitForResponseStart(beforeCount, beforeResponse);
            startDetected = true;
            var elapsed = Date.now() - startTime;
            console.log(" ✅ waitForResponseStart 在 " + elapsed + "ms 内检测到响应开始");
        } catch (waitError) {
            var elapsed = Date.now() - startTime;
            console.log(" ❌ waitForResponseStart 失败: " + waitError.message);
            console.log(" 耗时: " + elapsed + "ms");
        }

        // 获取最终回复验证
        await sleep(3000);
        const finalResponse = await provider.getLastResponse();
        console.log(" 最终回复长度: " + (finalResponse || "").length);

        if (startDetected && finalResponse && finalResponse.trim().length > 0) {
            logTest(
                "waitForResponseStart 能检测响应开始",
                true,
                "检测成功，最终回复 " + finalResponse.length + " 字符"
            );
            return true;
        } else if (startDetected) {
            logTest("waitForResponseStart 能检测响应开始", false, "检测到开始但最终回复为空");
            return false;
        } else {
            logTest("waitForResponseStart 能检测响应开始", false, "未能检测到响应开始");
            return false;
        }
    } catch (error) {
        logTest("waitForResponseStart 能检测响应开始", false, error.message);
        return false;
    }
}

// ============================================================
// 主测试流程
// ============================================================
async function runTests() {
    var provider = null;

    try {
        console.log("Step 1: 检查 CDP 端口状态");
        console.log("------------------------------------------------------------");

        var initialPortOpen = await checkPort(TEST_CDP_PORT);
        if (initialPortOpen) {
            console.log("⚠️ 端口 " + TEST_CDP_PORT + " 已被占用，尝试清理...");
        } else {
            console.log("✅ 端口 " + TEST_CDP_PORT + " 可用");
        }
        console.log("");

        console.log("Step 2: 启动 ChatGPT Provider (autoStart: true)");
        console.log("------------------------------------------------------------");

        provider = createProvider("chatgpt", {
            cdpUrl: TEST_CDP_URL,
            autoStart: true,
            startTimeout: 30000,
            responseTimeout: 60000,
            responseStableTime: 3000,
            responsePollInterval: 500,
            chromePath: agentConfig.browser.chromePath,
        });

        await provider.start();
        console.log("✅ ChatGPT Provider 启动成功");
        console.log("");

        console.log("Step 3: 验证页面是否正常加载");
        console.log("------------------------------------------------------------");

        // 等待页面稳定
        await sleep(5000);

        try {
            var title = await provider.page.title();
            console.log(" 页面标题: " + title);
        } catch (e) {
            console.log(" 无法获取页面标题: " + e.message);
        }

        var url = await provider.page.url();
        console.log(" 当前 URL: " + url);
        console.log("");

        // 执行测试
        console.log("Step 4: 执行测试用例");
        console.log("------------------------------------------------------------");

        // 先检查是否有输入框可用
        try {
            var input = await provider.waitForInput(10000);
            console.log("✅ 输入框可用");
        } catch (e) {
            console.log("❌ 输入框不可用: " + e.message);
            logTest("环境准备 - 输入框可用", false, e.message);
            throw new Error("输入框不可用，无法继续测试");
        }
        console.log("");

        // 测试 1: getLastResponse
        await testGetLastResponse(provider);

        // 测试 2: send 消息
        var sendResult = await testSendMessage(provider);

        // 等待一下让状态稳定
        await sleep(2000);

        // 测试 3: 响应未完成时插入
        await testInsertDuringResponse(provider);

        // 测试 4: waitForResponseStart
        await testWaitForResponseStart(provider);

        console.log("");
        console.log("============================================================");
        console.log("测试结果汇总");
        console.log("============================================================");
        console.log("");

        var passed = 0;
        var failed = 0;
        for (var i = 0; i < testResults.length; i++) {
            var r = testResults[i];
            var status = r.success ? "✅" : "❌";
            console.log(" " + status + " " + r.name);
            if (r.details) {
                console.log(" " + r.details);
            }
            if (r.success) passed++;
            else failed++;
        }

        console.log("");
        console.log("总计: " + testResults.length + " 个测试");
        console.log("通过: " + passed + " 个");
        console.log("失败: " + failed + " 个");
        console.log("");
        console.log("整体状态: " + (overallSuccess ? "✅ 所有测试通过" : "❌ 存在失败测试"));
        console.log("");

        if (!overallSuccess) {
            console.log("🔍 问题诊断:");
            console.log(" 1. 如果 getLastResponse 失败 → 选择器需要更新");
            console.log(" 2. 如果 send() 失败 → 消息发送机制需要优化");
            console.log(" 3. 如果响应未完成时输入框可用 → 需要添加完成状态检查");
        }

        return overallSuccess;
    } catch (error) {
        console.error("测试流程异常:", error);
        return false;
    } finally {
        if (provider) {
            try {
                await provider.close();
                console.log("\n✅ Provider 已关闭");
            } catch (e) {
                console.log("\n⚠️ 关闭 Provider 时出错: " + e.message);
            }
        }
    }
}

// 运行测试
if (require.main === module) {
    runTests()
        .then(function (success) {
            process.exit(success ? 0 : 1);
        })
        .catch(function (error) {
            console.error("测试套件错误:", error);
            process.exit(1);
        });
}

module.exports = { runTests: runTests };
