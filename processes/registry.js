/**
进程登记表

为什么需要它：exec 动作会启动子进程，其中 `--background` 走的是
`spawn({ detached: true })` + `unref()` —— 子进程彻底脱离父进程。
如果只保留"启动"，不保留"句柄"，用户在界面上点"停止"时就只能停掉
Agent 的状态标志，真正在跑的 npm / node / 服务器进程会一直留在系统里，
占着端口、占着 CPU，下次再跑就报端口占用。

所以这里的职责很窄，只有三件事：
1. 登记：谁启动了哪个子进程（pid / 命令 / 前台还是后台）；
2. 结束：按 pid 杀掉**整棵进程树**（Windows 用 taskkill /T，POSIX 用进程组），
   因为 `exec` 外面还包着一层 shell，只杀 shell 会留下孙子进程；
3. 记账：给调用方留一个 stopReason，让 exec 能区分
   "命令自己失败" 和 "命令被用户停止"，从而给出准确的错误文案；
4. 退出兜底：进程被 `process.exit()`、未捕获异常等非正常路径带走时，
   在 `exit` 事件里同步结束还活着的子进程（见 installExitGuard）。

平台差异集中在 killTree / killTreeSync 里，其余代码不关心平台。
*/

const { spawn, spawnSync } = require("child_process");
const logger = require("../logger");

const IS_WINDOWS = process.platform === "win32";

/**
当前还有在册进程的登记表。一个 Agent 一个登记表，进程级兜底（exit）必须能看到全部，
否则退出时只清掉最后一个会话的进程。
*/
const liveRegistries = new Set();

/**
 * pid 是否还活着。
 * 信号 0 不发信号，只做存在性检查；EPERM 说明进程存在但无权操作，同样算活着。
 */
function isAlive(pid) {
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && error.code === "EPERM";
    }
}

/**
 * 结束整棵进程树。返回 Promise<boolean>，true 表示系统接受了这次结束请求。
 * 这里刻意不抛错：停止流程本身不应该因为"进程已经退出"而失败。
 */
function killTree(pid) {
    return new Promise((resolve) => {
        if (!pid) {
            resolve(false);
            return;
        }
        if (IS_WINDOWS) {
            let settled = false;
            const finish = (ok) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(ok);
            };
            let killer = null;
            try {
                // /T 连带子进程，/F 强制 —— 不加 /F 时 GUI 与部分子进程会忽略结束请求
                killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                });
            } catch (error) {
                finish(false);
                return;
            }
            // taskkill 本身卡住时不能让停止流程一起卡住
            const timer = setTimeout(() => {
                try {
                    killer.kill();
                } catch (error) {
                    // ignore
                }
                finish(false);
            }, 3000);
            if (typeof timer.unref === "function") {
                timer.unref();
            }
            killer.on("error", () => {
                clearTimeout(timer);
                finish(false);
            });
            killer.on("close", (code) => {
                clearTimeout(timer);
                finish(code === 0);
            });
            return;
        }
        // POSIX：exec / spawn 时都设了 detached，子进程自成进程组，负号 pid 即整组
        let signaled = false;
        try {
            process.kill(-pid, "SIGTERM");
            signaled = true;
        } catch (error) {
            try {
                process.kill(pid, "SIGTERM");
                signaled = true;
            } catch (inner) {
                // 进程可能已经退出
            }
        }
        // 宽限期后仍在，强杀，避免 shell 忽略 SIGTERM 后一直挂着
        const hardKill = setTimeout(() => {
            if (!isAlive(pid)) {
                return;
            }
            try {
                process.kill(-pid, "SIGKILL");
            } catch (error) {
                try {
                    process.kill(pid, "SIGKILL");
                } catch (inner) {
                    // ignore
                }
            }
        }, 2000);
        if (typeof hardKill.unref === "function") {
            hardKill.unref();
        }
        resolve(signaled);
    });
}

/**
 * 进程登记表。一个 Runtime 持有一个实例，因此"停止这个会话"
 * 能且只能结束这个会话自己启动的进程，不会误伤其他会话。
 */
/**
killTree 的同步版本。

只在进程退出路径上用（`process.on("exit")` 里不能 await，事件循环已经停了）。
代价是阻塞到 taskkill 返回（Windows 下几十毫秒），但退出时没有别的选择：
不阻塞就什么都不做，进程必然泄漏。
*/
function killTreeSync(pid) {
    if (!pid) {
        return false;
    }
    if (IS_WINDOWS) {
        try {
            const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
                // taskkill 自己卡住时不能把退出流程一起拖住
                timeout: 3000,
            });
            return !!(result && result.status === 0);
        } catch (error) {
            return false;
        }
    }
    try {
        process.kill(-pid, "SIGKILL");
        return true;
    } catch (error) {
        try {
            process.kill(pid, "SIGKILL");
            return true;
        } catch (inner) {
            return false;
        }
    }
}

class ProcessRegistry {
    constructor() {
        // pid -> entry。用 pid 作键：同一时刻不会有两个子进程共用一个 pid。
        this.entries = new Map();
    }

    /**
     * 登记子进程，返回可读的 handle。
     * handle.stopReason 由 killAll 写入，调用方据此判断"是否被停止"。
     */
    track(child, meta = {}) {
        const entry = {
            pid: child && child.pid ? child.pid : null,
            command: meta.command || "",
            // foreground：动作在等结果；background：已 unref 独立运行
            kind: meta.kind || "foreground",
            startedAt: Date.now(),
            stopReason: null,
            child: child || null,
        };
        if (!entry.pid) {
            return entry;
        }
        this.entries.set(entry.pid, entry);
        liveRegistries.add(this);
        // 只要登记过进程，就保证退出时有人兜底：不依赖某个入口记得调用
        installExitGuard();
        if (child && typeof child.once === "function") {
            // 子进程自然退出时自动销账；detached + unref 的后台进程可能不触发，
            // 那种情况由 killAll 里的存活检查兜底。
            child.once("exit", () => this.forget(entry));
            child.once("error", () => this.forget(entry));
        }
        return entry;
    }

    forget(entry) {
        if (!entry || !entry.pid) {
            return;
        }
        if (this.entries.get(entry.pid) === entry) {
            this.entries.delete(entry.pid);
            if (this.entries.size === 0) {
                liveRegistries.delete(this);
            }
        }
    }

    /** 仍然在册且真的活着的进程数（detached 进程退出后可能没触发 exit，这里剔除）。 */
    get activeCount() {
        let count = 0;
        for (const entry of this.entries.values()) {
            if (!entry.stopReason && isAlive(entry.pid)) {
                count++;
            }
        }
        return count;
    }

    /** 供状态展示/排查用，不含 child 对象。 */
    list() {
        const items = [];
        for (const entry of this.entries.values()) {
            if (!isAlive(entry.pid)) {
                continue;
            }
            items.push({
                pid: entry.pid,
                command: entry.command,
                kind: entry.kind,
                startedAt: new Date(entry.startedAt).toISOString(),
                stopReason: entry.stopReason,
            });
        }
        return items;
    }

    /**
     * 结束本登记表里的所有进程。返回结束的数量。
     * 先打标记再杀：正在 await 命令结果的调用方能立刻知道这是"被停止"。
     */
    async killAll(reason = "stopped") {
        const targets = [];
        for (const entry of this.entries.values()) {
            if (!entry.stopReason) {
                entry.stopReason = reason;
            }
            // 已经不在了也一并销账，避免登记表无限增长
            if (isAlive(entry.pid)) {
                targets.push(entry);
            }
        }
        if (!targets.length) {
            this.entries.clear();
            return 0;
        }
        logger.info(
            "Killing " +
                targets.length +
                " child process(es) of this session: " +
                targets.map((entry) => entry.pid).join(", ")
        );
        await Promise.all(targets.map((entry) => killTree(entry.pid)));
        // 只销掉"已结束"的条目：万一在 await 期间又有新进程登记，不能把它弄丢。
        for (const entry of Array.from(this.entries.values())) {
            if (entry.stopReason || !isAlive(entry.pid)) {
                this.forget(entry);
            }
        }
        return targets.length;
    }

    /**
    进程即将退出时的同步收摊。返回结束的数量。

    和 killAll 的区别：这里不能 await。`process.on("exit")` 触发时事件循环已经停了，
    异步的 taskkill 回调永远不会执行 —— 所以必须用 spawnSync。

    覆盖的场景：正常退出、`process.exit()` 显式退出、未捕获异常导致进程终止。
    覆盖不到的：任务管理器强杀 / 断电（进程没有机会执行任何代码），
    这类残留只能靠下次启动时的回收，不属于这里。
    */
    disposeSync(reason = "exit") {
        const targets = [];
        for (const entry of this.entries.values()) {
            if (!entry.stopReason) {
                entry.stopReason = reason;
            }
            // 子进程句柄自己说还活着才算数：已退出的进程 pid 可能已被系统复用
            const stillRunning = entry.child ? entry.child.exitCode === null : isAlive(entry.pid);
            if (stillRunning && isAlive(entry.pid)) {
                targets.push(entry);
            }
        }
        this.entries.clear();
        liveRegistries.delete(this);
        if (!targets.length) {
            return 0;
        }
        let killed = 0;
        for (const entry of targets) {
            if (killTreeSync(entry.pid)) {
                killed++;
            }
        }
        return killed;
    }
}

/**
结束所有登记表里的进程（同步）。给进程退出路径用。
返回被结束的进程总数，供日志与测试断言。
*/
function cleanupAllSync(reason = "exit") {
    let total = 0;
    for (const registry of Array.from(liveRegistries)) {
        try {
            total += registry.disposeSync(reason);
        } catch (error) {
            // 退出路径上不能再抛：抛出去会让剩下的进程彻底失去清理机会
        }
    }
    return total;
}

let exitGuardInstalled = false;

/**
安装进程退出兜底。幂等，由 track() 在第一次登记子进程时自动调用，
因此不需要每个入口（CLI / WebUI / Electron）自己记得接。

为什么挂在 exit 上：agent.stop() 覆盖的是"用户点了停止"，
而进程崩溃、`process.exit()`、未捕获异常走的是另一条路径，那条路径上
没有任何人调用 stop()。exit 是最后一道能执行代码的机会。
*/
function installExitGuard() {
    if (exitGuardInstalled || typeof process.once !== "function") {
        return;
    }
    exitGuardInstalled = true;
    process.once("exit", () => {
        try {
            const count = cleanupAllSync("exit");
            if (count > 0) {
                // 退出时控制台可能已经关了，写日志也不亏
                logger.warn("Killed " + count + " leftover child process(es) on exit");
            }
        } catch (error) {
            // 同上：退出路径吞掉，避免影响退出码
        }
    });
}

function createProcessRegistry() {
    return new ProcessRegistry();
}

module.exports = {
    ProcessRegistry,
    createProcessRegistry,
    killTree,
    killTreeSync,
    cleanupAllSync,
    installExitGuard,
    isAlive,
};
