/**
依赖声明守卫

为什么有这个东西：2026-11-10 清理依赖时把 `marked` 当成"全项目零引用"删掉了，
实际它被 `webui/frontend/src/services/markdown.mjs` 用着 —— 当时只 grep 了
`.js / .vue / .html`，漏了 `.mjs`。`npm run webui:build` 直接报
"Rollup failed to resolve import marked"，桌面端启动不了。

所以这里静态扫一遍源码里的裸模块引用，要求：
1. 每个被 import/require 的包名都在 package.json 的 dependencies 或 devDependencies 里；
2. 该包在 node_modules 里真实存在（防止声明了但没装）。

相对路径、Node 内置模块、vite 别名（/@、.css 之类）都跳过。
动态拼接的 require(variable) 无法静态分析，跳过。
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const ROOT = path.resolve(__dirname, "../..");
const pkg = require(path.join(ROOT, "package.json"));

/** 允许"引用了但故意不声明"的包：键是包名，值是原因。 */
const ALLOWED_UNDECLARED = {};

const BUILTINS = new Set(builtinModules.concat(builtinModules.map((m) => "node:" + m)));

/** 扫描范围：前端源码 + 后端各目录 + 根目录脚本。 */
const SCAN_DIRS = [
    "webui/frontend/src",
    "actions",
    "agent",
    "config",
    "electron",
    "parse",
    "plugins",
    "processes",
    "prompts",
    "providers",
    "session",
    "skills",
    "tools",
    "utils",
    "webui",
    "scripts",
];
const SCAN_EXTS = new Set([".js", ".mjs", ".cjs", ".vue"]);

/** 这些目录里是构建产物/依赖，不扫。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "release", ".git", "test"]);

function walk(dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        return out;
    }
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                walk(abs, out);
            }
            continue;
        }
        if (SCAN_EXTS.has(path.extname(entry.name))) {
            out.push(abs);
        }
    }
    return out;
}

/** 从源码里取出所有裸模块说明符（不含相对路径与内置模块）。 */
function bareSpecifiers(code) {
    const found = new Set();
    const patterns = [
        /\bfrom\s+["']([^"']+)["']/g,
        /\bimport\s+["']([^"']+)["']/g,
        /\brequire\(\s*["']([^"']+)["']\s*\)/g,
        /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of code.matchAll(pattern)) {
            const spec = match[1];
            if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("\\")) {
                continue;
            }
            if (spec.startsWith("node:") || BUILTINS.has(spec)) {
                continue;
            }
            // vite 的虚拟模块 / 资源导入 / 别名
            if (spec.startsWith("@/") || spec.startsWith("~")) {
                continue;
            }
            found.add(spec);
        }
    }
    return found;
}

/** 说明符 → 包名（处理 @scope/name 与子路径）。 */
function packageNameOf(spec) {
    const parts = spec.split("/");
    if (spec.startsWith("@")) {
        return parts.slice(0, 2).join("/");
    }
    return parts[0];
}

const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
]);

const files = [];
for (const dir of SCAN_DIRS) {
    walk(path.join(ROOT, dir), files);
}
for (const name of fs.readdirSync(ROOT)) {
    if (SCAN_EXTS.has(path.extname(name))) {
        files.push(path.join(ROOT, name));
    }
}

const used = new Map(); // 包名 → 首个引用它的文件
for (const file of files) {
    let code;
    try {
        code = fs.readFileSync(file, "utf8");
    } catch (error) {
        continue;
    }
    for (const spec of bareSpecifiers(code)) {
        const name = packageNameOf(spec);
        if (!used.has(name)) {
            used.set(name, path.relative(ROOT, file).replace(/\\/g, "/"));
        }
    }
}

const results = [];
function check(name, fn) {
    try {
        fn();
        results.push({ name, ok: true });
    } catch (error) {
        results.push({ name, ok: false, message: error.message });
    }
}

// 排查用：DEBUG_DEPS=1 时打印"包名 ← 首个引用位置"
if (process.env.DEBUG_DEPS) {
    for (const [name, file] of [...used].sort()) {
        console.log("  " + name + " <- " + file);
    }
}

check("扫描到了源码里的外部依赖", () => {
    assert.ok(used.size >= 5, "只扫到 " + used.size + " 个包，扫描范围可能写错了");
});

check("没有引用了却没声明的包", () => {
    const missing = [];
    for (const [name, file] of used) {
        if (declared.has(name) || ALLOWED_UNDECLARED[name]) {
            continue;
        }
        missing.push(name + "  (" + file + ")");
    }
    assert.deepStrictEqual(
        missing,
        [],
        "这些包被 import/require 了但没在 package.json 声明（装到新机器上会解析失败）：\n  " +
            missing.join("\n  ")
    );
});

check("声明过的包在 node_modules 里真实存在", () => {
    const missing = [];
    // 注意用 keys()：直接 for...of 一个 Map 拿到的是 [键,值] 数组，
    // declared.has(数组) 恒为 false，会让这项检查静默失效。
    for (const name of used.keys()) {
        if (!declared.has(name)) {
            continue; // 上一项已经报过
        }
        if (!fs.existsSync(path.join(ROOT, "node_modules", name, "package.json"))) {
            missing.push(name);
        }
    }
    assert.deepStrictEqual(
        missing,
        [],
        "这些包在 package.json 里声明了但没装（npm install 没跑完？）：" + missing.join(", ")
    );
});

check("ALLOWED_UNDECLARED 没有多余条目", () => {
    const stale = Object.keys(ALLOWED_UNDECLARED).filter(
        (name) => !used.has(name) || declared.has(name)
    );
    assert.deepStrictEqual(
        stale,
        [],
        "白名单里的这些包已经不再需要例外（没被引用或已声明）：" + stale.join(", ")
    );
});

let failed = 0;
for (const { name, ok, message } of results) {
    console.log((ok ? "PASS" : "FAIL") + " - " + name);
    if (!ok) {
        failed++;
        console.log("    " + String(message).split("\n").join("\n    "));
    }
}
console.log("");
console.log("扫描 " + files.length + " 个文件，用到 " + used.size + " 个外部包");
console.log("Total: " + (results.length - failed) + "/" + results.length);
process.exit(failed ? 1 : 0);
