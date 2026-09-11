/**

在 electron-builder 打包之前，主动把 node_modules/electron/dist 目录

拷贝到 electron-builder 的缓存位置，或直接在打包前校验 electron.exe 存在。

这里不直接干预 electron-builder 的下载流程，而是：

检查 node_modules/electron/dist/electron.exe 是否存在；

若不存在，尝试调用 scripts/extract-electron.js 从本地缓存 zip 解压；

再次检查，若仍不存在则抛出明确错误，避免 electron-builder 走到最后才报错。

该脚本用于 electron:build 的前置步骤，让问题在打包开始前就暴露出来。

使用方式：node scripts/prepare-electron-dist.js
*/

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const projectRoot = path.join(__dirname, "..");
const distDir = path.join(projectRoot, "node_modules", "electron", "dist");
const exePath = path.join(distDir, "electron.exe");
const extractScript = path.join(projectRoot, "scripts", "extract-electron.js");

function ensureDist() {
    if (fs.existsSync(exePath)) {
        const size = fs.statSync(exePath).size;

        if (size > 1024 * 1024) {
            console.log("[prepare-electron-dist] electron.exe present, size: " + size);
            return true;
        }

        console.warn(
            "[prepare-electron-dist] electron.exe too small (" + size + "), will try to re-extract"
        );
    }

    console.log("[prepare-electron-dist] electron.exe missing, attempting extraction...");

    if (!fs.existsSync(extractScript)) {
        console.error("[prepare-electron-dist] extract-electron.js not found");
        return false;
    }

    try {
        execFileSync(process.execPath, [extractScript], {
            stdio: "inherit",
            cwd: projectRoot,
        });
    } catch (error) {
        console.error("[prepare-electron-dist] extraction failed:", error.message);
    }

    if (!fs.existsSync(exePath)) {
        console.error("[prepare-electron-dist] electron.exe still missing after extraction.");
        return false;
    }

    const size = fs.statSync(exePath).size;

    if (size < 1024 * 1024) {
        console.error("[prepare-electron-dist] electron.exe too small after extraction: " + size);
        return false;
    }

    console.log("[prepare-electron-dist] electron.exe prepared, size: " + size);
    return true;
}

const ok = ensureDist();
process.exit(ok ? 0 : 1);
