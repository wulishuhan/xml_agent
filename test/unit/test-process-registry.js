/**
进程登记表（processes/registry.js）单测

要证明的只有一件事：登记过的子进程，killAll 之后真的没了。
这是"点停止但命令还在跑"那个缺陷的回归测试，所以断言必须看真实进程存活，
不能只看返回值。
*/

const { spawn } = require("child_process");
const { createProcessRegistry, isAlive } = require("../../processes/registry");

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

/** 等 pid 消失，最多等 timeout，避免测试里写死 sleep 时长。 */
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

/** 启动一个只会睡觉的 node 进程，模拟长命令。 */
function startSleeper(detached) {
    const child = spawn(process.execPath, ["-e", "setTimeout(function(){}, 60000)"], {
        stdio: "ignore",
        detached: Boolean(detached),
        windowsHide: true,
    });
    if (detached) {
        child.unref();
    }
    return child;
}

async function main() {
    // 1. 登记后能看到，且不计入已停止
    const registry = createProcessRegistry();
    const child = startSleeper(false);
    const entry = registry.track(child, { command: "sleep", kind: "foreground" });
    check("track 返回 pid", entry.pid === child.pid && Boolean(entry.pid));
    check("activeCount 计入前台进程", registry.activeCount === 1);
    check(
        "list 带命令与类型",
        registry.list()[0].command === "sleep" && registry.list()[0].kind === "foreground"
    );

    // 2. killAll 之后进程真的不在了
    const killed = await registry.killAll("stopped");
    check("killAll 返回结束数量", killed === 1, "count=" + killed);
    check("前台子进程已被结束", await waitGone(child.pid), "pid=" + child.pid);
    check("被停止的 handle 有 stopReason", entry.stopReason === "stopped");
    check("停止后登记表清空", registry.activeCount === 0 && registry.list().length === 0);

    // 3. 后台进程（detached + unref）同样能被结束 —— 这是原来的泄漏点
    const detachedChild = startSleeper(true);
    const detachedEntry = registry.track(detachedChild, { command: "server", kind: "background" });
    check("后台进程已启动并登记", isAlive(detachedChild.pid) && registry.activeCount === 1);
    await registry.killAll("stopped");
    check("后台进程已被结束", await waitGone(detachedChild.pid), "pid=" + detachedChild.pid);
    check("后台 handle 有 stopReason", detachedEntry.stopReason === "stopped");

    // 4. 重复停止是安全的（进程已退出后再调一次不报错、不计数）
    const again = await registry.killAll("stopped");
    check("重复 killAll 返回 0", again === 0, "count=" + again);

    // 5. 自然退出的进程不会一直留在表里
    const shortLived = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true });
    registry.track(shortLived, { command: "true", kind: "foreground" });
    await new Promise((resolve) => shortLived.once("exit", resolve));
    await sleep(50);
    check("自然退出后自动销账", registry.activeCount === 0, "active=" + registry.activeCount);

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
