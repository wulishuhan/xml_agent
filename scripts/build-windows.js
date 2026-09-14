/**
自定义 Windows 打包脚本，绕过 electron-builder 的环境问题：

问题 1：electron-builder 解压缓存 electron zip 不完整，
导致 win-unpacked 缺少 electron.exe，进而报：
ENOENT: rename 'win-unpacked\electron.exe' -> 'win-unpacked\XMLAgent.exe'
解决：使用 --config.electronDist=node_modules/electron/dist 让它直接拷贝目录。

问题 2：electron-builder 需要下载 winCodeSign-2.6.0.7z / nsis-3.0.4.1.7z /
nsis-resources-3.4.1.7z，在部分网络环境（公司代理、自签 CA、无法访问 GitHub）
下会失败。
解决：先运行 scripts/prepare-offline-cache.js，把手动下载到 download/ 的 .7z
解压到 electron-builder 默认缓存，electron-builder 会直接复用，不再联网。

问题 3：上一次运行 XMLAgent.exe 后进程没有退出，会锁住 release/win-unpacked
下的文件，导致重新构建时报：
EBUSY: resource busy or locked, unlink '...\win-unpacked\icudtl.dat'
解决：构建前自动结束本产品的 XMLAgent.exe 进程（仅 Windows，且只结束
名字为 XMLAgent.exe 的进程，不影响其它程序）。

使用方式：node scripts/build-windows.js
*/

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const projectRoot = path.join(__dirname, "..");
const electronBuilderBin = path.join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
);

const ELECTRON_DIST_REL = path.join("node_modules", "electron", "dist");

// 用户默认缓存（electron-builder 自动查找）
const userCacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "electron-builder",
    "Cache"
);
const userWinCodeSignDir = path.join(userCacheRoot, "winCodeSign", "winCodeSign-2.6.0");
const userNsisDir = path.join(userCacheRoot, "nsis", "nsis-3.0.4.1");

/**

结束残留的 XMLAgent.exe 进程，避免 release/win-unpacked 下的文件被占用

导致 electron-builder 覆盖时 EBUSY。

只结束名为 XMLAgent.exe 的进程，不影响其它程序。
*/
function killRunningAppProcesses() {
    if (process.platform !== "win32") {
        return;
    }

    const listResult = spawnSync("tasklist", ["/FI", "IMAGENAME eq XMLAgent.exe", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
    });

    const listOutput = listResult.stdout || "";

    if (listOutput.toLowerCase().indexOf("xmlagent.exe") === -1) {
        return;
    }

    console.log("[build-windows] detected running XMLAgent.exe, terminating...");

    spawnSync("taskkill", ["/F", "/IM", "XMLAgent.exe"], {
        encoding: "utf8",
        windowsHide: true,
    });

    // 等待文件句柄释放（最多 3 秒）
    const deadline = Date.now() + 3000;

    while (Date.now() < deadline) {
        const check = spawnSync("tasklist", ["/FI", "IMAGENAME eq XMLAgent.exe", "/NH"], {
            encoding: "utf8",
            windowsHide: true,
        });

        if ((check.stdout || "").toLowerCase().indexOf("xmlagent.exe") === -1) {
            console.log("[build-windows] XMLAgent.exe terminated");
            return;
        }

        const sleepResult = spawnSync("cmd", ["/c", "ping -n 1 -w 200 127.0.0.1 >nul"], {
            windowsHide: true,
        });

        void sleepResult;
    }

    console.warn("[build-windows] XMLAgent.exe still running after timeout");
}

function runElectronBuilder(args, env) {
    console.log("[build-windows] electron-builder " + args.join(" "));

    const result = spawnSync(electronBuilderBin, args, {
        cwd: projectRoot,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: env || process.env,
    });

    if (result.error) {
        throw result.error;
    }

    if (typeof result.status === "number" && result.status !== 0) {
        const error = new Error(
            "electron-builder exited with code " + result.status + " for args: " + args.join(" ")
        );
        error.exitCode = result.status;
        throw error;
    }
}

function tryElectronBuilder(args, env) {
    try {
        runElectronBuilder(args, env);
        return true;
    } catch (error) {
        console.warn("[build-windows] warning: " + error.message);
        return false;
    }
}

function runNodeScript(relativePath) {
    const scriptPath = path.join(projectRoot, relativePath);

    console.log("[build-windows] node " + relativePath);

    const result = spawnSync(process.execPath, [scriptPath], {
        cwd: projectRoot,
        stdio: "inherit",
    });

    if (result.error) {
        throw result.error;
    }

    if (typeof result.status === "number" && result.status !== 0) {
        const error = new Error("node " + relativePath + " exited with code " + result.status);
        error.exitCode = result.status;
        throw error;
    }
}

function main() {
    try {
        // 关键：先结束残留进程，避免 EBUSY
        killRunningAppProcesses();

        const hasWinCodeSign = fs.existsSync(path.join(userWinCodeSignDir, "rcedit-x64.exe"));
        const hasNsis = fs.existsSync(path.join(userNsisDir, "makensis.exe"));

        if (hasWinCodeSign) {
            console.log("[build-windows] local winCodeSign ready at " + userWinCodeSignDir);
        } else {
            console.warn(
                "[build-windows] local winCodeSign missing; run npm run electron:offline-cache " +
                    "after putting winCodeSign-2.6.0.7z in download/"
            );
        }

        if (hasNsis) {
            console.log("[build-windows] local nsis ready at " + userNsisDir);
        } else {
            console.warn(
                "[build-windows] local nsis missing; installer targets will be skipped. " +
                    "Put nsis-3.0.4.1.7z in download/ and run npm run electron:offline-cache."
            );
        }

        // 使用 electron-builder 默认缓存，不覆盖 ELECTRON_BUILDER_CACHE。
        const env = process.env;

        const baseArgs = ["--config.electronDist=" + ELECTRON_DIST_REL];

        // 没有本地 winCodeSign 时跳过 rcedit，避免联网下载
        if (!hasWinCodeSign) {
            baseArgs.push("--config.win.signAndEditExecutable=false");
        }

        // 第一步：dir 构建（win-unpacked 免安装目录）必须成功
        runElectronBuilder(["--win", "dir"].concat(baseArgs), env);

        runNodeScript(path.join("scripts", "postbuild-fix-exe.js"));

        // 第二步：NSIS / portable 安装包
        if (!hasNsis) {
            console.warn(
                "[build-windows] installer targets skipped: no local nsis found. " +
                    "Portable build is available at release/win-unpacked/XMLAgent.exe"
            );
        } else {
            const installerOk = tryElectronBuilder(
                ["--win", "nsis", "portable"].concat(baseArgs),
                env
            );

            if (!installerOk) {
                console.warn(
                    "[build-windows] installer targets failed. " +
                        "Portable build is available at release/win-unpacked/XMLAgent.exe"
                );
            }
        }
    } catch (error) {
        console.error("[build-windows] failed:", error.message);
        process.exitCode = error.exitCode || 1;
    }
}

main();
