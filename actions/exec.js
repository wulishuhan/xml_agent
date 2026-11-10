/**
内置动作：exec

从 runtime.js 迁出（P0 动作定义对象化）。run 的方法体与迁移前逐行一致，
只把 this.getWorkspace() 换成 ctx.runtime.getWorkspace()，行为完全不变。

重要：这里刻意使用 child_process.exec（异步）而不是 execSync。
Agent / WebUI 后端运行在 Electron 主进程的事件循环中，execSync 会阻塞整个事件循环：
- Express 无法响应 HTTP 请求（输出轮询 / SSE 心跳卡死）
- Electron 主进程无法处理渲染进程消息与窗口事件 → 窗口被标记"未响应"
- 用户的"停止会话"请求无法被调度，只能强杀进程

可停止性：启动的 child 一律登记到 runtime.processes。用户点"停止"时，
Agent.stop() 会调 runtime.killAllProcesses() 按进程树结束它们，
本动作随之返回 stopped: true（而不是伪装成命令失败）。
*/

const { spawn, exec } = require("child_process");
const agentConfig = require("../config/agent-config");
const logger = require("../logger");

/**
输出裁剪：保留头部与尾部。

只留头部会把最该看的东西丢掉——测试/构建的失败摘要、报错堆栈、"XX passed / YY failed"
几乎都在输出末尾。所以超限时按 6:4 截成 head + 提示 + tail，让模型同时看到
"命令开头在干什么"和"最后结论是什么"。
*/
function limitExecOutput(value, maxSize) {
    const text = value || "";
    const limit = maxSize || agentConfig.runtime.maxExecOutputSize;
    const buffer = Buffer.from(text, "utf8");
    if (buffer.length <= limit) {
        return {
            value: text,
            truncated: false,
        };
    }
    const marker = "\n…[output truncated: " + buffer.length + " bytes total]…\n";
    const markerSize = Buffer.byteLength(marker, "utf8");
    const budget = Math.max(0, limit - markerSize);
    const headSize = Math.floor(budget * 0.6);
    const tailSize = budget - headSize;
    // 按字节切可能落在多字节字符中间，去掉边界上的替换字符避免出现"半个汉字"
    const head = buffer
        .subarray(0, headSize)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
    const tail = buffer
        .subarray(buffer.length - tailSize)
        .toString("utf8")
        .replace(/^\uFFFD/, "");
    return {
        value: head + marker + tail,
        truncated: true,
    };
}

/** 命令末尾的后台标记：只认结尾，避免命令里出现这个字符串就被改写。 */
const BACKGROUND_FLAG = /\s+--background\s*$/;

/**
子进程缓冲上限（不是给模型看的量）。

必须大于 maxExecOutputSize，否则"截断"永远不会走 head+tail 那条路：
输出一旦超过 maxBuffer，exec 直接杀掉进程，尾部（失败摘要所在的位置）就没了。
这里留 8 倍余量，让常见的 1–8MB 输出先被完整收下，再由 limitExecOutput 裁成首尾。
*/
function execBufferSize() {
    const limit = agentConfig.runtime.maxExecOutputSize;
    return Math.max(8 * 1024 * 1024, limit * 8);
}

/**
异步执行前台命令（见文件头注释：必须是异步 API）。
onSpawn 拿到 child 句柄，供调用方登记以便"停止"时能结束它。
*/
function execCommand(command, options, onSpawn) {
    return new Promise((resolve) => {
        let child = null;
        try {
            child = exec(command, options, (error, stdout, stderr) => {
                if (error) {
                    resolve({
                        ok: false,
                        error,
                        stdout,
                        stderr,
                    });
                    return;
                }
                resolve({
                    ok: true,
                    stdout,
                    stderr,
                });
            });
        } catch (error) {
            // 参数非法等同步错误：当成普通失败返回，不抛出
            resolve({
                ok: false,
                error,
                stdout: "",
                stderr: "",
            });
            return;
        }
        if (child && typeof onSpawn === "function") {
            onSpawn(child);
        }
    });
}

/** 被用户停止时的统一结果：ok:false 但语义是"停止"，不是"命令执行失败"。 */
function stoppedResult(command, result) {
    const stdout = limitExecOutput(result && result.stdout);
    const stderr = limitExecOutput(result && result.stderr);
    return {
        ok: false,
        action: "exec",
        command,
        stopped: true,
        exitCode: null,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        error: "Command terminated because the session was stopped",
    };
}

module.exports = {
    name: "exec",
    validate(node) {
        if (!node || typeof node !== "object") {
            throw new Error("exec action is invalid");
        }
        if (!node["@_command"]) {
            throw new Error("exec requires command");
        }
    },
    async run(node, ctx) {
        const workspace = ctx.runtime.getWorkspace();
        const command = node?.["@_command"];
        if (!command) {
            throw new Error("exec requires command");
        }
        logger.info("Executing command:", command);
        // 只认命令结尾的 --background。此前是 command.includes(" --background")：
        // 命令里只要出现这个字符串（比如 node -e "console.log(' --background')"）
        // 就会被当成后台任务，而且这段文本会被直接从命令里删掉。
        const backgroundMatch = BACKGROUND_FLAG.exec(command);
        const isBackground = Boolean(backgroundMatch);
        if (isBackground) {
            const cleanCommand = command.slice(0, backgroundMatch.index).trim();
            logger.info("Running as background process: " + cleanCommand);
            try {
                const child = spawn(cleanCommand, {
                    cwd: workspace,
                    shell: true,
                    env: process.env,
                    detached: true,
                    stdio: "ignore",
                    windowsHide: true,
                });
                child.unref();
                // 登记后，"停止会话"才会连后台进程一起结束；否则它就成了孤儿进程，
                // 一直占着端口，下次启动就报 EADDRINUSE。
                ctx.runtime.trackProcess(child, {
                    command: cleanCommand,
                    kind: "background",
                });
                logger.info("Background process started with PID: " + child.pid);
                return {
                    ok: true,
                    action: "exec",
                    command: cleanCommand,
                    background: true,
                    pid: child.pid,
                    message: "Background process started with PID: " + child.pid,
                };
            } catch (error) {
                logger.error("Background process failed:", error.message);
                return {
                    ok: false,
                    action: "exec",
                    command: cleanCommand,
                    error: error.message,
                };
            }
        }
        // 异步执行：不阻塞事件循环，避免 Electron 主进程卡死
        let handle = null;
        const result = await execCommand(
            command,
            {
                cwd: workspace,
                encoding: "utf8",
                timeout: agentConfig.runtime.maxExecTimeout,
                maxBuffer: execBufferSize(),
                windowsHide: true,
                // POSIX 下让命令自成进程组，停止时可以用负 pid 结束整棵树；
                // Windows 不需要（会导致弹出控制台窗口），那边由 taskkill /T 处理。
                detached: process.platform !== "win32",
            },
            (child) => {
                handle = ctx.runtime.trackProcess(child, {
                    command,
                    kind: "foreground",
                });
            }
        );
        // 被停止的命令不该表现为"执行失败"，否则模型会误以为命令写错了并重试
        if (handle && handle.stopReason) {
            logger.info("Command stopped by user:", command);
            return stoppedResult(command, result);
        }
        if (result.ok) {
            const limitedOutput = limitExecOutput(result.stdout);
            return {
                ok: true,
                action: "exec",
                command,
                output: limitedOutput.value,
                outputTruncated: limitedOutput.truncated,
            };
        }
        const error = result.error || {};
        // 输出超过 maxBuffer 时 exec 会杀掉子进程并回调 ENOBUFS：此时 stdout 正好停在
        // 上限处，后面的内容（通常正是失败摘要）已经被丢弃。必须如实标记 truncated，
        // 否则模型会看到 1MB 文本 + truncated:false，误以为这就是全部输出。
        const bufferOverflow = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const stdout = limitExecOutput(result.stdout);
        const stderr = limitExecOutput(result.stderr);
        logger.error("Command failed:", command, "exitCode:", error.code);
        return {
            ok: false,
            action: "exec",
            command,
            exitCode: typeof error.code === "number" ? error.code : null,
            stdout: stdout.value,
            stderr: stderr.value,
            stdoutTruncated: stdout.truncated || bufferOverflow,
            stderrTruncated: stderr.truncated || bufferOverflow,
            error: bufferOverflow
                ? "Command output exceeded the " +
                  agentConfig.runtime.maxExecOutputSize +
                  "-byte buffer; the process was terminated and the rest of the output was dropped"
                : error.message,
        };
    },
    meta: {
        prompt: {
            group: "workspace",
            usage: '<exec command="npm test"/>',
            // command 是 XML 属性，里面的双引号会把属性提前截断（实测模型写
            // <exec command="python -c "print(1)""/> 时，命令只剩 "python -c "）。
            // 这条提示必须放在模型看得到的地方，否则模型会反复踩。
            note:
                "在 Workspace 下执行命令；末尾加 --background 可后台运行（会话停止时后台进程一并结束）。" +
                "命令里需要引号时用单引号；必须用双引号时写成 &quot;，否则 command 属性会被截断。",
            priority: 90,
        },
        permission: ["shell:exec"],
        mutating: true,
        // 与 runtime.maxExecTimeout 对齐：动作级兜底略大于命令级别的超时
        timeoutMs: 330000,
        summary: (result) => "exec " + (result.command || ""),
    },
};
