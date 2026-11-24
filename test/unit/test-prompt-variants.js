/**
 * 提示词措辞变体的协议约束单测
 *
 * 变体只是改写散文措辞，XML 动作语法、紧凑 JSON 结果、结束动作这些协议部分
 * 必须与原文基准逐字一致，否则模型会学错语法、回贴会解析失败。这套测试守：
 * 1. 每套首消息变体都保留全部 XML 示例，且示例可解析；
 * 2. 每套变体都不含宿主特征、长度受限、措辞确实彼此不同；
 * 3. 每套回贴变体都保留紧凑 JSON 与可解析的 <answer>/<done/>，且长度受限；
 * 4. 索引 0 / 未提供索引时输出原文基准（指纹测试与旧调用方依赖这一点）；
 * 5. 每张重写的原文行都能在 SYSTEM_PROMPT 里精确命中（正文改动后变体不会静默退化）。
 * 6. 补发类提示词（发送失败 / 格式错误）不含 Agent、Runtime、XML Action 等宿主术语，
 *    不泄漏 Playwright 原始报错，同时保留"不假设成功 / 不编结果 / 一次一个动作"约束。
 *
 * 运行：node test/unit/test-prompt-variants.js
 */

const assert = require("assert");
const { SYSTEM_PROMPT } = require("../../prompts/system-prompt");
const {
    getSystemPromptVariant,
    pickSystemPromptVariant,
    getVariantMismatches,
    SYSTEM_PROMPT_VARIANT_COUNT,
} = require("../../prompts/system-prompt-variants");
const { getFirstPrompt } = require("../../prompts/first-prompt");
const {
    getRuntimeOkPrompt,
    getRuntimeErrorPrompt,
    RUNTIME_PROMPT_VARIANT_COUNT,
} = require("../../prompts/runtime-prompt");
const { extractXML } = require("../../parse/xml-parse");
const {
    getSendErrorPrompt,
    humanReason,
    SEND_ERROR_VARIANT_COUNT,
} = require("../../prompts/send-error-prompt");
const {
    getXmlErrorPrompt,
    describeParseError,
    XML_ERROR_VARIANT_COUNT,
} = require("../../prompts/xml-error-prompt");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
        console.log("PASS - " + name);
    } else {
        console.log("FAIL - " + name + (detail ? "  [" + detail + "]" : ""));
    }
}

function parseSafely(snippet) {
    try {
        return { action: extractXML(snippet), error: null };
    } catch (error) {
        return { action: null, error: error.message };
    }
}

/** 从文本里抽出整行就是一个完整动作的行。 */
function singleLineActions(text) {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^<(read|write|edit|exec|screenshot|answer|done)\b/.test(line))
        .filter((line) => line.endsWith("/>") || /<\/[a-z]+>$/.test(line));
}

function main() {
    console.log("=== 1. 首消息变体：索引 0 / 默认值是原文基准 ===");
    check("索引 0 返回原文", getSystemPromptVariant(0) === SYSTEM_PROMPT);
    check("负索引退回原文", getSystemPromptVariant(-1) === SYSTEM_PROMPT);
    check("越界索引退回原文", getSystemPromptVariant(9999) === SYSTEM_PROMPT);
    check("非整数索引退回原文", getSystemPromptVariant("1") === SYSTEM_PROMPT);
    check(
        "变体数量 >= 2",
        SYSTEM_PROMPT_VARIANT_COUNT >= 2,
        "count=" + SYSTEM_PROMPT_VARIANT_COUNT
    );
    const first0 = getFirstPrompt("D:/tmp/ws", ["a.js"], "任务", { systemPromptVariant: 0 });
    const firstDefault = getFirstPrompt("D:/tmp/ws", ["a.js"], "任务");
    check("首轮提示词显式 0 与默认逐字一致", first0 === firstDefault);
    check("首轮提示词仍以原文系统提示词开头", firstDefault.startsWith("\n" + SYSTEM_PROMPT));

    console.log("\n=== 2. 首消息变体：协议结构与可解析性 ===");
    const baselineActions = singleLineActions(SYSTEM_PROMPT);
    check("基准里找到单行示例", baselineActions.length >= 5, "count=" + baselineActions.length);
    const seenTexts = new Set([SYSTEM_PROMPT]);
    const hostSignals = [
        "D:\\",
        "C:\\",
        "remote-debugging",
        "CDP",
        "Node.js Runtime",
        "127.0.0.1",
        "localhost",
    ];
    for (let index = 1; index < SYSTEM_PROMPT_VARIANT_COUNT; index += 1) {
        const text = getSystemPromptVariant(index);

        check("变体 " + index + " 与原文措辞不同", text !== SYSTEM_PROMPT);
        check("变体 " + index + " 与更早的变体不同", !seenTexts.has(text));
        seenTexts.add(text);

        for (const signal of hostSignals) {
            check("变体 " + index + " 不含宿主特征：" + signal, text.indexOf(signal) === -1);
        }
        check("变体 " + index + " 长度 < 2000", text.length < 2000, "len=" + text.length);
        check("变体 " + index + " 不以角色设定开头", text.trimStart().indexOf("你是一个") !== 0);

        const actions = singleLineActions(text);
        check(
            "变体 " + index + " 保留全部单行示例",
            actions.length === baselineActions.length &&
                baselineActions.every((line) => actions.indexOf(line) !== -1),
            "count=" + actions.length
        );
        for (const line of actions) {
            const { action, error } = parseSafely(line);
            check(
                "变体 " + index + " 示例可解析：" + line.slice(0, 32),
                Boolean(action),
                error || "null"
            );
        }
        check(
            "变体 " + index + " 保留结构锚点：动作可以这样写",
            text.indexOf("动作可以这样写") !== -1
        );
        // Workspace Manifest / 用户任务 是 first-prompt.js 追加的段，在变体之外；
        // 用拼装后的首轮提示词验证它们仍随变体一起输出。
        const firstWithVariant = getFirstPrompt("D:/tmp/ws", ["a.js"], "任务", {
            systemPromptVariant: index,
        });
        check(
            "变体 " + index + " 首轮提示词保留 Workspace Manifest",
            firstWithVariant.indexOf("Workspace Manifest") !== -1 &&
                firstWithVariant.indexOf("用户任务") !== -1
        );
    }

    console.log("\n=== 3. 抽签落在合法范围 ===");
    for (let i = 0; i < 200; i += 1) {
        const index = pickSystemPromptVariant();
        if (!Number.isInteger(index) || index < 0 || index >= SYSTEM_PROMPT_VARIANT_COUNT) {
            check("抽签结果合法（第 " + i + " 次）", false, String(index));
            break;
        }
        if (i === 199) {
            check("抽签结果 200 次都落在合法范围", true);
        }
    }

    console.log("\n=== 4. 回贴变体：默认与索引 0 是原文基准 ===");
    const small = { ok: true, action: "read", path: "a.js", content: "hello" };
    check(
        "成功回贴 索引 0 与默认逐字一致",
        getRuntimeOkPrompt(small, { variant: 0 }) === getRuntimeOkPrompt(small)
    );
    check(
        "失败回贴 索引 0 与默认逐字一致",
        getRuntimeErrorPrompt({ ok: false }, { variant: 0 }) ===
            getRuntimeErrorPrompt({ ok: false })
    );
    check(
        "回贴变体数量 >= 2",
        RUNTIME_PROMPT_VARIANT_COUNT >= 2,
        "count=" + RUNTIME_PROMPT_VARIANT_COUNT
    );

    console.log("\n=== 5. 回贴变体：JSON / 结束动作 / 长度 ===");
    for (let index = 0; index < RUNTIME_PROMPT_VARIANT_COUNT; index += 1) {
        const okPrompt = getRuntimeOkPrompt(small, { variant: index });
        const errPrompt = getRuntimeErrorPrompt(
            { ok: false, action: "exec", error: "boom" },
            { variant: index }
        );

        check("成功回贴 " + index + " 含紧凑 JSON", okPrompt.indexOf('{"ok":true') !== -1);
        check("失败回贴 " + index + " 含紧凑 JSON", errPrompt.indexOf('{"ok":false') !== -1);
        check("成功回贴 " + index + " 长度 < 600", okPrompt.length < 600, "len=" + okPrompt.length);
        check(
            "失败回贴 " + index + " 长度 < 400",
            errPrompt.length < 400,
            "len=" + errPrompt.length
        );

        for (const [label, prompt] of [
            ["成功", okPrompt],
            ["失败", errPrompt],
        ]) {
            const snippets = prompt.match(/<answer>[\s\S]*?<\/answer>|<done\/>/g) || [];
            check(
                label + "回贴 " + index + " 至少一个结束动作",
                snippets.length >= 1,
                "count=" + snippets.length
            );
            for (const snippet of snippets) {
                const { action, error } = parseSafely(snippet);
                check(
                    label + "回贴 " + index + " 结束动作可解析",
                    Boolean(action),
                    error || "null"
                );
            }
        }

        const big = { ok: true, action: "fetch", body: "x".repeat(20000) };
        const bigPrompt = getRuntimeOkPrompt(big, { variant: index });
        check(
            "成功回贴 " + index + " 超长截断",
            bigPrompt.length < 6000 && bigPrompt.indexOf("truncated") !== -1
        );
        const many = { ok: true, action: "read", entries: new Array(1000).fill("f.js") };
        check(
            "成功回贴 " + index + " 超长数组截断",
            getRuntimeOkPrompt(many, { variant: index }).indexOf("1000 items in total") !== -1
        );
    }

    // 5. 变体映射的 key 必须全部命中原文行：正文若被改动而忘了同步映射表，
    //    失配的那行会静默退回原文、变体悄悄退化，这里把它变成明确的红灯。
    const mismatches = getVariantMismatches();
    check(
        "所有变体重写的原文行都精确命中 SYSTEM_PROMPT",
        mismatches.length === 0,
        mismatches
            .slice(0, 3)
            .map((m) => "v" + m.variant + ":" + JSON.stringify(m.key.slice(0, 30)))
            .join(", ")
    );

    console.log("\n=== 6. 发送失败 / 格式错误提示词：无宿主术语 + 四套变体 ===");
    // 这两段是"补发"文本：发送失败时模型连消息都没收到、解析失败时模型刚绕过格式。
    // 旧版把 `Agent 调用模型`、`Runtime`、`XML Action` 和 Playwright 原始报错直接写进
    // prompt，等于自报"这是自动化框架"，且逐字节重复。这里守住三条：
    // 不含宿主术语、原文报错不泄漏、协议约束（不假设成功 / 不编结果 / 一次一个动作）仍在。
    const HOST_WORDS = [
        "Agent",
        "Runtime",
        "XML Action",
        "调用模型",
        "Playwright",
        "remote-debugging",
    ];
    const sendErr = Object.assign(
        new Error("Provider failed 3 consecutive times: page.goto: Timeout 30000ms exceeded"),
        { code: "EMPTY_RESPONSE" }
    );
    const xmlErr = new Error("Unknown XML Action: foo");

    check(
        "EMPTY_RESPONSE 归类为回复为空",
        humanReason(sendErr).indexOf("空") !== -1,
        humanReason(sendErr)
    );
    check(
        "输入框未清空归类为没发出去",
        humanReason(new Error("input box was not cleared")).indexOf("没发出去") !== -1
    );
    check(
        "超时归类为连接超时",
        humanReason(new Error("page.goto: Timeout 30000ms exceeded")).indexOf("超时") !== -1
    );
    check(
        "解析错误不泄漏 XML Action 术语",
        describeParseError(xmlErr).indexOf("XML Action") === -1,
        describeParseError(xmlErr)
    );
    check("解析错误保留误写的动作名", describeParseError(xmlErr).indexOf("foo") !== -1);
    check(
        "参数类错误原样保留",
        describeParseError(new Error("path is required")) === "path is required"
    );

    check("发送失败变体数量 >= 2", SEND_ERROR_VARIANT_COUNT >= 2);
    check("格式错误变体数量 >= 2", XML_ERROR_VARIANT_COUNT >= 2);
    check(
        "发送失败默认与索引 0 一致",
        getSendErrorPrompt(sendErr) === getSendErrorPrompt(sendErr, { variant: 0 })
    );
    check(
        "格式错误默认与索引 0 一致",
        getXmlErrorPrompt(xmlErr) === getXmlErrorPrompt(xmlErr, { variant: 0 })
    );
    check(
        "发送失败非法索引退回 0",
        getSendErrorPrompt(sendErr, { variant: 99 }) === getSendErrorPrompt(sendErr, { variant: 0 })
    );
    check(
        "格式错误非法索引退回 0",
        getXmlErrorPrompt(xmlErr, { variant: -3 }) === getXmlErrorPrompt(xmlErr, { variant: 0 })
    );

    const sendSeen = new Set();
    for (let index = 0; index < SEND_ERROR_VARIANT_COUNT; index += 1) {
        const text = getSendErrorPrompt(sendErr, { variant: index });
        check("发送失败 " + index + " 与更早变体不同", !sendSeen.has(text));
        sendSeen.add(text);
        check("发送失败 " + index + " 长度 < 200", text.length < 200, "len=" + text.length);
        for (const word of HOST_WORDS) {
            check("发送失败 " + index + " 不含宿主术语：" + word, text.indexOf(word) === -1);
        }
        check(
            "发送失败 " + index + " 声明上一步不算数",
            /不算数|等于没做|当作没发生|当作没做/.test(text)
        );
        check("发送失败 " + index + " 禁止编造结果", /编.{0,6}结果|虚构.{0,6}结果/.test(text));
        check("发送失败 " + index + " 要求再给一段动作", text.indexOf("动作") !== -1);
    }

    const xmlSeen = new Set();
    for (let index = 0; index < XML_ERROR_VARIANT_COUNT; index += 1) {
        const text = getXmlErrorPrompt(xmlErr, { variant: index });
        check("格式错误 " + index + " 与更早变体不同", !xmlSeen.has(text));
        xmlSeen.add(text);
        check("格式错误 " + index + " 长度 < 200", text.length < 200, "len=" + text.length);
        for (const word of HOST_WORDS) {
            check("格式错误 " + index + " 不含宿主术语：" + word, text.indexOf(word) === -1);
        }
        check(
            "格式错误 " + index + " 要求一次只给一个动作",
            /一个动作|一次一个|一轮只给一个|仅输出一个/.test(text)
        );
        const examples = text.match(/<[a-zA-Z-]+[^>]*\/>/g) || [];
        check(
            "格式错误 " + index + " 至少一个可解析示例",
            examples.length >= 1 &&
                examples.every((snippet) => {
                    try {
                        extractXML(snippet);
                        return true;
                    } catch (error) {
                        return false;
                    }
                }),
            "count=" + examples.length
        );
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);
    if (pass !== total) {
        process.exit(1);
    }
}

main();
