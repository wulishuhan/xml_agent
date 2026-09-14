/**
从 download/ 目录下的 .7z 手动准备 electron-builder 离线缓存。

背景：
electron-builder 构建 Windows 包时需要以下二进制依赖：

winCodeSign-2.6.0 —— 用于 rcedit 写 exe 图标/元数据

nsis-3.0.4.1 —— 用于生成 NSIS 安装包

nsis-resources-3.4.1 —— NSIS 安装包的资源文件
正常情况下它会自动从 GitHub 下载，但在公司代理 / 自签 CA / 无法访问
GitHub 的网络环境下会失败（x509: certificate signed by unknown authority）。

本脚本让你可以手动下载这些 .7z，放到项目 download/ 目录下，
然后由本脚本自动解压到 electron-builder 期望的缓存位置，全程不联网。

需要的文件（放到 download/）：
winCodeSign-2.6.0.7z
nsis-3.0.4.1.7z
nsis-resources-3.4.1.7z

electron-builder 默认缓存结构：
%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe
%LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-3.0.4.1\makensis.exe
%LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-resources-3.4.1\

本脚本同时写到用户默认缓存（electron-builder 自动查找）和项目内缓存。

使用方式：
node scripts/prepare-offline-cache.js
*/

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const projectRoot = path.join(__dirname, "..");
const downloadDir = path.join(projectRoot, "download");

const userCacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "electron-builder",
    "Cache"
);

const localCacheRoot = path.join(projectRoot, ".electron-builder-cache");

const sevenZipBin = path.join(
    projectRoot,
    "node_modules",
    "7zip-bin",
    process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux",
    process.arch === "ia32" ? "ia32" : process.arch === "arm64" ? "arm64" : "x64",
    process.platform === "win32" ? "7za.exe" : "7za"
);

function find7za() {
    if (fs.existsSync(sevenZipBin)) {
        return sevenZipBin;
    }

    const candidates = ["C:\Program Files\7-Zip\7z.exe", "C:\Program Files (x86)\7-Zip\7z.exe"];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function extract7z(archivePath, targetDir, extraArgs) {
    const sevenZip = find7za();

    if (!sevenZip) {
        throw new Error(
            "Could not find 7za.exe (expected at node_modules/7zip-bin) or 7z in Program Files."
        );
    }

    fs.mkdirSync(targetDir, { recursive: true });

    const args = ["x", archivePath, "-o" + targetDir, "-y"].concat(extraArgs || []);

    console.log("[offline-cache] " + sevenZip + " " + args.join(" "));

    const result = spawnSync(sevenZip, args, {
        cwd: projectRoot,
        stdio: "inherit",
    });

    if (result.error) {
        throw result.error;
    }

    if (typeof result.status === "number" && result.status !== 0) {
        throw new Error(sevenZip + " exited with code " + result.status);
    }
}

function copyRecursive(src, dst) {
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });

        for (const name of fs.readdirSync(src)) {
            copyRecursive(path.join(src, name), path.join(dst, name));
        }

        return;
    }

    const base = path.basename(src);

    if (base.endsWith(".dylib")) {
        return;
    }

    fs.copyFileSync(src, dst);
}

function ensureDir(srcDir, dstDir, label) {
    if (fs.existsSync(dstDir)) {
        return;
    }

    copyRecursive(srcDir, dstDir);
    console.log("[offline-cache] prepared " + label + " -> " + dstDir);
}

/**

通用准备流程：

若用户缓存与项目缓存均无该目录，则从 download/<archiveName> 解压到项目缓存

若用户缓存没有，则从项目缓存复制一份到用户缓存

@param {object} spec { name, archiveName, relDir, marker, extraExtractArgs, required }
*/
function prepare(spec) {
    const archive = path.join(downloadDir, spec.archiveName);
    const localDir = path.join(localCacheRoot, spec.relDir);
    const userDir = path.join(userCacheRoot, spec.relDir);

    const localMarker = path.join(localDir, spec.marker);
    const userMarker = path.join(userDir, spec.marker);

    if (!fs.existsSync(localMarker) && !fs.existsSync(userMarker)) {
        if (!fs.existsSync(archive)) {
            if (spec.required) {
                console.warn(
                    "[offline-cache] " +
                        spec.archiveName +
                        " not found in download/; " +
                        spec.name +
                        " will be unavailable."
                );
            } else {
                console.warn(
                    "[offline-cache] " + spec.archiveName + " not found in download/; skipping."
                );
            }
            return false;
        }

        extract7z(archive, localDir, spec.extraExtractArgs || []);
        console.log("[offline-cache] extracted " + spec.name + " -> " + localDir);
    }

    if (!fs.existsSync(userMarker) && fs.existsSync(localMarker)) {
        ensureDir(localDir, userDir, spec.name + " (user cache)");
    }

    return fs.existsSync(userMarker) || fs.existsSync(localMarker);
}

function main() {
    try {
        const specs = [
            {
                name: "winCodeSign",
                archiveName: "winCodeSign-2.6.0.7z",
                relDir: path.join("winCodeSign", "winCodeSign-2.6.0"),
                marker: "rcedit-x64.exe",
                // 跳过 darwin / linux，避免非管理员权限下创建 macOS 符号链接失败
                extraExtractArgs: ["-x!darwin", "-x!linux"],
                required: true,
            },
            {
                name: "nsis",
                archiveName: "nsis-3.0.4.1.7z",
                relDir: path.join("nsis", "nsis-3.0.4.1"),
                marker: "makensis.exe",
                extraExtractArgs: [],
                required: true,
            },
            {
                name: "nsis-resources",
                archiveName: "nsis-resources-3.4.1.7z",
                relDir: path.join("nsis", "nsis-resources-3.4.1"),
                marker: "",
                extraExtractArgs: [],
                required: false,
            },
        ];

        const results = specs.map((spec) => ({
            name: spec.name,
            ready: prepare(spec),
        }));

        console.log("");
        console.log("[offline-cache] summary:");
        for (const item of results) {
            console.log(
                "[offline-cache] " + item.name.padEnd(16) + (item.ready ? "ready" : "missing")
            );
        }
        console.log("[offline-cache] user cache root: " + userCacheRoot);
        console.log("[offline-cache] project cache root: " + localCacheRoot);
    } catch (error) {
        console.error("[offline-cache] failed:", error.message);
        process.exitCode = 1;
    }
}

main();
