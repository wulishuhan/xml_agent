/**
提示词里的示例必须是"真能被解析器吃下去"的 XML

背景：提示词是模型唯一的语法说明书。里面每个示例都会被执行层按字面意思解析，
一旦示例写错（少个斜杠、属性名拼错、CDATA 没闭合），模型照着抄回来的动作会被
解析层判成 Unknown XML Action 或校验失败，而单元测试里没有任何一处覆盖"示例本身
合法"。改提示词时最容易踩的就是这个坑：文案看着对，模型一抄就报错。

这个测试守两件事：
1. 每条被文档化的示例，都能被 parse/xml-parse 解析成预期的动作与属性；
2. 提示词里出现的单行自闭合示例（<read/> <exec/> <done/> 这类）全部可解析
   —— 以后新增示例忘了闭合，这里会先红。

运行：node test/unit/test-prompt-examples.js
*/

const assert = require("assert");
const { SYSTEM_PROMPT } = require("../../prompts/system-prompt");
const { getRuntimeOkPrompt, getRuntimeErrorPrompt } = require("../../prompts/runtime-prompt");
const { extractXML } = require("../../parse/xml-parse");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
        console.log("PASS - " + name);
        return;
    }
    console.log("FAIL - " + name + (detail ? "  [" + detail + "]" : ""));
}

function parseSafely(snippet) {
    try {
        return { action: extractXML(snippet), error: null };
    } catch (error) {
        return { action: null, error: error.message };
    }
}

/**
文档化的示例：出现过的每一段多行示例都列在这里。
snippet 必须与提示词里的原文逐字一致（有 includes 断言守着），
这样"改了提示词忘了改测试"会立刻暴露。
*/
const DOCUMENTED = [
    {
        name: "read 文件",
        snippet: '<read path="package.json"/>',
        action: "read",
        attrs: { "@_path": "package.json" },
    },
    {
        name: "read 目录",
        snippet: '<read path="src"/>',
        action: "read",
        attrs: { "@_path": "src" },
    },
    {
        name: "write（内容在 CDATA 里）",
        snippet: '<write path="src/a.js"><![CDATA[\nconsole.log("hello");\n]]></write>',
        action: "write",
        attrs: { "@_path": "src/a.js" },
        content: 'console.log("hello");',
    },
    {
        name: "edit（扁平 old/new 写法）",
        snippet:
            '<edit path="src/a.js"><old><![CDATA[const port = 3000;]]></old><new><![CDATA[const port = process.env.PORT || 3000;]]></new></edit>',
        action: "edit",
        attrs: { "@_path": "src/a.js" },
        changes: [["const port = 3000;", "const port = process.env.PORT || 3000;"]],
    },
    {
        name: "edit（多 change 写法）",
        snippet:
            '<edit path="a.js"><change><old>…</old><new>…</new></change><change><old>…</old><new>…</new></change></edit>',
        action: "edit",
        attrs: { "@_path": "a.js" },
        changes: [
            ["…", "…"],
            ["…", "…"],
        ],
    },
    {
        name: "exec",
        snippet: '<exec command="npm test"/>',
        action: "exec",
        attrs: { "@_command": "npm test" },
    },
    {
        name: "screenshot 单张",
        snippet: '<screenshot source="screen" path="screenshots/desktop.png"/>',
        action: "screenshot",
        attrs: { "@_source": "screen", "@_path": "screenshots/desktop.png" },
    },
    {
        name: "screenshot 多目标",
        snippet:
            '<screenshot><target source="window" windowTitle="Visual Studio Code" path="screenshots/vscode.png"/><target source="browser_page" url="https://example.com" path="screenshots/page.png"/></screenshot>',
        action: "screenshot",
        targets: [
            { "@_source": "window", "@_windowTitle": "Visual Studio Code" },
            { "@_source": "browser_page", "@_url": "https://example.com" },
        ],
    },
    {
        name: "answer",
        snippet: "<answer><![CDATA[\n最终答案\n]]></answer>",
        action: "answer",
        content: "最终答案",
    },
    {
        name: "done",
        snippet: "<done/>",
        action: "done",
    },
];

function textOf(node) {
    // answer 没有属性，解析结果是裸字符串；带属性的动作把内容放在 #text 里
    if (typeof node === "string") {
        return node.trim();
    }
    const value = node && node["#text"];
    return typeof value === "string" ? value.trim() : "";
}

function main() {
    console.log("=== 1. 文档化示例：逐条能被解析 ===");
    for (const item of DOCUMENTED) {
        check(
            "示例出现在提示词里：" + item.name,
            SYSTEM_PROMPT.indexOf(item.snippet) !== -1,
            "提示词里找不到这段示例"
        );
        const { action, error } = parseSafely(item.snippet);
        if (!action) {
            check("可解析：" + item.name, false, error);
            continue;
        }
        check("动作名正确：" + item.name, action.action === item.action, String(action.action));
        if (item.attrs) {
            for (const [key, expected] of Object.entries(item.attrs)) {
                check(
                    "属性正确：" + item.name + " / " + key,
                    action.node && action.node[key] === expected,
                    JSON.stringify(action.node && action.node[key])
                );
            }
        }
        if (item.content) {
            check(
                "内容原样保留：" + item.name,
                textOf(action.node) === item.content,
                textOf(action.node)
            );
        }
        if (item.changes) {
            const changes = (action.node && action.node.change) || [];
            const actual = [].concat(changes).map((change) => [change.old, change.new]);
            check(
                "change 数量正确：" + item.name,
                actual.length === item.changes.length,
                "len=" + actual.length
            );
            item.changes.forEach((pair, index) => {
                check(
                    "change[" + index + "] 内容正确：" + item.name,
                    actual[index] && actual[index][0] === pair[0] && actual[index][1] === pair[1],
                    JSON.stringify(actual[index])
                );
            });
        }
        if (item.targets) {
            const targets = (action.node && action.node.target) || [];
            check(
                "target 数量正确：" + item.name,
                targets.length === item.targets.length,
                "len=" + targets.length
            );
            item.targets.forEach((expected, index) => {
                const target = targets[index] || {};
                const ok = Object.entries(expected).every(([key, value]) => target[key] === value);
                check("target[" + index + "] 属性正确：" + item.name, ok, JSON.stringify(target));
            });
        }
    }

    console.log("\n=== 2. 提示词里的单行示例全部可解析 ===");
    // 只挑"整行就是一个完整动作"的行：形如 <tag .../> 或 <tag>...</tag>
    const singleLine = SYSTEM_PROMPT.split("\n")
        .map((line) => line.trim())
        .filter((line) => /^<(read|write|edit|exec|screenshot|answer|done)\b/.test(line))
        .filter((line) => line.endsWith("/>") || /<\/[a-z]+>$/.test(line));
    check("确实找到了单行示例", singleLine.length >= 5, "count=" + singleLine.length);
    for (const line of singleLine) {
        const expected = line.match(/^<([a-z]+)/)[1];
        const { action, error } = parseSafely(line);
        check(
            "单行示例可解析：" + line.slice(0, 40),
            Boolean(action) && action.action === expected,
            error || (action ? action.action : "null")
        );
    }

    console.log("\n=== 3. 每轮提示词里的动作同样可解析 ===");
    const runtimePrompts = [
        getRuntimeOkPrompt({ ok: true, action: "read", path: "a.js", content: "x" }),
        getRuntimeErrorPrompt({ ok: false, action: "exec", error: "boom" }),
    ];
    for (const prompt of runtimePrompts) {
        const snippets = prompt.match(/<answer>[\s\S]*?<\/answer>|<done\/>/g) || [];
        check("每轮提示词至少给出一个结束动作", snippets.length >= 1, "count=" + snippets.length);
        for (const snippet of snippets) {
            const { action, error } = parseSafely(snippet);
            check(
                "每轮提示词的动作可解析：" + snippet.slice(0, 24),
                Boolean(action),
                error || "null"
            );
        }
    }

    console.log("\n=== 4. 属性名写错会被拒绝（示例不能依赖宽松解析） ===");
    {
        const { action, error } = parseSafely('<read file="package.json"/>');
        check("缺 path 的 read 被拒", !action, error || "竟然通过了");
    }
    {
        const { action, error } = parseSafely("<exec/>");
        check("缺 command 的 exec 被拒", !action, error || "竟然通过了");
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);
    if (pass !== total) {
        assert.fail("prompt examples test failed");
    }
}

main();
