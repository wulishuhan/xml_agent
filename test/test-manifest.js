/**
工作区清单（workspace/manifest.js）的断言测试。

重点覆盖两件容易被改坏的事：
1. 排序与忽略规则（清单是模型对这个工作区的第一印象，顺序乱会误导它）；
2. 条目上限（清单直接进提示词，无上限会把请求撑爆）。

预算用测试自带的小 max 验证，不依赖 MAX_ENTRIES 的真实取值——
夹具只需要几十个文件，跑得快也不会撞本机的批量删除保护。
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildWorkspaceManifest, MAX_ENTRIES } = require("../workspace/manifest");

let passed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name);
        console.log("       " + error.message);
        process.exitCode = 1;
    }
}

function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xa-manifest-"));
    // 目录优先：bfile.txt 字母序在 adir/ 之前，排序后 adir/ 仍应在最前
    fs.mkdirSync(path.join(root, "adir"));
    fs.writeFileSync(path.join(root, "bfile.txt"), "x");
    // 应被忽略的目录
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "dep.js"), "x");
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git", "config"), "x");
    // 超过 maxDepth 的深层目录
    let deep = root;
    for (let i = 0; i < 13; i++) {
        deep = path.join(deep, "lvl" + i);
        fs.mkdirSync(deep);
    }
    fs.writeFileSync(path.join(deep, "deep.txt"), "x");
    return root;
}

const root = makeFixture();

try {
    check("MAX_ENTRIES 是正数", () => {
        assert.ok(Number.isInteger(MAX_ENTRIES) && MAX_ENTRIES > 0, "应为正整数");
    });

    check("目录排在文件之前", () => {
        const entries = buildWorkspaceManifest(root);
        const firstDir = entries.findIndex((line) => line.trim() === "adir/");
        const firstFile = entries.findIndex((line) => line.trim() === "bfile.txt");
        assert.ok(firstDir >= 0 && firstFile >= 0, "两者都应在清单里");
        assert.ok(firstDir < firstFile, "目录 adir/ 应排在 bfile.txt 之前");
    });

    check("忽略 node_modules / .git", () => {
        const entries = buildWorkspaceManifest(root);
        const text = entries.join("\n");
        assert.ok(!/^ *node_modules\/$/m.test(text), "node_modules 不该出现");
        assert.ok(!/^ *\.git$/m.test(text), ".git 不该出现");
        assert.ok(!/dep\.js/.test(text), "被忽略目录里的文件不该出现");
    });

    check("超过最大深度时有提示", () => {
        const entries = buildWorkspaceManifest(root);
        assert.ok(
            entries.some((line) => line.includes("(max depth reached)")),
            "应出现 max depth reached"
        );
    });

    check("预算用尽时截断并只写一行提示", () => {
        const entries = buildWorkspaceManifest(root, 0, 10, {
            count: 0,
            max: 4,
            truncated: false,
        });
        const notes = entries.filter((line) => line.includes("listing truncated at 4"));
        assert.strictEqual(notes.length, 1, "截断提示应只出现一次，实际 " + notes.length);
        // 4 条内容 + 1 行提示（提示本身不计入预算）
        assert.ok(entries.length <= 5, "条目数应受预算约束，实际 " + entries.length);
    });

    check("单层大量文件不会因展开参数超限而抛错", () => {
        const flat = fs.mkdtempSync(path.join(os.tmpdir(), "xa-flat-"));
        for (let i = 0; i < 60; i++) {
            fs.writeFileSync(path.join(flat, "f" + i + ".txt"), "x");
        }
        const entries = buildWorkspaceManifest(flat, 0, 10, {
            count: 0,
            max: 10,
            truncated: false,
        });
        assert.ok(entries.length <= 11, "条目数应受预算约束，实际 " + entries.length);
        assert.ok(
            entries.some((line) => line.includes("listing truncated")),
            "应出现截断提示"
        );
    });

    check("空目录返回空数组", () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), "xa-empty-"));
        assert.deepStrictEqual(buildWorkspaceManifest(empty), []);
    });

    check("不存在的目录返回空数组而不是抛错", () => {
        assert.deepStrictEqual(buildWorkspaceManifest(path.join(root, "no-such-dir")), []);
    });
} finally {
    // 夹具在临时目录，删不掉也不影响测试结论（Windows 上批量删除可能被安全策略拦下）
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
        // ignore
    }
}

console.log("\nTotal: " + passed + " passed");
if (process.exitCode) {
    console.log("结果：存在失败用例");
} else {
    console.log("结果：全部通过");
}
