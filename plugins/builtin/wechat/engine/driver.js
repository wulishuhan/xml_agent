/**
微信桌面版驱动（Windows）

把引擎脚本（wechat-windows.ps1）落到临时目录再执行，而不是直接 spawn 插件目录里
的那份：打包后插件在 app.asar 里，child_process 打不开 asar 内的路径，而
fs.readFileSync 可以。截图插件对 C# 源码用的是同一套办法。

Windows PowerShell 5.1 默认按 ANSI 解码无 BOM 文件，脚本本身是纯 ASCII，
这里仍然补一个 BOM，避免以后有人在里面写中文时踩坑。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SCRIPT_PATH = path.join(__dirname, "wechat-windows.ps1");
const SCRIPT_NAME = "wechat-windows.ps1";

function tmpDir() {
    return os.tmpdir();
}

function materializeScript() {
    const text = fs.readFileSync(SCRIPT_PATH, "utf8");
    const target = path.join(tmpDir(), SCRIPT_NAME);
    const withBom = text.charCodeAt(0) === 0xfeff ? text : "\ufeff" + text;
    fs.writeFileSync(target, withBom, "utf8");
    return target;
}

function unique(prefix, ext) {
    const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    return path.join(tmpDir(), prefix + "-" + stamp + ext);
}

function killTree(child) {
    if (!child || !child.pid) {
        return;
    }

    try {
        if (process.platform === "win32") {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
        } else {
            child.kill("SIGKILL");
        }
    } catch (error) {
        // 进程可能已经退出，忽略
    }
}

/**
执行一次引擎动作。
返回解析后的 JSON（脚本自己写 out.json），以及 stdout/stderr 便于排查。
脚本永远以 exit 0 结束，失败原因写在 JSON 的 error 字段里 —— 这样"拒发"和
"崩溃"不会混在一起。
*/
function runAction(action, options) {
    const opts = options || {};

    return new Promise((resolve) => {
        if (process.platform !== "win32") {
            resolve({
                ok: false,
                action: action,
                error: "wechat 插件只支持 Windows 桌面版微信（当前平台 " + process.platform + "）",
            });
            return;
        }

        let script;
        try {
            script = materializeScript();
        } catch (error) {
            resolve({ ok: false, action: action, error: "无法写出驱动脚本：" + error.message });
            return;
        }

        const outJson = unique("wx-out", ".json");
        const args = [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-Action",
            action,
            "-OutJson",
            outJson,
        ];

        let payloadFile = null;
        if (typeof opts.payload === "string") {
            payloadFile = unique("wx-payload", ".txt");
            fs.writeFileSync(payloadFile, opts.payload, "utf8");
            args.push("-PayloadFile", payloadFile);
        }
        if (opts.outPng) {
            args.push("-OutPng", opts.outPng);
        }
        if (opts.expectTitle) {
            args.push("-ExpectTitle", opts.expectTitle);
        }

        const timeoutMs = opts.timeoutMs || 60000;
        const startedAt = Date.now();
        let stdout = "";
        let stderr = "";
        let settled = false;

        const child = spawn("powershell.exe", args, { windowsHide: true });
        const timer = setTimeout(() => {
            killTree(child);
            finish({
                ok: false,
                action: action,
                error: "驱动脚本超时（" + timeoutMs + "ms）",
                timedOut: true,
            });
        }, timeoutMs);

        function finish(result) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve(
                Object.assign({ durationMs: Date.now() - startedAt }, result, {
                    stdoutTail: stdout.slice(-400) || undefined,
                    stderrTail: stderr.slice(-400) || undefined,
                })
            );
        }

        function cleanup() {
            for (const file of [payloadFile, outJson]) {
                if (!file) {
                    continue;
                }
                try {
                    fs.unlinkSync(file);
                } catch (error) {
                    // 文件可能已被脚本删掉
                }
            }
        }

        if (child.stdout) {
            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
            });
        }
        if (child.stderr) {
            child.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
            });
        }
        child.on("error", (error) => {
            finish({ ok: false, action: action, error: "无法启动 PowerShell：" + error.message });
        });
        child.on("close", () => {
            let parsed = null;
            try {
                parsed = JSON.parse(fs.readFileSync(outJson, "utf8"));
            } catch (error) {
                parsed = null;
            }

            if (!parsed) {
                finish({
                    ok: false,
                    action: action,
                    error:
                        "驱动脚本没有返回结果" +
                        (stderr ? "：" + stderr.trim().split("\n").pop() : ""),
                    rawStdout: stdout.trim().slice(0, 300) || undefined,
                });
                return;
            }
            finish(parsed);
        });
    });
}

module.exports = {
    runAction,
    // 供单测直接调用的纯函数
    materializeScript,
};
