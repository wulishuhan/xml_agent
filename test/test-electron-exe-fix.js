/**

验证 postbuild-fix-exe.js 能正确补上 XMLAgent.exe：

如果 release/win-unpacked 不存在 -> 跳过

如果 XMLAgent.exe 已存在 -> 跳过

否则从 node_modules/electron/dist/electron.exe 复制
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const unpackedDir = path.join(projectRoot, "release", "win-unpacked");
const srcExe = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const dstExe = path.join(unpackedDir, "XMLAgent.exe");

if (!fs.existsSync(unpackedDir)) {
    console.log("[test-exe-fix] release/win-unpacked not present, skipping");
    process.exit(0);
}

assert.ok(fs.existsSync(srcExe), "node_modules/electron/dist/electron.exe should exist");

// 模拟：删除 XMLAgent.exe，重新执行 postbuild-fix-exe.js
if (fs.existsSync(dstExe)) {
    fs.unlinkSync(dstExe);
}

// eslint-disable-next-line global-require
require(path.join(projectRoot, "scripts", "postbuild-fix-exe.js"));

assert.ok(fs.existsSync(dstExe), "XMLAgent.exe should be created after fix script");

console.log("[test-exe-fix] postbuild-fix-exe.js works: XMLAgent.exe present at " + dstExe);
