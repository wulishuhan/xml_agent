/**
build-windows.js 兜底逻辑的单元测试

背景：release/win-unpacked 偶尔会被某个进程长期独占（实测是一个 0 字节的
app.asar 被持有，rm / rd / ren 全是 Access denied，只有重启才释放）。
原来的实现走到这一步就 throw，整条构建直接中断；现在改成换到
release/.fallback-build-<ts> 里构建，出包后把安装包拷回 release/。

这里只测纯函数：兜底目录命名、产物拷贝的筛选规则、归档目录回收、
旧版本产物的清理范围。真正的打包过程太慢，不进单测。

运行：node test/unit/test-build-windows.js
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    copyArtifacts,
    makeFallbackOutput,
    cleanupStaleDirs,
    pruneOldArtifacts,
} = require("../../scripts/build-windows");

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

/** 建一个临时目录，返回路径与清理函数。 */
function tmpDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-" + label + "-"));
    return {
        dir,
        done() {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (error) {
                // 清理失败不影响断言结果
            }
        },
    };
}

function write(file, content) {
    fs.writeFileSync(file, content || "x");
}

// ---------------------------------------------------------------

check("makeFallbackOutput 建在父目录下并带固定前缀", () => {
    const t = tmpDir("fallback");

    try {
        const dir = makeFallbackOutput(t.dir);

        assert.ok(fs.existsSync(dir), "目录应该存在");
        assert.strictEqual(path.dirname(dir), t.dir, "应该直接建在 release/ 下");
        assert.ok(
            path.basename(dir).indexOf(".fallback-build-") === 0,
            "目录名应带 .fallback-build- 前缀，实际 " + path.basename(dir)
        );
    } finally {
        t.done();
    }
});

check("makeFallbackOutput 同一毫秒内不撞名", () => {
    const t = tmpDir("fallback-dup");

    try {
        const a = makeFallbackOutput(t.dir);
        const b = makeFallbackOutput(t.dir);

        assert.notStrictEqual(a, b, "两次调用必须拿到不同目录");
        assert.ok(fs.existsSync(a) && fs.existsSync(b));
    } finally {
        t.done();
    }
});

check("copyArtifacts 只拷 XMLAgent-* 的 exe/zip/blockmap 与 latest.yml", () => {
    const from = tmpDir("from");
    const to = tmpDir("to");

    try {
        write(path.join(from.dir, "XMLAgent-Setup-1.3.0-x64.exe"));
        write(path.join(from.dir, "XMLAgent-1.3.0-x64.zip"));
        write(path.join(from.dir, "XMLAgent-Setup-1.3.0-x64.exe.blockmap"));
        write(path.join(from.dir, "latest.yml"));
        write(path.join(from.dir, "builder-debug.yml"));
        write(path.join(from.dir, "XMLAgent-notes.txt"));
        fs.mkdirSync(path.join(from.dir, "win-unpacked"));

        const copied = copyArtifacts(from.dir, to.dir);

        assert.deepStrictEqual(
            copied.sort(),
            [
                "XMLAgent-1.3.0-x64.zip",
                "XMLAgent-Setup-1.3.0-x64.exe",
                "XMLAgent-Setup-1.3.0-x64.exe.blockmap",
                "latest.yml",
            ],
            "应拷三个产物 + latest.yml，实际 " + JSON.stringify(copied)
        );
        assert.ok(!fs.existsSync(path.join(to.dir, "win-unpacked")), "不应拷中间目录");
        assert.ok(!fs.existsSync(path.join(to.dir, "builder-debug.yml")), "不应拷调试文件");
    } finally {
        from.done();
        to.done();
    }
});

check("copyArtifacts 源目录不存在时返回空数组而不是抛错", () => {
    const to = tmpDir("to-empty");

    try {
        const copied = copyArtifacts(path.join(to.dir, "nope"), to.dir);

        assert.deepStrictEqual(copied, []);
    } finally {
        to.done();
    }
});

check("copyArtifacts 覆盖同名旧产物", () => {
    const from = tmpDir("from-over");
    const to = tmpDir("to-over");

    try {
        write(path.join(to.dir, "XMLAgent-Setup-1.3.0-x64.exe"), "old");
        write(path.join(from.dir, "XMLAgent-Setup-1.3.0-x64.exe"), "new");

        copyArtifacts(from.dir, to.dir);

        assert.strictEqual(
            fs.readFileSync(path.join(to.dir, "XMLAgent-Setup-1.3.0-x64.exe"), "utf8"),
            "new"
        );
    } finally {
        from.done();
        to.done();
    }
});

check("cleanupStaleDirs 回收 .stale-* 与 .fallback-*，不碰正常产物", () => {
    const t = tmpDir("stale");

    try {
        for (const name of [".stale-win-unpacked-1", ".fallback-build-2"]) {
            fs.mkdirSync(path.join(t.dir, name));
            write(path.join(t.dir, name, "junk.txt"));
        }
        write(path.join(t.dir, "XMLAgent-1.3.0-x64.exe"));
        fs.mkdirSync(path.join(t.dir, "win-unpacked"));

        cleanupStaleDirs(t.dir);

        assert.ok(!fs.existsSync(path.join(t.dir, ".stale-win-unpacked-1")));
        assert.ok(!fs.existsSync(path.join(t.dir, ".fallback-build-2")));
        assert.ok(fs.existsSync(path.join(t.dir, "XMLAgent-1.3.0-x64.exe")), "产物不能被清掉");
        assert.ok(fs.existsSync(path.join(t.dir, "win-unpacked")), "当前 win-unpacked 不能被动");
    } finally {
        t.done();
    }
});

check("pruneOldArtifacts 只删旧版本产物", () => {
    const t = tmpDir("prune");

    try {
        const keep = [
            "XMLAgent-Setup-1.3.0-x64.exe",
            "XMLAgent-1.3.0-x64.zip",
            "XMLAgent-Portable-1.3.0-x64.exe",
        ];
        const drop = ["XMLAgent-Setup-1.2.0-x64.exe", "XMLAgent-1.1.1-x64.zip"];

        for (const name of keep.concat(drop)) {
            write(path.join(t.dir, name));
        }
        write(path.join(t.dir, "readme.txt"));

        const removed = pruneOldArtifacts(t.dir, "1.3.0");

        assert.deepStrictEqual(removed.sort(), drop.sort());
        for (const name of keep) {
            assert.ok(fs.existsSync(path.join(t.dir, name)), name + " 不该被删");
        }
        assert.ok(fs.existsSync(path.join(t.dir, "readme.txt")), "非产物文件不该被删");
    } finally {
        t.done();
    }
});

// ---------------------------------------------------------------

let failed = 0;
for (const item of checks) {
    try {
        item.fn();
        console.log("PASS - " + item.name);
    } catch (error) {
        failed++;
        console.log("  FAIL " + item.name);
        console.log("       " + (error && error.message));
    }
}
console.log("");
if (failed) {
    console.log("test-build-windows: " + failed + "/" + checks.length + " FAILED");
    process.exit(1);
}
console.log("test-build-windows: " + checks.length + "/" + checks.length + " PASS");
