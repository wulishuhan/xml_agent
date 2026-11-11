/**

解决 electron-builder 在部分 Windows 环境下

无法将 release/win-unpacked/electron.exe 重命名为 XMLAgent.exe 的问题。

症状：

ENOENT: rename 'release\win-unpacked\electron.exe' -> 'release\win-unpacked\XMLAgent.exe'

但 node_modules/electron/dist/electron.exe 实际存在。

现在 electron-builder 已通过 --config.electronDist=node_modules/electron/dist

直接从 node_modules 拷贝 Electron，不再依赖缓存 zip 解压。

本脚本仅在 win-unpacked 下缺少 XMLAgent.exe 时做一次兜底复制。

使用方式：node scripts/postbuild-fix-exe.js
*/

const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
// 打包输出目录可用 XML_AGENT_RELEASE_DIR 覆盖（与 scripts/build-windows.js 一致），
// 默认 release。目录被占用或需要并行构建时，换一个输出目录即可，不必清理旧产物。
// 兜底构建会传绝对路径进来，所以这里不能直接 path.join(projectRoot, releaseDir)。
const releaseDir = process.env.XML_AGENT_RELEASE_DIR || "release";
const releaseAbs = path.isAbsolute(releaseDir) ? releaseDir : path.join(projectRoot, releaseDir);
const unpackedDir = path.join(releaseAbs, "win-unpacked");
const srcExe = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const dstExe = path.join(unpackedDir, "XMLAgent.exe");

function main() {
    if (!fs.existsSync(unpackedDir)) {
        console.log("[postbuild-fix-exe] " + unpackedDir + " does not exist, skipping.");
        return;
    }

    if (fs.existsSync(dstExe)) {
        console.log("[postbuild-fix-exe] XMLAgent.exe already exists, nothing to do.");
        return;
    }

    if (!fs.existsSync(srcExe)) {
        console.error("[postbuild-fix-exe] source electron.exe not found at " + srcExe);
        process.exitCode = 1;
        return;
    }

    fs.copyFileSync(srcExe, dstExe);
    console.log("[postbuild-fix-exe] copied electron.exe -> XMLAgent.exe");
}

main();
