/**
退出兜底（processes/registry.js 的 installExitGuard / disposeSync / killTreeSync）单测

要证明的事：没人调用 stop() 的时候，子进程也不能留成孤儿。

上一版只覆盖了"用户点停止"这条路径。进程被 `process.exit()` 带走、
或者抛未捕获异常终止时，走的是另一条路径 —— 那条路径上没人调用 Agent.stop()，
子进程就留在了系统里占端口。这里用真实进程验证兜底确实执行了。
*/

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    createProcessRegistry,
    cleanupAllSync,
    installExitGuard,
    killTreeSync,
    isAlive,
} = require("../../processes/registry");

const REGISTRY_PATH = path.join(__dirname, "..", "..", "processes", "registry.js");

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

async function waitGone(pid, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (!isAlive(pid)) {
            return true;
        }
        await sleep(50);
    }
    return !isAlive(pid);
}

/** 只会睡觉的 node 进程，模拟长命令。 */
function startSleeper(detached) {
    return spawn(process.execPath, ["-e", "setTimeout(function(){}, 60000)"], {
        stdio: "ignore",
        detached: Boolean(detached),
        windowsHide: true,
    });
}

async function testKillTreeSync() {
    const child = startSleeper(false);
    await sleep(100);
    check("sleeper 已启动", isAlive(child.pid), "pid=" + child.pid);

    const ok = killTreeSync(child.pid);
    check("killTreeSync 报告成功", ok === true);
    check("killTreeSync 后进程消失", await waitGone(child.pid), "pid=" + child.pid);

    // 已经退出的 pid：不该误报成功，也不该抛
    const again = killTreeSync(child.pid);
    check("对已退出进程 killTreeSync 不抛错", typeof again === "boolean");
    check("空 pid 直接返回 false", killTreeSync(null) === false);
}

async function testDisposeSyncAcrossRegistries() {
    // 两个登记表 = 两个会话。进程级兜底必须一个都不落下。
    const first = createProcessRegistry();
    const second = createProcessRegistry();
    const childA = startSleeper(true);
    const childB = startSleeper(true);
    first.track(childA, { command: "sleeper-a", kind: "background" });
    second.track(childB, { command: "sleeper-b", kind: "background" });
    await sleep(120);

    const killed = cleanupAllSync("test");
    check("cleanupAllSync 覆盖全部登记表", killed === 2, "killed=" + killed);
    check("第一个会话的进程已结束", await waitGone(childA.pid), "pid=" + childA.pid);
    check("第二个会话的进程已结束", await waitGone(childB.pid), "pid=" + childB.pid);
    check("登记表已清空", first.activeCount === 0 && second.activeCount === 0);

    // 再调一次不该重复计数（没有进程了）
    check("无进程时 cleanupAllSync 返回 0", cleanupAllSync("test") === 0);
}

/**
核心回归：子进程里登记一个后台进程，然后直接 process.exit(0) ——
模拟崩溃/显式退出，全程没有任何人调用 stop()。
退出后那个后台进程必须已经被兜底结束。
*/
async function testExitGuardOnHardExit() {
    const pidFile = path.join(os.tmpdir(), "xml-agent-exit-guard-" + process.pid + ".pid");
    try {
        fs.unlinkSync(pidFile);
    } catch (error) {
        // 本来就不存在
    }

    const script = [
        'const { spawn } = require("child_process");',
        'const fs = require("fs");',
        "const { createProcessRegistry } = require(" + JSON.stringify(REGISTRY_PATH) + ");",
        'const child = spawn(process.execPath, ["-e", "setTimeout(function(){},60000)"], {',
        '    stdio: "ignore",',
        "    detached: true,",
        "    windowsHide: true,",
        "});",
        "child.unref();",
        'createProcessRegistry().track(child, { command: "orphan", kind: "background" });',
        "fs.writeFileSync(" + JSON.stringify(pidFile) + ", String(child.pid));",
        "process.exit(0);",
    ].join("\n");

    const helper = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const code = await new Promise((resolve) => helper.on("exit", resolve));
    check("子进程正常退出", code === 0, "code=" + code);

    let orphanPid = 0;
    try {
        orphanPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    } catch (error) {
        orphanPid = 0;
    }
    try {
        fs.unlinkSync(pidFile);
    } catch (error) {
        // ignore
    }
    check("拿到孤儿进程 pid", orphanPid > 0, "pid=" + orphanPid);
    check("退出兜底结束后台进程（不再需要 stop()）", await waitGone(orphanPid), "pid=" + orphanPid);
}

/**
信号路径：SIGTERM / SIGINT 的默认处理是直接终止进程，**不会**触发 exit 事件，
因此入口必须在信号处理里显式调 cleanupAllSync（agent.js / webui/server.js / electron）。
这里按同样写法验证：带 handler 的会被清掉，不带的会留成孤儿。
*/
async function testSignalPath() {
    const buildScript = (withHandler) => {
        const pidFile = path.join(
            os.tmpdir(),
            "xml-agent-signal-" + (withHandler ? "on" : "off") + "-" + process.pid + ".pid"
        );
        const lines = [
            'const { spawn } = require("child_process");',
            'const fs = require("fs");',
            "const { createProcessRegistry, cleanupAllSync } = require(" +
                JSON.stringify(REGISTRY_PATH) +
                ");",
            'const child = spawn(process.execPath, ["-e", "setTimeout(function(){},60000)"], {',
            '    stdio: "ignore",',
            "    detached: true,",
            "    windowsHide: true,",
            "});",
            "child.unref();",
            'createProcessRegistry().track(child, { command: "orphan", kind: "background" });',
            "fs.writeFileSync(" + JSON.stringify(pidFile) + ", String(child.pid));",
        ];
        if (withHandler) {
            // 与入口一致的写法：同步收摊后再退出
            lines.push('process.on("SIGTERM", () => {');
            lines.push('    cleanupAllSync("signal");');
            lines.push("    process.exit(0);");
            lines.push("});");
            // Windows 上外部 kill 走的是 TerminateProcess，信号不会投递给 JS，
            // 因此这里在进程内部触发一次，验证的是入口那段处理代码本身。
            lines.push('setTimeout(() => process.emit("SIGTERM"), 100);');
        }
        lines.push("setInterval(function(){}, 1000);");
        return { script: lines.join("\n"), pidFile };
    };

    const run = async (withHandler) => {
        const { script, pidFile } = buildScript(withHandler);
        try {
            fs.unlinkSync(pidFile);
        } catch (error) {
            // 本来就不存在
        }
        const helper = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !fs.existsSync(pidFile)) {
            await sleep(50);
        }
        const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
        const exited = new Promise((resolve) => helper.on("exit", resolve));
        if (!withHandler) {
            // 对照组：没有信号处理，外部终止进程（Windows 上是 TerminateProcess，
            // POSIX 上是默认 SIGTERM），JS 侧没有任何机会收摊
            helper.kill("SIGTERM");
        }
        await exited;
        const gone = await waitGone(pid);
        try {
            fs.unlinkSync(pidFile);
        } catch (error) {
            // ignore
        }
        return { pid, gone };
    };

    const withHandler = await run(true);
    check("信号处理里同步收摊 → 后台进程被结束", withHandler.gone, "pid=" + withHandler.pid);

    const withoutHandler = await run(false);
    check(
        "对照：信号无处理 → 后台进程留下（说明必须显式收摊）",
        !withoutHandler.gone,
        "pid=" + withoutHandler.pid
    );
    // 对照组留下的进程由这里清掉，别污染环境
    killTreeSync(withoutHandler.pid);
    await waitGone(withoutHandler.pid, 3000);
}

function testInstallExitGuardIdempotent() {
    const before = process.listenerCount("exit");
    installExitGuard();
    installExitGuard();
    installExitGuard();
    const after = process.listenerCount("exit");
    check(
        "installExitGuard 幂等（只挂一个 exit 监听）",
        after - before <= 1,
        before + " -> " + after
    );
}

async function main() {
    await testKillTreeSync();
    await testDisposeSyncAcrossRegistries();
    await testExitGuardOnHardExit();
    await testSignalPath();
    testInstallExitGuardIdempotent();

    console.log("");
    console.log("total " + total + ", pass " + pass + ", fail " + (total - pass));
    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("FAIL - 测试自身异常:", error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
