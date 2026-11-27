/**
 * edit 动作单测
 *
 * edit 的存在理由：write 每次都整篇重写，改一行也要把整个文件重新生成一遍。
 * 这里钉住它必须成立的四件事：
 * 1. 只动命中的片段，其余字节不变（含 CRLF 与文件末尾换行）；
 * 2. 匹配歧义要说清楚（几处、哪几行），而不是随手改第一处；
 * 3. 任何一处 change 失败都整体不落盘 —— 改一半的文件比没改更难收拾；
 * 4. 模型的缩进写歪了也能命中，但仍要如实报告 matched=loose。
 *
 * 运行：node test/unit/test-edit-action.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { extractAction } = require("../../parse/json-action");
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

function runEdit(params) {
    return runtime.run(extractAction(JSON.stringify({ action: "edit", params })));
}

async function main() {
    console.log("=== 1. 解析 ===");
    await check("changes 数组解析出 old/new", () => {
        const parsed = extractAction(
            JSON.stringify({
                action: "edit",
                params: { path: "a.js", changes: [{ old: "x = 1;", new: "x = 2;" }] },
            })
        );
        assert.strictEqual(parsed.action, "edit");
        assert.strictEqual(parsed.params.path, "a.js");
        assert.strictEqual(parsed.params.changes.length, 1);
        assert.strictEqual(parsed.params.changes[0].old, "x = 1;");
        assert.strictEqual(parsed.params.changes[0].new, "x = 2;");
        assert.strictEqual(parsed.params.all, false);
        assert.strictEqual(parsed.node, undefined);
    });

    await check("多个 changes 按顺序保留", () => {
        const parsed = extractAction(
            JSON.stringify({
                action: "edit",
                params: {
                    path: "a.js",
                    changes: [
                        { old: "a", new: "A" },
                        { old: "b", new: "B" },
                    ],
                },
            })
        );
        assert.strictEqual(parsed.params.changes.length, 2);
        assert.strictEqual(parsed.params.changes[0].new, "A");
        assert.strictEqual(parsed.params.changes[1].old, "b");
    });

    await check("JSON 转义还原后不解析实体，也不破坏花括号", () => {
        const parsed = extractAction(
            JSON.stringify({
                action: "edit",
                params: {
                    path: "a.js",
                    changes: [
                        {
                            old: 'a &amp;&amp; b\nif (x < 2) { return "}"; }',
                            new: 'c && d\nif (x < 3) { return "{"; }',
                        },
                    ],
                },
            })
        );
        assert.strictEqual(
            parsed.params.changes[0].old,
            'a &amp;&amp; b\nif (x < 2) { return "}"; }'
        );
        assert.strictEqual(parsed.params.changes[0].new, 'c && d\nif (x < 3) { return "{"; }');
    });

    await check("路径中的 & 按字面保留", () => {
        const parsed = extractAction(
            JSON.stringify({
                action: "edit",
                params: { path: "a&b.txt", changes: [{ old: "x", new: "y" }] },
            })
        );
        assert.strictEqual(parsed.params.path, "a&b.txt");
    });

    console.log("\n=== 2. 校验文案 ===");
    const cases = [
        [{ path: "a.txt" }, "params must have required property 'changes'"],
        [{ path: "a.txt", changes: [] }, "/changes must NOT have fewer than 1 items"],
        [
            { path: "a.txt", changes: [{ old: "x" }] },
            "/changes/0 must have required property 'new'",
        ],
        [
            { path: "a.txt", changes: [{ old: "", new: "y" }] },
            "/changes/0/old must NOT have fewer than 1 characters",
        ],
        [
            { path: "a.txt", changes: [{ old: " \n", new: "y" }] },
            "edit change requires non-empty old (use write to create a file)",
        ],
        [{ path: "a.txt", changes: [{ old: "x", new: "y" }], all: "true" }, "/all must be boolean"],
        [{ path: "a.txt", changes: [{ old: "x", new: 1 }] }, "/changes/0/new must be string"],
    ];
    for (const [params, message] of cases) {
        await check("拒绝：" + JSON.stringify(params), () => {
            assert.throws(
                () => extractAction(JSON.stringify({ action: "edit", params })),
                (error) => error.message === message
            );
        });
    }

    console.log("\n=== 3. 替换 ===");
    await check("只替换命中片段，其余内容不变", async () => {
        seed("one.js", "const a = 1;\nconst b = 2;\nfunction f() {\n    return a + b;\n}\n");
        const result = await runEdit({
            path: "one.js",
            changes: [{ old: "const b = 2;", new: "const b = 3;" }],
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(
            read("one.js"),
            "const a = 1;\nconst b = 3;\nfunction f() {\n    return a + b;\n}\n"
        );
        assert.strictEqual(result.changes, 1);
        assert.strictEqual(result.matched, "exact");
    });

    await check("多个 changes 顺序执行", async () => {
        seed("multi.js", "a();\nb();\nc();\n");
        const result = await runEdit({
            path: "multi.js",
            changes: [
                { old: "a();", new: "alpha();" },
                { old: "c();", new: "gamma();" },
            ],
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("multi.js"), "alpha();\nb();\ngamma();\n");
        assert.strictEqual(result.changes, 2);
        assert.deepStrictEqual(result.changeResults, [
            { index: 1, ok: true, matched: "exact", startLine: 1, replacements: 1 },
            { index: 2, ok: true, matched: "exact", startLine: 3, replacements: 1 },
        ]);
    });

    await check("new 留空表示删除", async () => {
        seed("del.txt", "keep\nremove me\nkeep2\n");
        const result = await runEdit({
            path: "del.txt",
            changes: [{ old: "remove me\n", new: "" }],
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("del.txt"), "keep\nkeep2\n");
    });

    await check("all=true 替换全部命中", async () => {
        seed("all.js", "foo();\nbar();\nfoo();\n");
        const result = await runEdit({
            path: "all.js",
            changes: [{ old: "foo();", new: "baz();" }],
            all: true,
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("all.js"), "baz();\nbar();\nbaz();\n");
        assert.strictEqual(result.changes, 2);
        assert.strictEqual(result.changeResults[0].replacements, 2);
    });

    await check("CRLF 文件保持 CRLF，插入内容也转成 CRLF", async () => {
        seed("crlf.js", "a();\r\nb();\r\n");
        const result = await runEdit({
            path: "crlf.js",
            changes: [{ old: "a();\nb();", new: "a();\nc();\nd();" }],
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("crlf.js"), "a();\r\nc();\r\nd();\r\n");
    });

    await check("回显 diff 供模型自检", async () => {
        seed("diff.js", "line1\nline2\nline3\n");
        const result = await runEdit({
            path: "diff.js",
            changes: [{ old: "line2", new: "LINE-TWO" }],
        });
        assert.ok(result.diff.indexOf("-line2") !== -1, result.diff);
        assert.ok(result.diff.indexOf("+LINE-TWO") !== -1, result.diff);
        assert.ok(result.diff.indexOf("@@ -2,1 +2,1 @@") !== -1, result.diff);
    });

    console.log("\n=== 4. 歧义与失败 ===");
    await check("多处命中时报错并给出行号，文件不变", async () => {
        seed("dup.js", "foo();\nbar();\nfoo();\n");
        const result = await runEdit({
            path: "dup.js",
            changes: [{ old: "foo();", new: "baz();" }],
        });
        assert.strictEqual(result.ok, false);
        assert.ok(/Found 2 matches/.test(result.error), result.error);
        assert.ok(/lines 1, 3/.test(result.error), result.error);
        assert.strictEqual(result.changeResults[0].index, 1);
        assert.strictEqual(result.changeResults[0].ok, false);
        assert.strictEqual(result.changeResults[0].matches, 2);
        assert.deepStrictEqual(result.changeResults[0].lines, [1, 3]);
        assert.strictEqual(read("dup.js"), "foo();\nbar();\nfoo();\n");
    });

    await check("找不到时提示最接近的行号", async () => {
        seed("miss.js", "alpha();\nbeta();\ngamma();\n");
        const result = await runEdit({
            path: "miss.js",
            changes: [{ old: "alpha();\ndelta();\n", new: "x" }],
        });
        assert.strictEqual(result.ok, false);
        assert.ok(/not found/.test(result.error), result.error);
        assert.ok(/line 1/.test(result.error), result.error);
        assert.deepStrictEqual(result.changeResults[0].lines, [1]);
        assert.strictEqual(result.changeResults[0].nonContiguous, false);
        assert.strictEqual(result.changeResults[0].suggestedLine, 1);
        assert.strictEqual(read("miss.js"), "alpha();\nbeta();\ngamma();\n");
    });

    await check("中途一处失败则整体不写入", async () => {
        seed("partial.js", "a();\nb();\n");
        const result = await runEdit({
            path: "partial.js",
            changes: [
                { old: "a();", new: "alpha();" },
                { old: "zzz();", new: "zeta();" },
            ],
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.failedChanges, 1);
        assert.ok(/1 of 2 changes failed/.test(result.error), result.error);
        assert.strictEqual(result.changeResults.length, 2);
        assert.strictEqual(result.changeResults[0].ok, true);
        assert.strictEqual(result.changeResults[1].index, 2);
        assert.strictEqual(result.changeResults[1].ok, false);
        assert.strictEqual(read("partial.js"), "a();\nb();\n");
        assert.deepStrictEqual(
            fs.readdirSync(workspace).filter((name) => name.indexOf(".tmp.") !== -1),
            []
        );
    });

    await check("不连续 old 返回全部行号并指向最独特锚点", async () => {
        seed(
            "noncontiguous.txt",
            "remove me\nalpha\n\ncommon phrase\n\nmiddle\n\n[PROGRESS: P6完成 | 本段字数: 732 | 累计字数: 3579]\n\nfinal ending\n"
        );
        const result = await runEdit({
            path: "noncontiguous.txt",
            changes: [
                { old: "remove me\n", new: "" },
                {
                    old: "common phrase\n\n[PROGRESS: P6完成 | 本段字数: 732 | 累计字数: 3579]\n\nfinal ending",
                    new: "bad",
                },
                { old: "middle", new: "MIDDLE" },
            ],
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.failedChanges, 1);
        assert.deepStrictEqual(
            result.changeResults.map((item) => item.ok),
            [true, false, true]
        );
        const failure = result.changeResults[1];
        assert.strictEqual(failure.index, 2);
        assert.deepStrictEqual(failure.lines, [4, 8, 10]);
        assert.strictEqual(failure.nonContiguous, true);
        assert.strictEqual(failure.suggestedLine, 8);
        assert.ok(/not one contiguous block/.test(failure.error), failure.error);
        assert.strictEqual(
            read("noncontiguous.txt"),
            "remove me\nalpha\n\ncommon phrase\n\nmiddle\n\n[PROGRESS: P6完成 | 本段字数: 732 | 累计字数: 3579]\n\nfinal ending\n"
        );
    });

    await check("破坏 JSON 的修改被拒绝且不落盘", async () => {
        seed("data.json", '{"a":1}');
        const result = await runEdit({
            path: "data.json",
            changes: [{ old: '{"a":1}', new: '{"a":' }],
        });
        assert.strictEqual(result.ok, false);
        assert.ok(/Content validation failed/.test(result.error), result.error);
        assert.strictEqual(result.changeResults[0].ok, true);
        assert.strictEqual(read("data.json"), '{"a":1}');
    });

    await check("文件不存在时提示用 write", async () => {
        const result = await runEdit({
            path: "nope.txt",
            changes: [{ old: "a", new: "b" }],
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, "File does not exist; use write to create it");
    });

    await check("目标是目录时给出明确错误", async () => {
        fs.mkdirSync(path.join(workspace, "adir"), { recursive: true });
        const result = await runEdit({
            path: "adir",
            changes: [{ old: "a", new: "b" }],
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.error, "Path is an existing directory, not a file");
    });

    await check("二进制文件被拒绝", async () => {
        fs.writeFileSync(path.join(workspace, "blob.bin"), Buffer.from([0x61, 0x00, 0x62]));
        const result = await runEdit({
            path: "blob.bin",
            changes: [{ old: "a", new: "c" }],
        });
        assert.strictEqual(result.ok, false);
        assert.ok(/Binary file/.test(result.error), result.error);
    });

    await check("越界路径抛错", async () => {
        await assert.rejects(
            () =>
                runtime.run({
                    action: "edit",
                    params: { path: "../evil.txt", changes: [{ old: "a", new: "b" }] },
                }),
            (error) => error.message === "Path escapes workspace"
        );
    });

    await check("超过单次修改块上限时拒绝", async () => {
        seed("many.txt", Array.from({ length: 30 }, (_, i) => "line" + i).join("\n"));
        const changes = Array.from({ length: 21 }, (_, i) => ({
            old: "line" + i,
            new: "LINE" + i,
        }));
        const result = await runtime.run({
            action: "edit",
            params: { path: "many.txt", changes },
        });
        assert.strictEqual(result.ok, false);
        assert.ok(/Too many changes/.test(result.error), result.error);
    });

    console.log("\n=== 5. 宽松匹配 ===");
    await check("缩进与文件不一致也能命中，并补上正确缩进", async () => {
        seed("loose.js", "function f() {\n    if (x) {\n        return 1;\n    }\n}\n");
        // old/new 用的是 2/6/2 的缩进，文件里是 4/8/4：整块差 2 个空格
        const result = await runEdit({
            path: "loose.js",
            changes: [
                {
                    old: "  if (x) {\n      return 1;\n  }",
                    new: "  if (x) {\n      return 2;\n  }",
                },
            ],
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.matched, "loose");
        assert.strictEqual(result.changeResults[0].matched, "loose");
        assert.ok(typeof result.hint === "string" && result.hint.length > 0);
        assert.strictEqual(
            read("loose.js"),
            "function f() {\n    if (x) {\n        return 2;\n    }\n}\n"
        );
    });

    await check("old 比文件多缩进时按差量回收", async () => {
        seed("loose2.js", "if (y) {\n  ok();\n}\n");
        const result = await runEdit({
            path: "loose2.js",
            changes: [{ old: "if (y) {\n    ok();\n  }", new: "if (y) {\n    fine();\n  }" }],
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.matched, "loose");
        assert.strictEqual(read("loose2.js"), "if (y) {\n  fine();\n}\n");
    });

    await check("精确命中时不会走宽松分支", async () => {
        seed("exact.js", "const a = 1;\n");
        const result = await runEdit({
            path: "exact.js",
            changes: [{ old: "const a = 1;", new: "const a = 2;" }],
        });
        assert.strictEqual(result.matched, "exact");
        assert.strictEqual(result.hint, undefined);
    });

    await check("过短的锚点不启用宽松匹配，避免误命中", async () => {
        seed("short.js", "alpha();\nbeta();\n");
        const result = await runEdit({
            path: "short.js",
            changes: [{ old: "z();", new: "y();" }],
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(read("short.js"), "alpha();\nbeta();\n");
    });

    await check("宽松匹配 + all=true 命中多处时明确拒绝（不静默只改一处）", async () => {
        seed("looseall.js", "if (alpha) {\n     beta();\n}\nif (alpha) {\n     beta();\n}\n");
        const result = await runEdit({
            path: "looseall.js",
            changes: [{ old: "if (alpha) {\nbeta();\n}", new: "if (alpha) {\ngamma();\n}" }],
            all: true,
        });
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
        const result = await runEdit({
            path: "meta.txt",
            changes: [{ old: "a", new: "b" }],
        });
        assert.strictEqual(result.mutating, true);
    });

    await check("extractAction 的结果可直接传给 Runtime.run", async () => {
        seed("shape.txt", "hello\n");
        const action = extractAction(
            JSON.stringify({
                action: "edit",
                params: { path: "shape.txt", changes: [{ old: "hello", new: "world" }] },
            })
        );
        assert.deepStrictEqual(Object.keys(action).sort(), ["action", "params"]);
        const result = await runtime.run(action);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(read("shape.txt"), "world\n");
    });

    await check("Runtime.run 拒绝缺少 params 的旧节点结构", async () => {
        await assert.rejects(
            () =>
                runtime.run({
                    action: "edit",
                    node: {},
                }),
            /Action params must be an object/
        );
    });

    await check("diff 过长时截断，不把整文件塞回提示词", async () => {
        seed("big.txt", Array.from({ length: 80 }, (_, i) => "line" + i).join("\n") + "\n");
        const changes = Array.from({ length: 8 }, (_, i) => ({
            old: "line" + i + "\n",
            new: Array.from({ length: 12 }, (_, j) => "new" + i + "-" + j).join("\n") + "\n",
        }));
        const result = await runtime.run({
            action: "edit",
            params: { path: "big.txt", changes },
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
