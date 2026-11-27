/**
 * 文言文协议 token 节省基准（实验协议 wenyan）
 *
 * 目的：量化"同等信息量下，文言格式比 XML / JSON 省多少输入输出"。
 * 方法：对一组代表性动作 + 系统提示词，分别用三种格式写出等价表达，
 *       统计字符数与估算 token（复用 context-budget 的 estimateTokens 启发式）。
 *
 * 运行：node test/wenyan-token-benchmark.js
 * 说明：这是估算（CJK 1 字≈1 token，ASCII 4 字符≈1 token），真实值随 tokenizer 浮动，
 *       但三者用同一把尺子，相对比例可信。
 */

const { estimateTokens } = require("../webui/session/context-budget");
const { SYSTEM_PROMPT: XML_SYSTEM } = require("../prompts/xml/system-prompt");
const { SYSTEM_PROMPT: JSON_SYSTEM } = require("../prompts/json/system-prompt");
const { SYSTEM_PROMPT: WENYAN_SYSTEM } = require("../prompts/wenyan/system-prompt");
const XML_RUNTIME = require("../prompts/xml/runtime-prompt");
const JSON_RUNTIME = require("../prompts/json/runtime-prompt");
const WENYAN_RUNTIME = require("../prompts/wenyan/runtime-prompt");

/** 同一语义的三种表达。每项：[场景, XML, JSON, 文言] */
const ACTIONS = [
    [
        "读文件",
        '<read path="package.json"/>',
        '{"action":"read","params":{"path":"package.json"}}',
        "阅 package.json",
    ],
    [
        "续读(带偏移)",
        '<read path="src/a.js" offset="100" limit="4000"/>',
        '{"action":"read","params":{"path":"src/a.js","offset":100,"limit":4000}}',
        "阅 src/a.js 100 4000",
    ],
    [
        "建文件",
        '<write path="src/a.js"><![CDATA[console.log("hi");]]></write>',
        '{"action":"write","params":{"path":"src/a.js","content":"console.log(\\"hi\\");"}}',
        '书 src/a.js「console.log("hi");」',
    ],
    [
        "改一处",
        '<edit path="a.js"><change><old><![CDATA[const port = 3000;]]></old><new><![CDATA[const port = 8080;]]></new></change></edit>',
        '{"action":"edit","params":{"path":"a.js","changes":[{"old":"const port = 3000;","new":"const port = 8080;"}]}}',
        "改 a.js「const port = 3000;」「const port = 8080;」",
    ],
    [
        "执行命令",
        '<exec command="npm test"/>',
        '{"action":"exec","params":{"command":"npm test"}}',
        "行 npm test",
    ],
    [
        "截图",
        '<screenshot source="screen" path="screenshots/desktop.png"/>',
        '{"action":"screenshot","params":{"targets":[{"source":"screen","path":"screenshots/desktop.png"}]}}',
        "摄 screen screenshots/desktop.png",
    ],
    [
        "答复",
        '<answer><![CDATA[最终答案]]></answer>',
        '{"action":"answer","params":{"content":"最终答案"}}',
        "答「最终答案」",
    ],
    ["收尾", "<done/>", '{"action":"done","params":{}}', "毕"],
];

function measure(text) {
    return { chars: text.length, tokens: estimateTokens(text) };
}

function pct(base, reduced) {
    return (((base - reduced) / base) * 100).toFixed(1) + "%";
}

function main() {
    console.log("=" .repeat(72));
    console.log("文言文协议 token 节省基准（同语义三格式对比）");
    console.log("=" .repeat(72));

    // ---- 1. 动作逐条 ----
    const totals = { xml: { c: 0, t: 0 }, json: { c: 0, t: 0 }, wenyan: { c: 0, t: 0 } };
    console.log("\n【一】单条动作（字符 / 估token）");
    console.log("场景".padEnd(14) + "XML".padEnd(16) + "JSON".padEnd(16) + "文言".padEnd(16) + "文言较XML省");
    console.log("-".repeat(72));
    for (const [name, xml, json, wenyan] of ACTIONS) {
        const x = measure(xml);
        const j = measure(json);
        const w = measure(wenyan);
        totals.xml.c += x.chars;
        totals.xml.t += x.tokens;
        totals.json.c += j.chars;
        totals.json.t += j.tokens;
        totals.wenyan.c += w.chars;
        totals.wenyan.t += w.tokens;
        const cell = (m) => `${m.chars}/${m.tokens}`.padEnd(16);
        console.log(
            name.padEnd(14) + cell(x) + cell(j) + cell(w) + pct(x.tokens, w.tokens)
        );
    }
    console.log("-".repeat(72));
    console.log(
        "合计".padEnd(14) +
            `${totals.xml.c}/${totals.xml.t}`.padEnd(16) +
            `${totals.json.c}/${totals.json.t}`.padEnd(16) +
            `${totals.wenyan.c}/${totals.wenyan.t}`.padEnd(16) +
            pct(totals.xml.t, totals.wenyan.t)
    );
    console.log(
        `动作合计：文言 vs XML 省 ${pct(totals.xml.t, totals.wenyan.t)} token，` +
            `vs JSON 省 ${pct(totals.json.t, totals.wenyan.t)} token`
    );

    // ---- 2. 系统提示词（每会话首轮发一次，输出侧动作每轮都发）----
    console.log("\n【二】系统/首轮提示词（每会话一次）");
    const sx = measure(XML_SYSTEM);
    const sj = measure(JSON_SYSTEM);
    const sw = measure(WENYAN_SYSTEM);
    console.log(`XML   ：${sx.chars} 字符 / ${sx.tokens} token`);
    console.log(`JSON  ：${sj.chars} 字符 / ${sj.tokens} token`);
    console.log(`文言  ：${sw.chars} 字符 / ${sw.tokens} token`);
    console.log(
        `文言较 XML 省 ${pct(sx.tokens, sw.tokens)} token，较 JSON 省 ${pct(sj.tokens, sw.tokens)} token`
    );

    // ---- 3. 每轮结果回贴：一轮任务里重复发送，累积影响比动作还大 ----
    const RESULT_OK = { ok: true, action: "read", path: "a.js", content: "const x = 1;\n" };
    const RESULT_ERR = { ok: false, action: "exec", error: "npm: command not found" };
    const runtimes = {
        xml: {
            ok: measure(XML_RUNTIME.getRuntimeOkPrompt(RESULT_OK)),
            err: measure(XML_RUNTIME.getRuntimeErrorPrompt(RESULT_ERR)),
        },
        json: {
            ok: measure(JSON_RUNTIME.getRuntimeOkPrompt(RESULT_OK)),
            err: measure(JSON_RUNTIME.getRuntimeErrorPrompt(RESULT_ERR)),
        },
        wenyan: {
            ok: measure(WENYAN_RUNTIME.getRuntimeOkPrompt(RESULT_OK)),
            err: measure(WENYAN_RUNTIME.getRuntimeErrorPrompt(RESULT_ERR)),
        },
    };
    console.log("\n【三】每轮结果回贴（成功 / 失败，字符/估token）");
    console.log("协议".padEnd(10) + "成功".padEnd(16) + "失败".padEnd(16) + "文言较XML省");
    console.log("-".repeat(72));
    for (const key of ["xml", "json", "wenyan"]) {
        const r = runtimes[key];
        const cell = (m) => `${m.chars}/${m.tokens}`.padEnd(16);
        console.log(
            key.padEnd(10) +
                cell(r.ok) +
                cell(r.err) +
                (key === "wenyan" ? pct(runtimes.xml.ok.tokens, r.ok.tokens) : "")
        );
    }

    // ---- 4. 一轮典型任务的累计口径：首轮系统提示词 + N 个动作 + N-1 次回贴 ----
    const STEPS = 10;
    const OK_RESULTS = 8;
    const ERR_RESULTS = 1;
    const systemTokens = { xml: sx.tokens, json: sj.tokens, wenyan: sw.tokens };
    const avgActionTokens = {
        xml: totals.xml.t / ACTIONS.length,
        json: totals.json.t / ACTIONS.length,
        wenyan: totals.wenyan.t / ACTIONS.length,
    };
    const cumulative = {};
    for (const key of ["xml", "json", "wenyan"]) {
        cumulative[key] = Math.ceil(
            systemTokens[key] +
                avgActionTokens[key] * STEPS +
                runtimes[key].ok.tokens * OK_RESULTS +
                runtimes[key].err.tokens * ERR_RESULTS
        );
    }
    console.log(`\n【四】一轮 ${STEPS} 步累计估算（首轮系统 + 动作 + ${OK_RESULTS} 成功回贴 + ${ERR_RESULTS} 失败回贴）`);
    for (const key of ["xml", "json", "wenyan"]) {
        console.log(`${key.padEnd(8)}：${cumulative[key]} token`);
    }
    console.log(
        `文言累计较 XML 省 ${pct(cumulative.xml, cumulative.wenyan)} token，` +
            `较 JSON 省 ${pct(cumulative.json, cumulative.wenyan)} token`
    );

    // ---- 5. 估算说明 ----
    console.log("\n【五】估算说明");
    console.log("- 输出侧（模型每轮给的动作）文言省得最多，因为去掉了标签/键名/引号骨架。");
    console.log("- 输入侧每轮结果回贴里的紧凑 JSON 是数据，三协议相同，会摊薄整体节省比例。");
    console.log("- 每轮回贴的协议措辞重复发送，累积口径下比首轮系统提示词更值得压。");
    console.log("\n" + "=".repeat(72));
}

main();
