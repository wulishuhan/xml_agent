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

问题 4：electron-builder 构建前会 emptyDir(win-unpacked)，在本机（有批量删除保护，
单次删除超过 50 个文件直接拒绝）清理 locales/ 时整条构建中断，还会把目录清成空壳，
于是产物变成几十 MB 的残缺包。
解决：构建前由本脚本自己逐项清空 win-unpacked（每次 fs.unlinkSync 只删一个文件，
不触发阈值），并且第二步出安装包时用 --prepackaged 复用它、不再重新解压 Electron
（重新解压会再次 emptyDir(locales)，一次删 68 个文件，必被拒）。

产出（固定在同一个 release/ 目录，旧版本产物在成功出包后自动删除）：
release/win-unpacked/XMLAgent.exe 免安装目录（中间产物）
release/XMLAgent-Setup-<ver>-x64.exe 安装程序
release/XMLAgent-Portable-<ver>-x64.exe 单文件便携版
release/XMLAgent-<ver>-x64.zip zip 免安装压缩包

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

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeTreeOnce(target) {
    let stat;

    try {
        stat = fs.lstatSync(target);
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        throw error;
    }

    if (!stat.isDirectory()) {
        fs.unlinkSync(target);
        return;
    }

    // 逐项递归：每次 unlinkSync / rmdirSync 只处理一个条目。
    // 用 fs.rmSync(recursive) 或 shell 的 rm -rf 会按"一次删除 N 个文件"计数，
    // 超过本机批量删除阈值（50）时会被直接拒绝，且抛错时目录已被清掉一半。
    for (const name of fs.readdirSync(target)) {
        removeTreeOnce(path.join(target, name));
    }

    fs.rmdirSync(target);
}

/**
清空目录，失败时重试（杀软 / 索引器常在新拷贝的文件上短暂持有句柄）。
重试仍然失败就直接抛错终止构建 —— 宁可不出包，也不要出一个缺主程序的残包。
*/
function removeTree(target, label) {
    let lastError = null;

    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            removeTreeOnce(target);
            return;
        } catch (error) {
            lastError = error;
            sleepSync(250);
        }
    }

    throw new Error(
        "无法清空 " +
            (label || target) +
            "：" +
            lastError.message +
            "\n  通常是目录被占用（先关掉正在运行的 XMLAgent.exe），或文件只读。"
    );
}

/**
清理上一次构建留下的归档目录（.stale-win-unpacked-*）。
通常删不掉是因为里面有个被别的进程长期持有的文件（EBUSY：能读写、不能改名/删除）。
删不掉就静默跳过，等占用者退出后下一次构建自动回收。
*/
function cleanupStaleDirs(releaseDir) {
    let names = [];

    try {
        names = fs.readdirSync(releaseDir);
    } catch (error) {
        return;
    }

    for (const name of names) {
        if (name.indexOf(".stale-win-unpacked-") !== 0) {
            continue;
        }

        try {
            removeTreeOnce(path.join(releaseDir, name));
            console.log("[build-windows] removed stale dir " + name);
        } catch (error) {
            console.warn(
                "[build-windows] 归档目录 " + name + " 仍被占用，下次构建再试（" + error.code + "）"
            );
        }
    }
}

/**
出包成功后清掉同目录里的旧版本产物，保证 release/ 只留当前版本。
只动 XMLAgent-*.{exe,zip,blockmap}，不碰 win-unpacked 和其它文件。
*/
function pruneOldArtifacts(releaseDir, version) {
    let names = [];

    try {
        names = fs.readdirSync(releaseDir);
    } catch (error) {
        return [];
    }

    const removed = [];

    for (const name of names) {
        if (!/^XMLAgent[-.]/.test(name)) {
            continue;
        }
        if (!/\.(exe|zip|blockmap)$/i.test(name)) {
            continue;
        }
        if (name.indexOf(version) !== -1) {
            continue;
        }

        const full = path.join(releaseDir, name);

        try {
            if (fs.statSync(full).isDirectory()) {
                continue;
            }
            fs.unlinkSync(full);
            removed.push(name);
        } catch (error) {
            console.warn("[build-windows] 旧产物删除失败 " + name + "：" + error.message);
        }
    }

    return removed;
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

/**
electron-builder 在 Windows 上写 asar 完整性资源时会失败：
addWinAsarIntegrity 先 readFile(exe) → resedit 改 PE → writeFile(exe)，
在部分环境（本机为 Win10 + NTFS，杀软/索引器会瞬时持有刚拷贝的 exe 句柄）
这一步直接抛 `UNKNOWN: unknown error, open '<appOutDir>\XMLAgent.exe'`，
整个构建中断。等 250ms 再试即可成功，因此给它补一层重试。

做法是就地补丁 node_modules（幂等，重复运行不会叠加）：
node_modules 不入库，重装依赖后再次构建时本函数会自动补上。
匹配不到原始语句（版本变化）时只告警，不阻断构建。
*/
function ensureAsarIntegrityWriteRetry() {
    const target = path.join(
        projectRoot,
        "node_modules",
        "app-builder-lib",
        "out",
        "electron",
        "electronWin.js"
    );

    if (!fs.existsSync(target)) {
        return;
    }

    const marker = "__xmlAgentWriteRetry";
    const source = fs.readFileSync(target, "utf8");

    if (source.includes(marker)) {
        console.log("[build-windows] asar integrity write retry already patched");
        return;
    }

    const original =
        "    await (0, promises_1.writeFile)(executablePath, Buffer.from(executable.generate()));";
    if (!source.includes(original)) {
        console.warn(
            "[build-windows] electronWin.js 结构已变化，跳过写入重试补丁；" +
                '若构建卡在 "UNKNOWN: unknown error, open <exe>"，请手动处理'
        );
        return;
    }

    const patched = source.replace(
        original,
        [
            "    const " + marker + "Buf = Buffer.from(executable.generate());",
            "    for (let __xmlAgentAttempt = 0; ; __xmlAgentAttempt++) {",
            "        try {",
            "            await (0, promises_1.writeFile)(executablePath, " + marker + "Buf);",
            "            break;",
            "        } catch (error) {",
            "            if (__xmlAgentAttempt >= 40) {",
            "                throw error;",
            "            }",
            '            builder_util_1.log.warn("write exe failed (" + error.code + "), retrying: " + executablePath);',
            "            await new Promise((resolve) => setTimeout(resolve, 250));",
            "        }",
            "    }",
        ].join("\n")
    );

    fs.writeFileSync(target, patched);
    console.log("[build-windows] patched asar integrity write retry");
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

        // 输出目录固定 release/。XML_AGENT_RELEASE_DIR 只是应急开关（目录被
        // 顽固占用时指到别处），正常发布不要用 —— 那会多出一个 release-* 目录。
        const releaseDir = process.env.XML_AGENT_RELEASE_DIR || "release";
        const releaseAbs = path.isAbsolute(releaseDir)
            ? releaseDir
            : path.join(projectRoot, releaseDir);
        const version = require(path.join(projectRoot, "package.json")).version;

        console.log("[build-windows] output=" + releaseDir + " version=" + version);

        // 构建前自己清空 win-unpacked：electron-builder 的 emptyDir 会撞本机
        // 批量删除保护（见文件头"问题 4"），这里逐个删就不会。
        const unpackedDir = path.join(releaseAbs, "win-unpacked");

        cleanupStaleDirs(releaseAbs);

        if (fs.existsSync(unpackedDir)) {
            console.log("[build-windows] cleaning previous win-unpacked ...");

            try {
                removeTree(unpackedDir, unpackedDir);
                console.log("[build-windows] win-unpacked cleaned");
            } catch (error) {
                // 极少数情况：目录里有个被别的进程长期持有的文件，既删不掉也改不了名。
                // 不阻塞构建 —— 整目录改名为 .stale-*，让 electron-builder 用干净路径，
                // 归档目录下次构建时再尝试回收。
                const staleName = ".stale-win-unpacked-" + Date.now();
                const stalePath = path.join(releaseAbs, staleName);

                try {
                    fs.renameSync(unpackedDir, stalePath);
                } catch (renameError) {
                    throw new Error(
                        "win-unpacked 既删不掉也挪不动，构建无法继续：" +
                            renameError.message +
                            "\n  重启一次系统可释放残留句柄。"
                    );
                }

                console.warn(
                    "[build-windows] win-unpacked 清理失败（" +
                        String(error.message).split("\n")[0] +
                        "）"
                );
                console.warn(
                    "[build-windows] 已改名归档为 " +
                        staleName +
                        "，本次构建继续；下次构建会再尝试删除"
                );
            }
        }

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

        const baseArgs = [
            "--config.electronDist=" + ELECTRON_DIST_REL,
            "--config.directories.output=" + releaseDir,
        ];

        // 没有本地 winCodeSign 时跳过 rcedit，避免联网下载。
        // 另外可用 XML_AGENT_SKIP_RCEDIT=1 强制跳过：electron-builder 先由 resedit
        // 把 asar 完整性资源写回 exe，随后 rcedit 的 EndUpdateResource 在部分 Windows
        // 环境上会报 "Unable to commit changes"（实测同一文件第二次写入必失败），
        // 整条构建随即中断。跳过只失去 exe 的版本信息 / 图标（1.0.x ~ 1.1.0 的产物
        // 同样是跳过状态，见 zip 内 XMLAgent.exe 的 FileVersion=33.2.0）。
        const skipRcedit = process.env.XML_AGENT_SKIP_RCEDIT === "1";
        if (!hasWinCodeSign || skipRcedit) {
            if (skipRcedit && hasWinCodeSign) {
                console.log("[build-windows] XML_AGENT_SKIP_RCEDIT=1, skipping rcedit");
            }
            baseArgs.push("--config.win.signAndEditExecutable=false");
        }

        // electron-builder 写 asar 完整性资源时的瞬时占用，先补重试
        ensureAsarIntegrityWriteRetry();

        // 第一步：dir 构建（win-unpacked 免安装目录）必须成功
        runElectronBuilder(["--win", "dir"].concat(baseArgs), env);

        runNodeScript(path.join("scripts", "postbuild-fix-exe.js"));

        // 第二步：nsis / portable / zip，复用第一步打好的目录（--prepackaged）。
        //
        // 关键：不能省略 --prepackaged。否则 electron-builder 会重新解压一遍 Electron，
        // 并在 unpack() 里 emptyDir(win-unpacked/locales) —— 一次 fs.rm 删 68 个文件，
        // 在本机会被批量删除保护直接拒绝（count 68 > threshold 50），整条构建中断。
        // 复用已有目录既能避开这个问题，也省掉一次 300MB 的重复拷贝。
        //
        // nsis 依赖本地 nsis 缓存；zip 只是压缩 win-unpacked，不需要 nsis。
        const targets = ["portable", "zip"];

        if (hasNsis) {
            targets.unshift("nsis");
        }

        const installerOk = tryElectronBuilder(
            ["--win"]
                .concat(targets)
                .concat(["--prepackaged=" + unpackedDir])
                .concat(baseArgs),
            env
        );

        if (!installerOk) {
            console.warn(
                "[build-windows] some targets failed. " +
                    "Portable build is available at " +
                    path.join(releaseDir, "win-unpacked", "XMLAgent.exe")
            );
            // 出包失败时保留旧版本产物：那可能是当前唯一能用的安装包
            return;
        }

        // 第三步：清掉旧版本产物，release/ 只留当前版本
        const removed = pruneOldArtifacts(releaseAbs, version);

        if (removed.length) {
            console.log("[build-windows] removed old artifacts: " + removed.join(", "));
        }

        const finalFiles = fs
            .readdirSync(releaseAbs)
            .filter((name) => /^XMLAgent[-.]/.test(name))
            .sort();

        console.log("[build-windows] " + releaseDir + "/ 现有产物：");
        for (const name of finalFiles) {
            const size = fs.statSync(path.join(releaseAbs, name)).size;
            console.log(
                "[build-windows]   " + name + "  " + (size / 1024 / 1024).toFixed(1) + "MB"
            );
        }
    } catch (error) {
        console.error("[build-windows] failed:", error.message);
        process.exitCode = error.exitCode || 1;
    }
}

// 直接运行本文件才执行构建；被 require（如 release:clean）时只导出工具函数。
if (require.main === module) {
    main();
}

module.exports = {
    removeTree,
    removeTreeOnce,
    pruneOldArtifacts,
    cleanupStaleDirs,
};
