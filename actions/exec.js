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
    return {
        value: buffer.subarray(0, limit).toString("utf8"),
        truncated: true,
    };
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
        const isBackground = command.includes(" --background");
        if (isBackground) {
            const cleanCommand = command.replace(/ --background/g, "");
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
                maxBuffer: agentConfig.runtime.maxExecOutputSize,
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
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            error: error.message,
        };
    },
    meta: {
        prompt: {
            group: "workspace",
            usage: '<exec command="npm test"/>',
            note: "在 Workspace 下执行命令；末尾加 --background 可后台运行（会话停止时后台进程一并结束）。",
            priority: 90,
        },
        permission: ["shell:exec"],
        mutating: true,
        // 与 runtime.maxExecTimeout 对齐：动作级兜底略大于命令级别的超时
        timeoutMs: 330000,
        summary: (result) => "exec " + (result.command || ""),
    },
};
