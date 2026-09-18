
/**
GLM Provider 真机综合测试（CDP 浏览器）

参照 test-deepseek-comprehensive.js，对 GLM (chat.z.ai) 做真实浏览器联调：
- 连接 127.0.0.1:9222 上已登录 GLM 的 Chrome
- 发送真实 prompt，等待真实回复
- 覆盖：短文 / 长文 / 代码 / markdown / XML Action / 特殊字符
- 重点验证 DOM 逆向提取、内容不失真

用法：
node test/test-glm-comprehensive.js
node test/test-glm-comprehensive.js --reuse

前置条件：
- config/agent-config.js 里 chromePath 指向本机 Chrome
- 127.0.0.1:9222 已启动带 CDP 的 Chrome，且 GLM (chat.z.ai) 已登录
*/

const path = require("path");
const fs = require("fs");
const { GlmProvider } = require("../providers/glm");
const { extractXML } = require("../parse/xml-parse");
const { createRuntime } = require("../runtime");
const agentConfig = require("../config/agent-config");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "test-output-glm");

const CDATA_OPEN = "<" + "![CDATA[";
const CDATA_CLOSE = "]" + "]>";
const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);
const STAR = String.fromCharCode(42);
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const TILDE = String.fromCharCode(126);

function parseArgs(argv) {
    const args = { reuse: false };
    for (const raw of argv) {
        if (!raw.startsWith("--")) continue;
        const eq = raw.indexOf("=");
        const key = eq === -1 ? raw.substring(2) : raw.substring(2, eq);
        if (key === "reuse") args.reuse = true;
    }
    return args;
}

function countOccurrences(text, needle) {
    if (!text || !needle) return 0;
    let count = 0;
    let idx = text.indexOf(needle);
    while (idx !== -1) {
        count++;
        idx = text.indexOf(needle, idx + needle.length);
    }
    return count;
}

async function runCase(provider, runtime, name, prompt, check) {
    console.log("");
    console.log("==============================================");
    console.log("CASE " + name);
    console.log("==============================================");

    const t0 = Date.now();
    let response;

    try {
        response = await provider.send(prompt);
    } catch (e) {
        console.log("SEND FAILED: " + e.message);
        return { name, ok: false, error: "send: " + e.message };
    }

    const elapsed = Date.now() - t0;
    console.log("Response length: " + response.length + ", elapsed: " + elapsed + "ms");
    console.log("Response head: " + response.substring(0, 200));
    console.log("Response tail: " + response.substring(Math.max(0, response.length - 150)));

    let action = null;
    let parseError = null;

    try {
        action = extractXML(response);
    } catch (e) {
        parseError = e.message;
    }

    if (parseError) {
        console.log("extractXML FAILED: " + parseError);
    } else if (action) {
        console.log("Parsed action: " + action.action);
    }

    let result = null;
    if (action) {
        try {
            result = await runtime.run(action);
        } catch (e) {
            console.log("runtime.run FAILED: " + e.message);
        }
    }

    if (result) {
        console.log("Runtime result ok: " + result.ok + ", action: " + result.action);
    }

    let items;
    try {
        items = await check(response, action, result, runtime);
    } catch (e) {
        console.log("check FAILED: " + e.message);
        return { name, ok: false, error: "check: " + e.message };
    }

    let pass = 0;
    for (const item of items) {
        const label = item[0];
        const ok = item[1];
        console.log((ok ? "PASS" : "FAIL") + " - " + label);
        if (ok) pass++;
    }

    return {
        name,
        ok: pass === items.length,
        passed: pass,
        total: items.length,
        elapsed,
        responseLength: response.length,
    };
}

function buildExampleWriteLine() {
    return (
        LT + 'write path="src/example.js"' + GT +
        CDATA_OPEN + 'console.log("hi");' + CDATA_CLOSE +
        LT + "/write" + GT
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (fs.existsSync(OUTPUT_DIR)) {
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT_DIR, "seed.txt"), "hello from glm seed\n", "utf8");

    const provider = new GlmProvider({
        autoStart: false,
        cdpUrl: agentConfig.browser.cdpUrl,
        chromePath: agentConfig.browser.chromePath,
        targetUrl: agentConfig.browser.targetUrls.glm,
        reuseExistingPage: args.reuse === true,
        responseTimeout: 15 * 60 * 1000,
        responseInitialTimeout: 120 * 1000,
    });

    console.log("[glm-comprehensive] starting provider...");
    await provider.start();
    console.log("[glm-comprehensive] connected: " + (provider.page ? provider.page.url() : "(none)"));

    const runtime = createRuntime(OUTPUT_DIR);
    const results = [];
    const exampleLine = buildExampleWriteLine();

    // Case 1: short plain text answer
    results.push(await runCase(provider, runtime, "short-plain-text",
        [
            "你是一个 XML Agent。可用 XML Action 示例：",
            exampleLine,
            "",
            "请写一个 answer action，回答内容为：GLM 短文测试通过。",
            "只输出一个 XML Action，不要输出任何解释。",
        ].join("\n"),
        async (response, action, result) => [
            ["action=answer", action && action.action === "answer"],
            ["runtime ok", result && result.ok === true],
            ["内容完整", result && (result.content || "").indexOf("短文测试通过") !== -1],
            ["无乱码字符", response.indexOf("\uFFFD") === -1],
        ]
    ));

    // Case 2: short markdown with list and bold
    results.push(await runCase(provider, runtime, "short-markdown",
        [
            "你是一个 XML Agent。可用 XML Action 示例：",
            exampleLine,
            "",
            "请写一个 write action 写入 docs/short.md，内容是一个 markdown 短文档：",
            "1. 一级标题：短文档",
            "2. 三个无序列表项，使用 - 符号：项目一、项目二、项目三",
            "3. 一段粗体文字",
            "只输出一个 XML Action，不要输出任何解释。",
        ].join("\n"),
        async (response, action, result) => {
            const p = action && action.node && action.node["@_path"]
                ? path.join(OUTPUT_DIR, action.node["@_path"]) : null;
            const text = p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
            return [
                ["action=write", action && action.action === "write"],
                ["runtime ok", result && result.ok === true],
                ["有 # 短文档", text.indexOf("# 短文档") !== -1],
                ["有 - 项目", text.indexOf("- ") !== -1],
                ["有粗体 " + STAR + STAR, text.indexOf(STAR + STAR) !== -1],
            ];
        }
    ));

    // Case 3: long markdown with multiple sections
    const fence = BACKTICK + BACKTICK + BACKTICK;
    results.push(await runCase(provider, runtime, "long-markdown",
        [
            "你是一个 XML Agent。可用 XML Action 示例：",
            exampleLine,
            "",
            "请写一个 write action 写入 docs/long.md。",
            "正文必须是完整、连贯、有实际信息量的 Markdown 使用指南，正文有效内容至少 500 个中文字符。",
            "内容要求：",
            "1. 一级标题：GLM 项目使用指南",
            "2. 简介至少 3 句话",
            "3. 二级标题：安装",
            "4. 一个 bash 代码块含 npm install",
            "5. 二级标题：快速开始",
            "6. 一个 javascript 代码块定义 function greet(name)",
            "7. 二级标题：常见问题",
            "8. 至少 3 个 FAQ",
            "9. 二级标题：总结",
            "10. 一段不少于 3 句话的总结",
            "只输出一个 XML Action，不要输出解释。",
        ].join("\n"),
        async (response, action, result) => {
            const p = action && action.node && action.node["@_path"]
                ? path.join(OUTPUT_DIR, action.node["@_path"]) : null;
            const text = p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
            const fenceCount = countOccurrences(text, fence);
            const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
            return [
                ["action=write", action && action.action === "write"],
                ["runtime ok", result && result.ok === true],
                ["有 # GLM 项目使用指南", text.indexOf("# GLM") !== -1 || text.indexOf("# 项目使用指南") !== -1],
                ["有 ## 安装", text.indexOf("## 安装") !== -1],
                ["有 ## 快速开始", text.indexOf("## 快速开始") !== -1],
                ["有 ## 常见问题", text.indexOf("## 常见问题") !== -1],
                ["有 ## 总结", text.indexOf("## 总结") !== -1],
                ["有 npm install", text.indexOf("npm install") !== -1],
                ["有 function greet", text.indexOf("function greet") !== -1],
                ["代码围栏成对（偶数）", fenceCount > 0 && fenceCount % 2 === 0],
                ["中文正文 >= 500 字", chineseCount >= 500],
                ["正文 >= 1000 字符", text.length >= 1000],
            ];
        }
    ));

    // Case 4: long code that can run
    results.push(await runCase(provider, runtime, "long-code",
        [
            "你是一个 XML Agent。可用 XML Action 示例：",
            exampleLine,
            "",
            "请写一个 write action 写入 src/toolkit.js。",
            "最终 JavaScript 源文件必须不少于 120 行，并且实际代码内容至少 500 个字符。",
            "要求：",
            "1. 包含 deepClone / debounce / throttle / formatBytes / parseQuery / unique / groupBy / sleep / range / flatten 十个函数",
            "2. 每个函数带有清晰注释",
            "3. 末尾有 runTests() 自测并 console.log 输出多个测试结果",
            "4. 可直接 node 运行，不 require 外部包，不使用 export",
            "5. deepClone 必须正确处理循环引用",
            "只输出一个 XML Action，不要输出解释。",
        ].join("\n"),
        async (response, action, result, rt) => {
            const rel = action && action.node && action.node["@_path"] ? action.node["@_path"] : null;
            const p = rel ? path.join(OUTPUT_DIR, rel) : null;
            const text = p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
            let execResult = null;
            if (rel) {
                try {
                    execResult = await rt.execute({ "@_command": "node " + rel });
                } catch (e) {
                    execResult = { ok: false, output: "" };
                }
            }
            const out = execResult ? execResult.output || execResult.stdout || "" : "";
            return [
                ["action=write", action && action.action === "write"],
                ["代码 >= 120 行", text.split("\n").length >= 120],
                ["代码 >= 500 字符", text.length >= 500],
                ["有 deepClone", text.indexOf("deepClone") !== -1],
                ["有 debounce", text.indexOf("debounce") !== -1],
                ["有 throttle", text.indexOf("throttle") !== -1],
                ["有 formatBytes", text.indexOf("formatBytes") !== -1],
                ["有 parseQuery", text.indexOf("parseQuery") !== -1],
                ["exec ok", execResult && execResult.ok === true],
                ["stdout 非空", out.trim().length > 0],
            ];
        }
    ));

    // Case 5: JSON file
    results.push(await runCase(provider, runtime, "json-file",
        [
            "你是一个 XML Agent。可用 XML Action 示例：",
            exampleLine,
            "",
            "请写一个 write action 写入 config/demo.json，内容为合法 JSON：",
            "1. name 字段为 demo",
            "2. version 字段为 1",
            "3. tags 字段为长度 3 的字符串数组，元素 a b c",
            "4. nested 字段为对象，ok=true，count=3",
            "只输出一个 XML Action，不要输出解释。",
        ].join("\n"),
        async (response, action, result) => {
            const p = action && action.node && action.node["@_path"]
                ? path.join(OUTPUT_DIR, action.node["@_path"]) : null;
            let parsed = null;
            if (p && fs.existsSync(p)) {
                try { parsed = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { parsed = null; }
            }
            return [
                ["action=write", action && action.action === "write"],
                ["runtime ok", result && result.ok === true],
                ["JSON 合法", parsed !== null],
                ["name=demo", parsed && parsed.name === "demo"],
                ["version=1", parsed && parsed.version === 1],
                ["tags 长度 3", parsed && Array.isArray(parsed.tags) && parsed.tags.length === 3],
                ["nested.ok=true", parsed && parsed.nested && parsed.nested.ok === true],
            ];
        }
    ));

    // Case 6: special characters
    results.push(await runCase(provider, runtime, "special-chars",
        [
            "你是一个 XML Agent。可用 XML Action 示例：",
            exampleLine,
            "",
            "请写一个 write action 写入 docs/special.md，内容包含：",
            "1. 中文段落，写到特殊字符测试这几个字",
            "2. 一行英文，包含单引号和双引号字符",
            "3. 一行反斜杠路径，例如 C 盘 Users 下 test 目录",
            "4. 一行数学比较符号：小于、大于、小于等于、大于等于、不等于",
            "5. 一行火箭和勾选 emoji",
            "只输出一个 XML Action，不要输出解释。",
        ].join("\n"),
        async (response, action, result) => {
            const p = action && action.node && action.node["@_path"]
                ? path.join(OUTPUT_DIR, action.node["@_path"]) : null;
            const text = p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
            return [
                ["action=write", action && action.action === "write"],
                ["有中文特殊字符测试", text.indexOf("特殊字符测试") !== -1],
                ["有 emoji", text.indexOf("🚀") !== -1 || text.indexOf("✅") !== -1],
                ["有 Users 或反斜杠", text.indexOf("Users") !== -1 || text.indexOf(BACKSLASH) !== -1],
                ["有数学比较符号", text.indexOf("<=") !== -1 || text.indexOf(">=") !== -1 || text.indexOf("!=") !== -1],
                ["无替换字符（无乱码）", response.indexOf("\uFFFD") === -1],
            ];
        }
    ));

    // Case 7: inline formatting
    results.push(await runCase(provider, runtime, "inline-formatting",
        [
            "你是一个 XML Agent。可用 XML Action 示例：",
            exampleLine,
            "",
            "请写一个 write action 写入 docs/inline.md，内容为一行 markdown，包含：",
            "1. 一个粗体片段",
            "2. 一个斜体片段",
            "3. 一个行内 code 片段，内容为 npm run build",
            "4. 一个链接，文本 Example 指向 https://example.com",
            "只输出一个 XML Action，不要输出解释。",
        ].join("\n"),
        async (response, action, result) => {
            const p = action && action.node && action.node["@_path"]
                ? path.join(OUTPUT_DIR, action.node["@_path"]) : null;
            const text = p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
            return [
                ["action=write", action && action.action === "write"],
                ["runtime ok", result && result.ok === true],
                ["有粗体 " + STAR + STAR, text.indexOf(STAR + STAR) !== -1],
                ["有行内 code " + BACKTICK, text.indexOf(BACKTICK) !== -1],
                ["有链接目标", text.indexOf("https://example.com") !== -1],
                ["有 Example 文本", text.indexOf("Example") !== -1],
            ];
        }
    ));

    await provider.close();

    console.log("");
    console.log("==============================================");
    console.log("汇总");
    console.log("==============================================");

    let okCount = 0;
    for (const r of results) {
        if (r.ok) okCount++;
        console.log(JSON.stringify(r));
    }

    console.log("");
    console.log("Total: " + okCount + "/" + results.length + " cases passed");

    if (okCount !== results.length) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Fatal:", err && err.stack ? err.stack : err);
    process.exit(1);
});
