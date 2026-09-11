const assert = require("assert");
const path = require("path");
const fs = require("fs");

const projectRoot = path.join(__dirname, "..");
const mainPath = path.join(projectRoot, "electron", "main.js");
const preloadPath = path.join(projectRoot, "electron", "preload.js");
const pkgPath = path.join(projectRoot, "package.json");

assert.ok(fs.existsSync(mainPath), "electron/main.js should exist");
assert.ok(fs.existsSync(preloadPath), "electron/preload.js should exist");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

assert.strictEqual(
    pkg.main,
    "electron/main.js",
    "package.json main should point to electron/main.js"
);
assert.ok(pkg.devDependencies.electron, "electron should be in devDependencies");
assert.ok(pkg.devDependencies["electron-builder"], "electron-builder should be in devDependencies");
assert.ok(pkg.scripts["electron:dev"], "electron:dev script should exist");
assert.ok(pkg.scripts["electron:build"], "electron:build script should exist");
assert.ok(pkg.build, "build config should exist");
assert.strictEqual(pkg.build.appId, "com.shuhan.xmlagent");
assert.ok(Array.isArray(pkg.build.win.target), "win target should be an array");

const mainSrc = fs.readFileSync(mainPath, "utf8");
assert.ok(mainSrc.includes("startServer"), "main.js should call startServer");
assert.ok(mainSrc.includes("xml_agent_web"), "main.js should load /xml_agent_web");
assert.ok(mainSrc.includes("before-quit"), "main.js should handle before-quit");
assert.ok(mainSrc.includes("preload.js"), "main.js should reference preload.js");

const preloadSrc = fs.readFileSync(preloadPath, "utf8");
assert.ok(preloadSrc.includes("contextBridge"), "preload.js should use contextBridge");

console.log("All electron scaffold checks passed.");
