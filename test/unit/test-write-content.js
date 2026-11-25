/**
 * write 动作的内容保真与原子写单测
 *
 * JSON 契约中 content 就是正文本身：不做 trim、不吃掉起始换行、不转换 CRLF。
 * 这里钉住四件事：
 * 1. 起始 LF/CRLF 与正文内部空行全部保留；
 * 2. 引号、反斜杠、花括号等 JSON 转义还原后逐字落盘；
 * 3. 不以换行开头的内容逐字节不变（含尾随空格）；
 * 4. 原子写失败时保留旧文件并清理临时文件。
 *
 * 运行：node test/unit/test-write-content.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const writeAction = require("../../actions/write");
const { createRuntime } = require("../../runtime");

let pass = 0;
let total = 0;

function check(name, fn) {
    total += 1;
    try {
        fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-write-"));

function runWrite(relativePath, text) {
    const runtime = createRuntime(workspace);
    const result = writeAction.run({ path: relativePath, content: text }, { runtime });

    assert.strictEqual(result.ok, true, "write should succeed");
    return fs.readFileSync(path.join(workspace, relativePath), "utf8");
}

check("起始 LF 原样保留", () => {
    const content = runWrite("a.js", "\nconst a = 1;\n");
    assert.strictEqual(content, "\nconst a = 1;\n");
});

check("多个起始换行与正文内部空行全部保留", () => {
    const content = runWrite("b.js", "\n\nconst a = 1;\n\nconst b = 2;\n");
    assert.strictEqual(content, "\n\nconst a = 1;\n\nconst b = 2;\n");
});

check("起始 CRLF 与内部 CRLF 原样保留", () => {
    const content = runWrite("d.js", "\r\nconst a = 1;\r\nconst b = 2;\r\n");
    assert.strictEqual(content, "\r\nconst a = 1;\r\nconst b = 2;\r\n");
});

check("不以换行开头的内容逐字节不变", () => {
    const original = "  indented first line  \n";
    const content = runWrite("c.txt", original);
    assert.strictEqual(content, original);
});

check("JSON 转义后的引号、反斜杠与花括号逐字保留", () => {
    const original = 'line1\n"quoted" \\path\\ {"nested":[1,2]}\n';
    const content = runWrite("escaped.txt", original);
    assert.strictEqual(content, original);
});

check("空内容仍按原规则被拒绝", () => {
    assert.throws(
        () => writeAction.validate({ path: "e.txt", content: "\n" }),
        /content cannot be empty/
    );
});

check("成功写入不残留临时文件", () => {
    runWrite("atomic-ok.txt", "new content\n");
    assert.deepStrictEqual(
        fs.readdirSync(workspace).filter((name) => name.indexOf(".tmp.") !== -1),
        []
    );
});

check("原子写失败时保留旧文件并清理临时文件", () => {
    const relativePath = "atomic-fail.txt";
    const target = path.join(workspace, relativePath);
    fs.writeFileSync(target, "before\n", "utf8");
    const runtime = createRuntime(workspace);
    const originalRename = fs.renameSync;
    fs.renameSync = function simulatedRename(from, to) {
        if (path.resolve(to) === path.resolve(target)) {
            throw new Error("simulated rename failure");
        }
        return originalRename.apply(this, arguments);
    };
    try {
        assert.throws(
            () => writeAction.run({ path: relativePath, content: "after\n" }, { runtime }),
            /simulated rename failure/
        );
    } finally {
        fs.renameSync = originalRename;
    }
    assert.strictEqual(fs.readFileSync(target, "utf8"), "before\n");
    assert.deepStrictEqual(
        fs.readdirSync(workspace).filter((name) => name.indexOf(".tmp.") !== -1),
        []
    );
});

fs.rmSync(workspace, { recursive: true, force: true });

console.log("");
console.log("Total: " + pass + "/" + total);

if (pass !== total) {
    process.exitCode = 1;
}
