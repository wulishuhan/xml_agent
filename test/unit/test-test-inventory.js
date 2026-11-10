/**
测试清单守卫

背景：test/ 下曾经积到 51 个文件没挂进任何 npm script —— `npm test` 覆盖不到，
改坏了也没人知道；另有一批需要真实浏览器/登录态的 live 脚本混在里面，
容易被当成"CI 已覆盖"。

这个测试守两件事：
1. test/ 下每个 .js 要么被某个 npm script 引用，要么在下面的白名单里写明原因；
2. script 里引用的路径必须真实存在（防止改名后脚本静默跳过）。

新增测试时若不想挂进脚本，请把文件名加进 EXTRA 并写清理由，
否则这个测试会失败 —— 这是有意为之。
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const pkg = require(path.join(ROOT, "package.json"));

/**
不属于任何 script 的合法文件：辅助模块 + 手工探针。
键是相对 ROOT 的路径，值是"为什么不挂进脚本"。
*/
const EXTRA = {
    // ---- 被其它脚本 require 的辅助模块，本身没有断言 ----
    "test/live-support.js": "live 脚本共用的环境准备模块（找端口 / 找浏览器）",
    "test/unit/fake-dom.js": "单测用的最小 DOM 桩，被其它单测 require",
    "test/test-server.js": "手工用的常驻测试 HTTP 服务器，不是测试",

    // ---- 手工探针：会被 test:core 里的正式测试覆盖，跑它只为看原始输出 ----
    "test/test-config.js": "打印配置快照；断言版本是 test-config-schema.js",
    "test/test-runtime.js": "打印 read/write/exec 结果；断言版本是 test-builtin-actions.js",
    "test/test-xml.js":
        "打印 XML 解析结果（非法输入也打印 FAIL，无法判定）；断言版本是 test-xml-parse-cdata.js",
    "test/test-background-exec.js": "手工验证后台进程存活，需要人看输出",
    "test/test-session-concurrency.js": "手工并发压测，会写真实会话目录，不放进离线套件",
    "test/test-electron-exe-fix.js":
        "会先删掉 release/win-unpacked 里的成品 exe 再复制一份，破坏性，不放进常规套件",
    "test/check-migration-equivalence.js": "一次性迁移核对脚本，迁移完成后已失效",
};

/** npm script 里出现的 `node <path>` 路径。 */
function scriptedPaths() {
    const found = new Set();
    for (const script of Object.values(pkg.scripts)) {
        for (const match of String(script).matchAll(/node\s+([\w./-]+\.js)/g)) {
            found.add(match[1].replace(/\\/g, "/"));
        }
    }
    return found;
}

/** test/ 与 test/unit/ 下的所有 .js（不递归更深，避免把 fixtures 算进来）。 */
function testFiles() {
    const files = [];
    for (const dir of ["test", "test/unit"]) {
        const abs = path.join(ROOT, dir);
        for (const name of fs.readdirSync(abs)) {
            if (name.endsWith(".js")) {
                files.push(dir + "/" + name);
            }
        }
    }
    return files.sort();
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

const scripted = scriptedPaths();

check("script 引用的测试文件都存在", () => {
    const missing = [...scripted].filter((p) => !fs.existsSync(path.join(ROOT, p)));
    assert.deepStrictEqual(missing, [], "脚本引用了不存在的文件：" + missing.join(", "));
});

check("没有测试文件漏在脚本之外", () => {
    const orphans = testFiles().filter((p) => !scripted.has(p) && !EXTRA[p]);
    assert.deepStrictEqual(
        orphans,
        [],
        "以下文件既没挂进 npm script，也不在白名单里：\n  " +
            orphans.join("\n  ") +
            "\n（挂进 test:unit / test:core / test:api / test:desktop / test:live，或加进 EXTRA 并写原因）"
    );
});

check("白名单没有过期条目（已挂进脚本就该删掉）", () => {
    const stale = Object.keys(EXTRA).filter((p) => scripted.has(p));
    assert.deepStrictEqual(
        stale,
        [],
        "白名单里这些文件已经被脚本引用，请删除：" + stale.join(", ")
    );
});

check("白名单里没有不存在的文件", () => {
    const missing = Object.keys(EXTRA).filter((p) => !fs.existsSync(path.join(ROOT, p)));
    assert.deepStrictEqual(missing, [], "白名单引用了不存在的文件：" + missing.join(", "));
});

check("test:offline 覆盖离线四组（unit / core / plugins / api / desktop）", () => {
    const offline = String(pkg.scripts["test:offline"] || "");
    for (const group of ["test:unit", "test:core", "test:plugins", "test:api", "test:desktop"]) {
        assert.ok(offline.includes(group), "test:offline 缺少 " + group);
    }
});

check("test:offline 不含 live 脚本", () => {
    const live = String(pkg.scripts["test:live"] || "");
    const liveFiles = [...live.matchAll(/node\s+([\w./-]+\.js)/g)].map((m) => m[1]);
    assert.ok(liveFiles.length > 0, "test:live 不应为空");
    const offline = ["unit", "core", "plugins", "api", "desktop"]
        .map((g) => String(pkg.scripts["test:" + g] || ""))
        .join(" && ");
    const leaked = liveFiles.filter((f) => offline.includes(f));
    assert.deepStrictEqual(leaked, [], "这些 live 脚本被放进了离线套件：" + leaked.join(", "));
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
console.log("Total: " + (results.length - failed) + "/" + results.length);
process.exit(failed ? 1 : 0);
