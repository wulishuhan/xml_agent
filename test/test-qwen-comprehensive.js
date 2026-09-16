const path = require("path");
const fs = require("fs");
const { createProvider } = require("../providers");
const { extractXML } = require("../parse/xml-parse");
const { createRuntime } = require("../runtime");
const agentConfig = require("../config/agent-config");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "test-output-comprehensive");

const CDATA_OPEN = "<!" + "[CDATA[";
const CDATA_CLOSE = "]" + "]>";
const BACKSLASH = String.fromCharCode(92);

async function runCase(provider, runtime, name, prompt, check) {
    console.log("\n==============================================");
    console.log("CASE " + name);
    console.log("==============================================");

    const t0 = Date.now();
    let response;
    try {
        response = await provider.send(prompt);
    } catch (e) {
        console.log("SEND FAILED:", e.message);
        return { name, ok: false, error: "send: " + e.message };
    }
    console.log("Response length:", response.length, "elapsed:", Date.now() - t0, "ms");
    console.log("Response head:", response.substring(0, 200));
    console.log("Response tail:", response.substring(Math.max(0, response.length - 150)));

    let action;
    try {
        action = extractXML(response);
    } catch (e) {
        console.log("extractXML FAILED:", e.message);
        return { name, ok: false, error: "extractXML: " + e.message };
    }

    console.log("Parsed action:", action.action);
    if (action.node && action.node["@_path"]) {
        console.log("Parsed path:", action.node["@_path"]);
    }
    if (action.node && action.node["@_command"]) {
        console.log("Parsed command:", action.node["@_command"]);
    }

    let result;
    try {
        result = await runtime.run(action);
    } catch (e) {
        console.log("runtime.run FAILED:", e.message);
        return { name, ok: false, error: "runtime: " + e.message };
    }

    console.log("Runtime result ok:", result.ok, "action:", result.action);

    const items = await check(action, result, runtime);
    let pass = 0;
    for (const item of items) {
        const label = item[0];
        const ok = item[1];
        console.log((ok ? "PASS" : "FAIL") + " - " + label);
        if (ok) pass++;
    }

    return { name, ok: pass === items.length, passed: pass, total: items.length };
}

async function main() {
    if (fs.existsSync(OUTPUT_DIR)) {
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // 先准备一个 seed.txt，让 read-action 能读到真实存在的文件
    fs.writeFileSync(path.join(OUTPUT_DIR, "seed.txt"), "hello from seed\nline2\n", "utf8");

    const provider = createProvider("qwen", {
        autoStart: false,
        cdpUrl: agentConfig.browser.cdpUrl,
        chromePath: agentConfig.browser.chromePath,
        targetUrl: agentConfig.browser.targetUrls.qwen,
        reuseExistingPage: true,
        responseTimeout: 15 * 60 * 1000,
        responseInitialTimeout: 120 * 1000,
    });

    await provider.start();
    console.log("[comprehensive] connected:", provider.page ? provider.page.url() : "(none)");

    const runtime = createRuntime(OUTPUT_DIR);
    const results = [];

    const exampleLine =
        '<write path="src/example.js">' +
        CDATA_OPEN +
        'console.log("hi");' +
        CDATA_CLOSE +
        "</write>";

    // Case 1: read（读 seed.txt，一定存在）
    try {
        const r = await runCase(
            provider,
            runtime,
            "read-action",
            [
                "你是一个 XML Agent。可用 XML Action：",
                exampleLine,
                '<read path="seed.txt"/>',
                "",
                '请写一个 read action 读取 "seed.txt"。',
                "只输出一个 XML Action。",
            ].join("\n"),
            async (action, result) => {
                return [
                    ["action=read", action.action === "read"],
                    ["path=seed.txt", action.node["@_path"] === "seed.txt"],
                    ["read ok", result.ok === true],
                    ["内容含 hello", (result.content || "").indexOf("hello") !== -1],
                ];
            }
        );
        results.push(r);
    } catch (e) {
        results.push({ name: "read-action", ok: false, error: e.message });
    }

    // Case 2: exec
    try {
        const r = await runCase(
            provider,
            runtime,
            "exec-action",
            [
                "你是一个 XML Agent。可用 XML Action：",
                '<exec command="node -v"/>',
                exampleLine,
                "",
                '请写一个 exec action，执行命令 "node -v"。',
                "只输出一个 XML Action。",
            ].join("\n"),
            async (action, result) => {
                return [
                    ["action=exec", action.action === "exec"],
                    ["exec ok", result.ok === true],
                    ["stdout 有版本号", /v?\d+.\d+/.test(result.output || "")],
                ];
            }
        );
        results.push(r);
    } catch (e) {
        results.push({ name: "exec-action", ok: false, error: e.message });
    }

    // Case 3: answer
    try {
        const r = await runCase(
            provider,
            runtime,
            "answer-action",
            [
                "你是一个 XML Agent。可用 XML Action：",
                "<answer>" + CDATA_OPEN + "答案" + CDATA_CLOSE + "</answer>",
                exampleLine,
                "",
                "请写一个 answer action，内容是：Qwen 测试通过。",
                "只输出一个 XML Action。",
            ].join("\n"),
            async (action, result) => {
                return [
                    ["action=answer", action.action === "answer"],
                    ["answer ok", result.ok === true],
                    ["内容含通过", (result.content || "").indexOf("通过") !== -1],
                ];
            }
        );
        results.push(r);
    } catch (e) {
        results.push({ name: "answer-action", ok: false, error: e.message });
    }

    // Case 4: 短 md
    try {
        const r = await runCase(
            provider,
            runtime,
            "short-md",
            [
                "你是一个 XML Agent。可用 XML Action：",
                exampleLine,
                "",
                "请写一个 write action 写入 docs/short.md：",
                "- 一级标题：短文档",
                "- 三个列表项：一、二、三",
                "- 一段粗体文字",
                "只输出一个 XML Action。",
            ].join("\n"),
            async (action, result) => {
                const p = path.join(OUTPUT_DIR, action.node["@_path"]);
                const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
                return [
                    ["action=write", action.action === "write"],
                    ["write ok", result.ok === true],
                    ["有 # 短文档", text.indexOf("# 短文档") !== -1],
                    ["有 - 一", text.indexOf("- 一") !== -1],
                    ["有粗体", text.indexOf(String.fromCharCode(42, 42)) !== -1],
                ];
            }
        );
        results.push(r);
    } catch (e) {
        results.push({ name: "short-md", ok: false, error: e.message });
    }

    // Case 5: 长 md
    try {
        const r = await runCase(
            provider,
            runtime,
            "long-md",
            [
                "你是一个 XML Agent。可用 XML Action：",
                exampleLine,
                "",
                "请写一个 write action 写入 docs/long.md，",
                "包含：",
                "1. 一级标题：项目使用指南",
                "2. 简介 >= 3 句话",
                "3. 二级标题：安装",
                "4. 一个 bash 代码块，里面是 npm install",
                "5. 二级标题：快速开始",
                "6. 一个 javascript 代码块，定义 greet(name) 返回 Hello 名字",
                "7. 二级标题：常见问题",
                "8. 至少 3 个 FAQ，每个一问一答",
                "9. 二级标题：总结",
                "10. 一段 >= 2 句总结",
                "正文 >= 800 字符。",
                "只输出一个 XML Action。",
            ].join("\n"),
            async (action, result) => {
                const p = path.join(OUTPUT_DIR, action.node["@_path"]);
                const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
                return [
                    ["action=write", action.action === "write"],
                    ["有 # 项目使用指南", text.indexOf("# 项目使用指南") !== -1],
                    ["有 ## 安装", text.indexOf("## 安装") !== -1],
                    ["有 ## 快速开始", text.indexOf("## 快速开始") !== -1],
                    ["有 ## 常见问题", text.indexOf("## 常见问题") !== -1],
                    ["有 ## 总结", text.indexOf("## 总结") !== -1],
                    ["有 npm install", text.indexOf("npm install") !== -1],
                    ["有 function greet", text.indexOf("function greet") !== -1],
                    ["正文 >= 800", text.length >= 800],
                ];
            }
        );
        results.push(r);
    } catch (e) {
        results.push({ name: "long-md", ok: false, error: e.message });
    }

    // Case 6: 长代码
    try {
        const r = await runCase(
            provider,
            runtime,
            "long-code",
            [
                "你是一个 XML Agent。可用 XML Action：",
                exampleLine,
                "",
                "请写一个 write action 写入 src/toolkit.js：",
                "- 包含 deepClone / debounce / throttle / formatBytes / parseQuery / unique / groupBy / sleep / range / flatten 十个函数",
                "- 每个函数带注释",
                "- 末尾有 runTests() 自测并 console.log 输出",
                "- 直接可 node 运行，不要 require 外部包，不要 export",
                "- 代码 >= 120 行",
                "只输出一个 XML Action。",
            ].join("\n"),
            async (action, result, rt) => {
                const p = path.join(OUTPUT_DIR, action.node["@_path"]);
                const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
                const execResult = await rt.execute({
                    "@_command": "node " + action.node["@_path"],
                });
                const out = execResult.output || execResult.stdout || "";
                return [
                    ["action=write", action.action === "write"],
                    ["file >= 120 行", text.split("\n").length >= 120],
                    ["有 deepClone", text.indexOf("deepClone") !== -1],
                    ["有 formatBytes", text.indexOf("formatBytes") !== -1],
                    ["有 parseQuery", text.indexOf("parseQuery") !== -1],
                    ["exec ok", execResult.ok === true],
                    ["stdout 非空", out.trim().length > 0],
                ];
            }
        );
        results.push(r);
    } catch (e) {
        results.push({ name: "long-code", ok: false, error: e.message });
    }

    // Case 7: JSON 文件
    try {
        const r = await runCase(
            provider,
            runtime,
            "json-file",
            [
                "你是一个 XML Agent。可用 XML Action：",
                exampleLine,
                "",
                "请写一个 write action 写入 config/demo.json，",
                "内容是合法 JSON：",
                "- name 字段值为 demo",
                "- version 字段值为 1",
                "- tags 字段是一个长度为 3 的字符串数组，元素为 a b c",
                "- nested 字段是一个对象，ok 为 true，count 为 3",
                "只输出一个 XML Action。",
            ].join("\n"),
            async (action, result) => {
                const p = path.join(OUTPUT_DIR, action.node["@_path"]);
                let parsed = null;
                if (fs.existsSync(p)) {
                    const text = fs.readFileSync(p, "utf8");
                    try {
                        parsed = JSON.parse(text);
                    } catch (e) {
                        parsed = null;
                    }
                }
                return [
                    ["action=write", action.action === "write"],
                    ["write ok", result.ok === true],
                    ["JSON 合法", parsed !== null],
                    ["name=demo", parsed && parsed.name === "demo"],
                    ["version=1", parsed && parsed.version === 1],
                    [
                        "tags 长度 3",
                        parsed && Array.isArray(parsed.tags) && parsed.tags.length === 3,
                    ],
                ];
            }
        );
        results.push(r);
    } catch (e) {
        results.push({ name: "json-file", ok: false, error: e.message });
    }

    // Case 8: 特殊字符
    try {
        const r = await runCase(
            provider,
            runtime,
            "special-chars",
            [
                "你是一个 XML Agent。可用 XML Action：",
                exampleLine,
                "",
                "请写一个 write action 写入 docs/special.md，",
                "内容包含下面这些项：",
                "1. 中文段落，写到特殊字符测试这几个字",
                "2. 一行英文，包含单引号和双引号字符",
                "3. 一行反斜杠路径，例如 C 盘 Users 下 test 目录",
                "4. 一行数学比较符号：小于、大于、小于等于、大于等于、不等于、与、或",
                "5. 一行火箭和勾选 emoji",
                "只输出一个 XML Action。",
            ].join("\n"),
            async (action, result) => {
                const p = path.join(OUTPUT_DIR, action.node["@_path"]);
                const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
                return [
                    ["action=write", action.action === "write"],
                    ["有中文", text.indexOf("特殊字符测试") !== -1],
                    ["有 emoji", text.indexOf("🚀") !== -1 || text.indexOf("✅") !== -1],
                    [
                        "有 Users 或反斜杠",
                        text.indexOf("Users") !== -1 || text.indexOf(BACKSLASH) !== -1,
                    ],
                    [
                        "有尖括号或数学符号",
                        text.indexOf("<=") !== -1 ||
                            text.indexOf(">=") !== -1 ||
                            text.indexOf("!=") !== -1,
                    ],
                ];
            }
        );
        results.push(r);
    } catch (e) {
        results.push({ name: "special-chars", ok: false, error: e.message });
    }

    await provider.close();

    console.log("\n\n==============================================");
    console.log("汇总");
    console.log("==============================================");
    let okCount = 0;
    for (const r of results) {
        if (r.ok) okCount++;
        console.log(JSON.stringify(r));
    }
    console.log("\nTotal: " + okCount + "/" + results.length + " cases passed");
}

main().catch((err) => {
    console.error("Fatal:", err && err.stack ? err.stack : err);
    process.exit(1);
});
