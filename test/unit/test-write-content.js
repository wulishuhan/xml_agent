/**
write 动作的内容归一化单测

背景（真机回归）：Gemini / Qwen 两轮对照测试产出的文件首字节都是 0x0a。
模型习惯写 `<write path="x"><![CDATA[\nfunction f() {}]]></write>`，
只要这段话不是整段以 `<write>` 开头结尾（比如前面带了说明文字、或被平台渲染成代码块），
就会落到通用解析路径，`<![CDATA[` 之后那个换行被当成正文原样落盘。

这个测试钉住三件事：
1. 起始的一个换行被吃掉（正文内部的空行不受影响）；
2. 不以换行开头的内容逐字节不变（不能顺手 trim 掉尾随空格）；
3. CRLF 写法同样处理。

运行：node test/unit/test-write-content.js
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
    const result = writeAction.run({ "@_path": relativePath, "#text": text }, { runtime });

    assert.strictEqual(result.ok, true, "write should succeed");
    return fs.readFileSync(path.join(workspace, relativePath), "utf8");
}

check("CDATA 起始换行被吃掉", () => {
    const content = runWrite("a.js", "\nconst a = 1;\n");
    assert.strictEqual(content, "const a = 1;\n");
});

check("只吃一个换行，正文内部空行保留", () => {
    const content = runWrite("b.js", "\nconst a = 1;\n\nconst b = 2;\n");
    assert.strictEqual(content, "const a = 1;\n\nconst b = 2;\n");
});

check("不以换行开头的内容逐字节不变", () => {
    const original = "  indented first line  \n";
    const content = runWrite("c.txt", original);
    assert.strictEqual(content, original);
});

check("CRLF 起始换行同样处理", () => {
    const content = runWrite("d.js", "\r\nconst a = 1;");
    assert.strictEqual(content, "const a = 1;");
});

check("空内容仍按原规则被拒绝", () => {
    assert.throws(
        () => writeAction.validate({ "@_path": "e.txt", "#text": "\n" }),
        /content cannot be empty/
    );
});

fs.rmSync(workspace, { recursive: true, force: true });

console.log("");
console.log("Total: " + pass + "/" + total);

if (pass !== total) {
    process.exitCode = 1;
}
