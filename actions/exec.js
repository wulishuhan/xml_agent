/**
内置动作：exec

从 runtime.js 迁出（P0 动作定义对象化）。run 的方法体与迁移前逐行一致，
只把 this.getWorkspace() 换成 ctx.runtime.getWorkspace()，行为完全不变。

重要：这里刻意使用 child_process.exec（异步）而不是 execSync。
Agent / WebUI 后端运行在 Electron 主进程的事件循环中，execSync 会阻塞整个事件循环：
- Express 无法响应 HTTP 请求（输出轮询 / SSE 心跳卡死）
- Electron 主进程无法处理渲染进程消息与窗口事件 → 窗口被标记"未响应"
- 用户的"停止会话"请求无法被调度，只能强杀进程
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
*/
function execCommand(command, options) {
    return new Promise((resolve) => {
        exec(command, options, (error, stdout, stderr) => {
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
    });
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
        const result = await execCommand(command, {
            cwd: workspace,
            encoding: "utf8",
            timeout: agentConfig.runtime.maxExecTimeout,
            maxBuffer: agentConfig.runtime.maxExecOutputSize,
            windowsHide: true,
        });
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
            note: "在 Workspace 下执行命令；末尾加 --background 可后台运行。",
            priority: 90,
        },
        permission: ["shell:exec"],
        mutating: true,
        // 与 runtime.maxExecTimeout 对齐：动作级兜底略大于命令级别的超时
        timeoutMs: 330000,
        summary: (result) => "exec " + (result.command || ""),
    },
};
