/**
子进程工具

截图要在三个平台调用外部命令（PowerShell / screencapture / grim），
这里统一处理：建目录、超时强杀、输出收集。不含任何平台分支，
平台差异在 windows.js 与主分派里。
*/

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function ensureDirFor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
function forceKillChild(child) {
    if (!child || !child.pid) {
        return;
    }
    try {
        if (PLATFORM === "win32") {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
            killer.on("error", function () {});
            killer.on("close", function () {});
        } else {
            child.kill("SIGKILL");
        }
    } catch (error) {
        // ignore
    }
}
function runCommand(command, args, options) {
    const opts = options || {};
    const timeout = opts.timeout || 30000;
    const spawnOptions = {};
    Object.keys(opts).forEach(function (key) {
        if (key !== "timeout") {
            spawnOptions[key] = opts[key];
        }
    });
    return new Promise(function (resolve) {
        let child;
        try {
            child = spawn(command, args, Object.assign({ windowsHide: true }, spawnOptions));
        } catch (error) {
            resolve({ ok: false, error: error.message, stdout: "", stderr: "" });
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer = null;
        const finish = function (payload) {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            resolve(payload);
        };
        timer = setTimeout(function () {
            // 超时后强制结束整棵进程树，避免 PowerShell 挂起导致资源泄漏。
            forceKillChild(child);
            finish({
                ok: false,
                error: "timeout after " + timeout + "ms",
                stdout: stdout,
                stderr: stderr,
            });
        }, timeout);
        if (child.stdout) {
            child.stdout.on("data", function (chunk) {
                stdout += chunk.toString();
            });
        }
        if (child.stderr) {
            child.stderr.on("data", function (chunk) {
                stderr += chunk.toString();
            });
        }
        child.on("error", function (error) {
            finish({ ok: false, error: error.message, stdout: stdout, stderr: stderr });
        });
        child.on("close", function (code) {
            finish({ ok: code === 0, code: code, stdout: stdout, stderr: stderr });
        });
    });
}

module.exports = {
    ensureDirFor,
    forceKillChild,
    runCommand,
};
