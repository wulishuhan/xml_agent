/**

手动从 electron 官方 zip 中解压所需文件到 node_modules/electron/dist。

背景：

electron-builder 在打包 Windows 目标时依赖 node_modules/electron/dist/electron.exe。

而 npm 安装 electron 时的 postinstall 会从 GitHub 下载 zip 并解压；

在部分网络环境下，postinstall 可能被跳过或解压不完整，

导致 electron.exe 缺失，进而 electron-builder 报：

ENOENT: rename 'release\win-unpacked\electron.exe' -> 'release\win-unpacked\XMLAgent.exe'

本脚本职责：

定位 %LOCALAPPDATA%/electron/Cache 下的 electron-vX-win32-x64.zip

用 Node 内置解析，将该 zip 中的所有文件解压到 node_modules/electron/dist

解压完成后检查 electron.exe 是否存在

支持自动探测：

优先使用环境变量 ELECTRON_ZIP 指定的 zip

否则在 %LOCALAPPDATA%/electron/Cache 下寻找第一个 electron-v*-win32-x64.zip

使用方式：node scripts/extract-electron.js
*/

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const projectRoot = path.join(__dirname, "..");
const distDir = path.join(projectRoot, "node_modules", "electron", "dist");

function findZip() {
    if (process.env.ELECTRON_ZIP && fs.existsSync(process.env.ELECTRON_ZIP)) {
        return process.env.ELECTRON_ZIP;
    }

    const cacheDir = path.join(process.env.LOCALAPPDATA || "", "electron", "Cache");

    if (!fs.existsSync(cacheDir)) {
        return null;
    }

    const candidates = [];

    for (const name of fs.readdirSync(cacheDir)) {
        const full = path.join(cacheDir, name);

        if (fs.statSync(full).isFile() && /^electron-v.*-win32-x64.zip$/i.test(name)) {
            candidates.push(full);
        }
    }

    candidates.sort();

    return candidates.length ? candidates[candidates.length - 1] : null;
}

/**

极简 ZIP 读取：只处理 store(0) 与 deflate(8) 两种压缩方式，

这正是 electron 官方 zip 使用的两种方式。
*/
function readCentralDirectory(buf) {
    const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const entries = [];
    let i = buf.indexOf(sig);

    while (i !== -1) {
        const compressionMethod = buf.readUInt16LE(i + 10);
        const compressedSize = buf.readUInt32LE(i + 20);
        const uncompressedSize = buf.readUInt32LE(i + 24);
        const nameLen = buf.readUInt16LE(i + 28);
        const extraLen = buf.readUInt16LE(i + 30);
        const commentLen = buf.readUInt16LE(i + 32);
        const localHeaderOffset = buf.readUInt32LE(i + 42);
        const name = buf.slice(i + 46, i + 46 + nameLen).toString("utf8");

        entries.push({
            name,
            compressionMethod,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
        });

        i = buf.indexOf(sig, i + 4 + nameLen + extraLen + commentLen);
    }

    return entries;
}

function extractEntry(buf, entry) {
    const localSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const headerOffset = entry.localHeaderOffset;

    if (buf.indexOf(localSig, headerOffset) !== headerOffset) {
        throw new Error("Invalid local header for " + entry.name);
    }

    const nameLen = buf.readUInt16LE(headerOffset + 26);
    const extraLen = buf.readUInt16LE(headerOffset + 28);
    const dataStart = headerOffset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;
    const compressed = buf.slice(dataStart, dataEnd);

    if (entry.compressionMethod === 0) {
        return compressed;
    }

    if (entry.compressionMethod === 8) {
        return zlib.inflateRawSync(compressed);
    }

    throw new Error(
        "Unsupported compression method " + entry.compressionMethod + " for " + entry.name
    );
}

function main() {
    const zipPath = findZip();

    if (!zipPath) {
        console.error("[extract-electron] no electron zip found");
        process.exitCode = 1;
        return;
    }

    console.log("[extract-electron] using " + zipPath);

    const buf = fs.readFileSync(zipPath);
    const entries = readCentralDirectory(buf);

    fs.mkdirSync(distDir, { recursive: true });

    let extracted = 0;

    for (const entry of entries) {
        if (entry.name.endsWith("/")) {
            fs.mkdirSync(path.join(distDir, entry.name), { recursive: true });
            continue;
        }

        const target = path.join(distDir, entry.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const data = extractEntry(buf, entry);
        fs.writeFileSync(target, data);
        extracted++;
    }

    const exePath = path.join(distDir, "electron.exe");

    if (!fs.existsSync(exePath)) {
        console.error("[extract-electron] electron.exe still missing after extraction");
        process.exitCode = 1;
        return;
    }

    console.log(
        "[extract-electron] extracted " +
            extracted +
            " files, electron.exe size: " +
            fs.statSync(exePath).size
    );
}

main();
