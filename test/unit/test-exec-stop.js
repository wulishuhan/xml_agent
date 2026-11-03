/**
exec 可停止性单测

回归目标：用户点"停止"时，正在跑的命令必须真的结束，
而不是等 maxExecTimeout（默认 5 分钟）自己超时。
这里用真实子进程验证：runtime.run 的 Promise 会在 killAllProcesses 之后
很快返回，且结果里 stopped 为 true（不是伪装成命令失败）。
*/

const path = require("path");
const { spawn } = require("child_process");
const { createRuntime } = require("../../runtime");
const { isAlive } = require("../../processes/registry");
const { Agent } = require("../../agent-core");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const workspace = path.resolve(__dirname, "..", "..");
    const runtime = createRuntime(workspace);

    // 1. 长命令：60 秒后自己退出，正常情况会挂在这里
    const startedAt = Date.now();
    const pending = runtime.run({
        action: "exec",
        node: { "@_command": 'node -e "setTimeout(function(){}, 60000)"' },
    });

    // 等命令真正启动（exec 外面还有一层 shell，只等 300ms 足够）
    await sleep(300);
    check(
        "命令已被登记为运行中",
        runtime.runningProcessCount === 1,
        "count=" + runtime.runningProcessCount
    );
    const tracked = runtime.listProcesses()[0];
    check(
        "登记信息包含命令",
        Boolean(tracked && tracked.command),
        tracked ? tracked.command : "none"
    );
    const pid = tracked ? tracked.pid : null;
    check("命令进程确实活着", isAlive(pid), "pid=" + pid);

    // 2. 模拟用户点"停止"
    const killed = await runtime.killAllProcesses("stopped");
    check("killAllProcesses 结束 1 个进程", killed === 1, "count=" + killed);

    const result = await pending;
    const elapsed = Date.now() - startedAt;
    check(
        "exec Promise 及时返回（未等到 5 分钟超时）",
        elapsed < 15000,
        "elapsed=" + elapsed + "ms"
    );
    check(
        "结果标记为 stopped",
        result.stopped === true,
        JSON.stringify({ stopped: result.stopped })
    );
    check("结果 ok 为 false", result.ok === false);
    check(
        "错误文案说明是被停止",
        String(result.error || "").indexOf("stopped") !== -1,
        String(result.error || "")
    );
    check("命令进程已消失", !isAlive(pid), "pid=" + pid);
    check("登记表已清空", runtime.runningProcessCount === 0);

    // 3. Agent.stop() 是否真的把这条链路接上（不拉浏览器，直接进入运行中状态）
    const agent = new Agent({ workspace, task: "stop test", provider: "chatgpt" });
    let providerClosed = false;
    agent.status = "running";
    agent.provider = {
        currentConversationId: null,
        async close() {
            providerClosed = true;
        },
    };
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(function(){}, 60000)"], {
        stdio: "ignore",
        windowsHide: true,
    });
    const handle = agent.runtime.trackProcess(sleeper, { command: "sleep", kind: "foreground" });
    const stopped = await agent.stop();
    check("Agent.stop 返回 true", stopped === true);
    check("停止后状态为 stopped", agent.status === "stopped");
    check("停止时子进程被结束", !isAlive(sleeper.pid), "pid=" + sleeper.pid);
    check("handle 标记了停止原因", handle.stopReason === "stopped", String(handle.stopReason));
    check("停止时仍然关闭了 provider", providerClosed === true);
    check("停止后登记表为空", agent.runtime.runningProcessCount === 0);

    // 4. 非运行状态重复调用 stop 是幂等的
    check("重复 stop 返回 false", (await agent.stop()) === false);

    console.log("");
    console.log("total " + total + ", pass " + pass + ", fail " + (total - pass));
    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("test crashed:", error);
    process.exitCode = 1;
});
