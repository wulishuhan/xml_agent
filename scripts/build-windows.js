/**

自定义 Windows 打包脚本，绕过 electron-builder 的两个环境问题：

问题 1：electron-builder 解压缓存 electron zip 不完整，

导致 win-unpacked 缺少 electron.exe，进而报：

ENOENT: rename 'win-unpacked\electron.exe' -> 'win-unpacked\XMLAgent.exe'

解决：使用 --config.electronDist=node_modules/electron/dist 让它直接拷贝目录。

问题 2：electron-builder 下载 winCodeSign-2.6.0.7z 后，7za 在非管理员权限下

无法创建 darwin 符号链接（libcrypto.dylib / libssl.dylib），报 exit status 2。

解决：

预先准备一个只含 Windows 需要文件的 winCodeSign 目录

通过环境变量 ELECTRON_BUILDER_CACHE 指向自定义缓存根

该缓存下 winCodeSign/2.6.0 已存在且完整，electron-builder 就会直接复用

使用方式：node scripts/build-windows.js
*/

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.join(__dirname, "..");
const electronBuilderBin = path.join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
);

const ELECTRON_DIST_REL = path.join("node_modules", "electron", "dist");

// 项目本地缓存，避免写入 %LOCALAPPDATA% 造成权限问题
const LOCAL_CACHE_ROOT = path.join(projectRoot, ".electron-builder-cache");
const LOCAL_WINCODESIGN_DIR = path.join(LOCAL_CACHE_ROOT, "winCodeSign", "2.6.0");

const SRC_WINCODESIGN_ROOT = path.join(
    process.env.LOCALAPPDATA || "",
    "electron-builder",
    "Cache",
    "winCodeSign"
);

function copyRecursive(src, dst) {
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });

        for (const name of fs.readdirSync(src)) {
            copyRecursive(path.join(src, name), path.join(dst, name));
        }

        return;
    }

    // 跳过 macOS 符号链接文件；其余普通文件直接拷贝
    const base = path.basename(src);

    if (base.endsWith(".dylib")) {
        return;
    }

    fs.copyFileSync(src, dst);
}

function findSourceWinCodeSign() {
    if (!fs.existsSync(SRC_WINCODESIGN_ROOT)) {
        return null;
    }

    for (const name of fs.readdirSync(SRC_WINCODESIGN_ROOT)) {
        const full = path.join(SRC_WINCODESIGN_ROOT, name);

        if (!fs.statSync(full).isDirectory()) {
            continue;
        }

        // 只选取包含 rcedit-x64.exe 的目录
        if (fs.existsSync(path.join(full, "rcedit-x64.exe"))) {
            return full;
        }
    }

    return null;
}

function prepareLocalWinCodeSign() {
    if (fs.existsSync(path.join(LOCAL_WINCODESIGN_DIR, "rcedit-x64.exe"))) {
        console.log("[build-windows] local winCodeSign ready at " + LOCAL_WINCODESIGN_DIR);
        return true;
    }

    const src = findSourceWinCodeSign();

    if (!src) {
        console.warn(
            "[build-windows] no pre-extracted winCodeSign found; will rely on electron-builder default cache"
        );
        return false;
    }

    fs.mkdirSync(LOCAL_WINCODESIGN_DIR, { recursive: true });

    for (const name of fs.readdirSync(src)) {
        const from = path.join(src, name);
        const to = path.join(LOCAL_WINCODESIGN_DIR, name);

        // 跳过 darwin 等非 Windows 平台目录，避免符号链接问题
        if (name === "darwin" || name === "linux") {
            continue;
        }

        copyRecursive(from, to);
    }

    console.log("[build-windows] copied winCodeSign from " + src + " to " + LOCAL_WINCODESIGN_DIR);

    return true;
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
        prepareLocalWinCodeSign();

        const env = Object.assign({}, process.env, {
            ELECTRON_BUILDER_CACHE: LOCAL_CACHE_ROOT,
        });

        runElectronBuilder(["--win", "dir", "--config.electronDist=" + ELECTRON_DIST_REL], env);

        runNodeScript(path.join("scripts", "postbuild-fix-exe.js"));

        runElectronBuilder(
            ["--win", "nsis", "portable", "--config.electronDist=" + ELECTRON_DIST_REL],
            env
        );
    } catch (error) {
        console.error("[build-windows] failed:", error.message);
        process.exitCode = error.exitCode || 1;
    }
}

main();
