/**
edit 动作单测

edit 的存在理由：write 每次都整篇重写，改一行也要把整个文件重新生成一遍。
这里钉住它必须成立的四件事：
1. 只动命中的片段，其余字节不变（含 CRLF 与文件末尾换行）；
2. 匹配歧义要说清楚（几处、哪几行），而不是随手改第一处；
3. 任何一处 <change> 失败都整体不落盘 —— 改一半的文件比没改更难收拾；
4. 模型的缩进写歪了也能命中，但仍要如实报告 matched=loose。

运行：node test/unit/test-edit-action.js
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const editAction = require("../../actions/edit");
const { extractXML } = require("../../parse/xml-parse");
const { createRuntime } = require("../../runtime");

let pass = 0;
let total = 0;

async function check(name, fn) {
    total += 1;
    try {
        await fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + (error && error.message) + "]");
    }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-edit-"));
const runtime = createRuntime(workspace);

function seed(relativePath, content) {
    fs.mkdirSync(path.dirname(path.join(workspace, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(workspace, relativePath), content, "utf8");
}

function read(relativePath) {
    return fs.readFileSync(path.join(workspace, relativePath), "utf8");
}

function runXml(xml) {
    return runtime.run(extractXML(xml));
}

async function main() {
    console.log("=== 1. 解析 ===");
    await check("<change> 写法解析出 old/new", () => {
        const parsed = extractXML(
            '<edit path="a.js"><change><old><![CDATA[x = 1;]]></old><new><![CDATA[x = 2;]]></new></change></edit>'
        );
        assert.strictEqual(parsed.action, "edit");
        assert.strictEqual(parsed.node["@_path"], "a.js");
        assert.strictEqual(parsed.node.change.length, 1);
        assert.strictEqual(parsed.node.change[0].old, "x = 1;");
        assert.strictEqual(parsed.node.change[0].new, "x = 2;");
    });

    await check("扁平写法（不带 <change>）同样可用", () => {
        const parsed = extractXML('<edit path="a.js"><old>a</old><new>b</new></edit>');
        assert.strictEqual(parsed.node.change.length, 1);
        assert.strictEqual(parsed.node.change[0].old, "a");
    });

    await check("扁平写法可以连续出现多组 <old>/<new>", () => {
        const parsed = extractXML(
            '<edit path="a.js"><old>a</old><new>A</new><old>b</old><new>B</new></edit>'
        );
        assert.strictEqual(parsed.node.change.length, 2);
        assert.strictEqual(parsed.node.change[0].new, "A");
        assert.strictEqual(parsed.node.change[1].old, "b");
    });

    await check("多个 <change> 按顺序保留", () => {
        const parsed = extractXML(
            '<edit path="a.js"><change><old>a</old><new>A</new></change><change><old>b</old><new>B</new></change></edit>'
        );
        assert.strictEqual(parsed.node.change.length, 2);
        assert.strictEqual(parsed.node.change[1].new, "B");
    });

    await check("CDATA 不按实体解码，纯文本按实体解码", () => {
        const parsed = extractXML(
            '<edit path="a.js"><old><![CDATA[a &amp;&amp; b]]></old><new>c &amp;&amp; d</new></edit>'
        );
        assert.strictEqual(parsed.node.change[0].old, "a &amp;&amp; b");
        assert.strictEqual(parsed.node.change[0].new, "c && d");
    });

    await check("路径里的实体被解码", () => {
        const parsed = extractXML('<edit path="a&amp;b.txt"><old>x</old><new>y</new></edit>');
        assert.strictEqual(parsed.node["@_path"], "a&b.txt");
    });

    await check("含 < 的 CDATA 正文不会被当成标签", () => {
        const parsed = extractXML(
            '<edit path="a.js"><old><![CDATA[if (a < b) { return 1; }]]></old><new><![CDATA[if (a < b) { return 2; }]]></new></edit>'
        );
        assert.strictEqual(parsed.node.change[0].old, "if (a < b) { return 1; }");
    });

    console.log("\n=== 2. 校验文案 ===");
    const cases = [
        ["<edit/>", "edit action is invalid"],
        ["<edit></edit>", "edit action is invalid"],
        ['<edit path="a.txt"></edit>', "edit change requires <new> (use an empty <new> to delete)"],
        [
            '<edit path="a.txt"><old></old><new>y</new></edit>',
            "edit change requires non-empty <old> (use write to create a file)",
        ],
    ];
    for (const [xml, message] of cases) {
        await check("拒绝：" + xml, () => {
            assert.throws(
                () => extractXML(xml),
                (error) => error.message === message
            );
        });
    }

    console.log("\n=== 3. 替换 ===");
    await check("只替换命中片段，其余内容不变", async () => {
        seed("one.js", "const a = 1;\nconst b = 2;\nfunction f() {\n    return a + b;\n}\n");
        const result = await runXml(
            '<edit path="one.js"><old><![CDATA[const b = 2;]]></old><new><![CDATA[const b = 3;]]></new></edit>'
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(
            read("one.js"),
            "const a = 1;\nconst b = 3;\nfunction f() {\n    return a + b;\n}\n"
        );
        assert.strictEqual(result.changes, 1);
        assert.strictEqual(result.matched, "exact");
    });

    await check("多个 <change> 顺序执行", async () => {
        seed("multi.js", "a();\nb();\nc();\n");
        const result = await runXml(
            '<edit path="multi.js">' +
                "<change><old><![CDATA[a();]]></old><new><![CDATA[alpha();]]></new></change>" +
                "<change><old><![CDATA[c();]]></old><new><![CDATA[gamma();]]></new></change>" +
                "</edit>"
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("multi.js"), "alpha();\nb();\ngamma();\n");
        assert.strictEqual(result.changes, 2);
    });

    await check("<new> 留空表示删除", async () => {
        seed("del.txt", "keep\nremove me\nkeep2\n");
        const result = await runXml(
            '<edit path="del.txt"><old><![CDATA[remove me\n]]></old><new></new></edit>'
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("del.txt"), "keep\nkeep2\n");
    });

    await check('all="true" 替换全部命中', async () => {
        seed("all.js", "foo();\nbar();\nfoo();\n");
        const result = await runXml(
            '<edit path="all.js" all="true"><old><![CDATA[foo();]]></old><new><![CDATA[baz();]]></new></edit>'
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("all.js"), "baz();\nbar();\nbaz();\n");
        assert.strictEqual(result.changes, 2);
    });

    await check("CRLF 文件保持 CRLF，插入内容也转成 CRLF", async () => {
        seed("crlf.js", "a();\r\nb();\r\n");
        const result = await runXml(
            '<edit path="crlf.js"><old><![CDATA[a();\nb();]]></old><new><![CDATA[a();\nc();\nd();]]></new></edit>'
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("crlf.js"), "a();\r\nc();\r\nd();\r\n");
    });

    await check("回显 diff 供模型自检", async () => {
        seed("diff.js", "line1\nline2\nline3\n");
        const result = await runXml(
            '<edit path="diff.js"><old><![CDATA[line2]]></old><new><![CDATA[LINE-TWO]]></new></edit>'
        );
        assert.ok(result.diff.indexOf("-line2") !== -1, result.diff);
        assert.ok(result.diff.indexOf("+LINE-TWO") !== -1, result.diff);
        assert.ok(result.diff.indexOf("@@ -2,1 +2,1 @@") !== -1, result.diff);
    });

    console.log("\n=== 4. 歧义与失败 ===");
    await check("多处命中时报错并给出行号，文件不变", async () => {
        seed("dup.js", "foo();\nbar();\nfoo();\n");
        const result = await runXml(
            '<edit path="dup.js"><old><![CDATA[foo();]]></old><new><![CDATA[baz();]]></new></edit>'
        );
        assert.strictEqual(result.ok, false);
        assert.ok(/Found 2 matches/.test(result.error), result.error);
        assert.ok(/lines 1, 3/.test(result.error), result.error);
        assert.strictEqual(read("dup.js"), "foo();\nbar();\nfoo();\n");
    });

    await check("找不到时提示最接近的行号", async () => {
        seed("miss.js", "alpha();\nbeta();\ngamma();\n");
        const result = await runXml(
            '<edit path="miss.js"><old><![CDATA[alpha();\ndelta();\n]]></old><new><![CDATA[x]]></new></edit>'
        );
        assert.strictEqual(result.ok, false);
        assert.ok(/not found/.test(result.error), result.error);
        assert.ok(/line 1/.test(result.error), result.error);
        assert.strictEqual(read("miss.js"), "alpha();\nbeta();\ngamma();\n");
    });

    await check("中途一处失败则整体不写入", async () => {
        seed("partial.js", "a();\nb();\n");
        const result = await runXml(
            '<edit path="partial.js">' +
                "<change><old><![CDATA[a();]]></old><new><![CDATA[alpha();]]></new></change>" +
                "<change><old><![CDATA[zzz();]]></old><new><![CDATA[zeta();]]></new></change>" +
                "</edit>"
        );
        assert.strictEqual(result.ok, false);
        assert.strictEqual(read("partial.js"), "a();\nb();\n");
        assert.deepStrictEqual(
            fs.readdirSync(workspace).filter((name) => name.indexOf(".tmp.") !== -1),
            []
        );
    });

    await check("破坏 JSON 的修改被拒绝且不落盘", async () => {
        seed("data.json", '{"a":1}');
        const result = await runXml(
            '<edit path="data.json"><old><![CDATA[{"a":1}]]></old><new><![CDATA[{"a":]]></new></edit>'
        );
        assert.strictEqual(result.ok, false);
        assert.ok(/Content validation failed/.test(result.error), result.error);
        assert.strictEqual(read("data.json"), '{"a":1}');
    });

    await check("文件不存在时提示用 write", async () => {
        const result = await runXml(
            '<edit path="nope.txt"><old><![CDATA[a]]></old><new><![CDATA[b]]></new></edit>'
        );
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, "File does not exist; use <write> to create it");
    });

    await check("目标是目录时给出明确错误", async () => {
        fs.mkdirSync(path.join(workspace, "adir"), { recursive: true });
        const result = await runXml(
            '<edit path="adir"><old><![CDATA[a]]></old><new><![CDATA[b]]></new></edit>'
        );
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, "Path is an existing directory, not a file");
    });

    await check("二进制文件被拒绝", async () => {
        fs.writeFileSync(path.join(workspace, "blob.bin"), Buffer.from([0x61, 0x00, 0x62]));
        const result = await runXml(
            '<edit path="blob.bin"><old><![CDATA[a]]></old><new><![CDATA[c]]></new></edit>'
        );
        assert.strictEqual(result.ok, false);
        assert.ok(/Binary file/.test(result.error), result.error);
    });

    await check("越界路径抛错", async () => {
        await assert.rejects(
            () =>
                runtime.run({
                    action: "edit",
                    node: { "@_path": "../evil.txt", change: [{ old: "a", new: "b" }] },
                }),
            (error) => error.message === "Path escapes workspace"
        );
    });

    await check("超过单次修改块上限时拒绝", async () => {
        seed("many.txt", Array.from({ length: 30 }, (_, i) => "line" + i).join("\n"));
        const change = Array.from({ length: 21 }, (_, i) => ({
            old: "line" + i,
            new: "LINE" + i,
        }));
        const result = await runtime.run({
            action: "edit",
            node: { "@_path": "many.txt", change },
        });
        assert.strictEqual(result.ok, false);
        assert.ok(/Too many changes/.test(result.error), result.error);
    });

    console.log("\n=== 5. 宽松匹配 ===");
    await check("缩进与文件不一致也能命中，并补上正确缩进", async () => {
        seed("loose.js", "function f() {\n    if (x) {\n        return 1;\n    }\n}\n");
        // old/new 用的是 2/6/2 的缩进，文件里是 4/8/4：整块差 2 个空格
        const result = await runXml(
            '<edit path="loose.js"><old><![CDATA[  if (x) {\n      return 1;\n  }]]></old><new><![CDATA[  if (x) {\n      return 2;\n  }]]></new></edit>'
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.matched, "loose");
        assert.ok(typeof result.hint === "string" && result.hint.length > 0);
        assert.strictEqual(
            read("loose.js"),
            "function f() {\n    if (x) {\n        return 2;\n    }\n}\n"
        );
    });

    await check("old 比文件多缩进时按差量回收", async () => {
        seed("loose2.js", "if (y) {\n  ok();\n}\n");
        const result = await runXml(
            '<edit path="loose2.js"><old><![CDATA[if (y) {\n    ok();\n  }]]></old><new><![CDATA[if (y) {\n    fine();\n  }]]></new></edit>'
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.matched, "loose");
        assert.strictEqual(read("loose2.js"), "if (y) {\n  fine();\n}\n");
    });

    await check("精确命中时不会走宽松分支", async () => {
        seed("exact.js", "const a = 1;\n");
        const result = await runXml(
            '<edit path="exact.js"><old><![CDATA[const a = 1;]]></old><new><![CDATA[const a = 2;]]></new></edit>'
        );
        assert.strictEqual(result.matched, "exact");
        assert.strictEqual(result.hint, undefined);
    });

    await check("过短的锚点不启用宽松匹配，避免误命中", async () => {
        seed("short.js", "alpha();\nbeta();\n");
        const result = await runXml(
            '<edit path="short.js"><old><![CDATA[z();]]></old><new><![CDATA[y();]]></new></edit>'
        );
        assert.strictEqual(result.ok, false);
        assert.strictEqual(read("short.js"), "alpha();\nbeta();\n");
    });

    await check('宽松匹配 + all="true" 命中多处时明确拒绝（不静默只改一处）', async () => {
        seed("looseall.js", "if (alpha) {\n     beta();\n}\nif (alpha) {\n     beta();\n}\n");
        const result = await runXml(
            '<edit path="looseall.js" all="true"><old><![CDATA[if (alpha) {\nbeta();\n}]]></old><new><![CDATA[if (alpha) {\ngamma();\n}]]></new></edit>'
        );
        assert.strictEqual(result.ok, false);
        assert.ok(
            /cannot be combined with an indentation-loose match/.test(result.error),
            result.error
        );
        assert.strictEqual(
            read("looseall.js"),
            "if (alpha) {\n     beta();\n}\nif (alpha) {\n     beta();\n}\n"
        );
    });

    console.log("\n=== 6. 与 runtime 的接口 ===");
    await check("run 返回 mutating=true（审计/Trace 口径）", async () => {
        seed("meta.txt", "a\n");
        const result = await runXml(
            '<edit path="meta.txt"><old><![CDATA[a]]></old><new><![CDATA[b]]></new></edit>'
        );
        assert.strictEqual(result.mutating, true);
    });

    await check("直接传通用解析器的节点结构也能用", async () => {
        seed("shape.txt", "hello\n");
        const result = await runtime.run({
            action: "edit",
            node: {
                "@_path": "shape.txt",
                change: { old: { "#text": "hello" }, new: { "#text": "world" } },
            },
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("shape.txt"), "world\n");
    });

    await check("diff 过长时截断，不把整文件塞回提示词", async () => {
        seed("big.txt", Array.from({ length: 80 }, (_, i) => "line" + i).join("\n") + "\n");
        const change = Array.from({ length: 8 }, (_, i) => ({
            old: "line" + i + "\n",
            new: Array.from({ length: 12 }, (_, j) => "new" + i + "-" + j).join("\n") + "\n",
        }));
        const result = await runtime.run({
            action: "edit",
            node: { "@_path": "big.txt", change },
        });
        assert.strictEqual(result.ok, true);
        assert.ok(result.diff.length <= 2200, String(result.diff.length));
        assert.ok(/省略|截断/.test(result.diff), result.diff.slice(-60));
    });
}

main()
    .catch((error) => {
        console.error("Test run failed:", error && error.stack ? error.stack : error);
        process.exitCode = 1;
    })
    .finally(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        console.log("");
        console.log("Total: " + pass + "/" + total);
        if (pass !== total) {
            process.exitCode = 1;
        }
    });
