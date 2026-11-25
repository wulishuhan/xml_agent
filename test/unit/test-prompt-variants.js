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
const { extractAction } = require("../../parse/json-action");
const { findJsonObjects } = require("../../parse/json-candidate");
const {
    getSendErrorPrompt,
    humanReason,
    SEND_ERROR_VARIANT_COUNT,
} = require("../../prompts/send-error-prompt");
const {
    getJsonErrorPrompt,
    describeParseError,
    JSON_ERROR_VARIANT_COUNT,
} = require("../../prompts/json-error-prompt");

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
        return { action: extractAction(snippet), error: null };
    } catch (error) {
        return { action: null, error: error.message };
    }
}

function actionObjects(text) {
    const actions = [];
    for (const candidate of findJsonObjects(text)) {
        try {
            const value = JSON.parse(candidate);
            if (
                value &&
                typeof value.action === "string" &&
                value.params &&
                typeof value.params === "object"
            ) {
                actions.push(value);
            }
        } catch (error) {
            // 普通 JSON 结果不是动作信封。
        }
    }
    return actions;
}

function singleLineActions(text) {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{"action":') && line.endsWith("}"));
}

function main() {
    console.log("=== 1. 首消息变体：索引 0 / 默认值是原文基准 ===");
    check("索引 0 返回原文", getSystemPromptVariant(0) === SYSTEM_PROMPT);
    check("负索引退回原文", getSystemPromptVariant(-1) === SYSTEM_PROMPT);
    check("越界退回原文", getSystemPromptVariant(9999) === SYSTEM_PROMPT);
    check("非整数退回原文", getSystemPromptVariant("1") === SYSTEM_PROMPT);
    check(
        "变体数量 >= 2",
        SYSTEM_PROMPT_VARIANT_COUNT >= 2,
        "count=" + SYSTEM_PROMPT_VARIANT_COUNT
    );
    const first0 = getFirstPrompt("D:/tmp/ws", "任务", { systemPromptVariant: 0 });
    const firstDefault = getFirstPrompt("D:/tmp/ws", "任务");
    check("首轮提示词显式 0 与默认逐字一致", first0 === firstDefault);
    check("首轮提示词以原文系统提示词开头", firstDefault.startsWith(SYSTEM_PROMPT));

    console.log("\n=== 2. 首消息变体：协议结构与可解析性 ===");
    const baselineActions = singleLineActions(SYSTEM_PROMPT);
    check("基准里找到单行示例", baselineActions.length >= 7, "count=" + baselineActions.length);
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
        check("变体 " + index + " 与更早变体不同", !seenTexts.has(text));
        seenTexts.add(text);
        for (const signal of hostSignals) {
            check("变体 " + index + " 不含宿主特征：" + signal, text.indexOf(signal) === -1);
        }
        check("变体 " + index + " 长度 < 5000", text.length < 5000, "len=" + text.length);
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
                "变体 " + index + " 示例可解析：" + JSON.parse(line).action,
                Boolean(action),
                error || "null"
            );
        }
        check("变体 " + index + " 保留 JSON Schema", text.indexOf('"$defs"') !== -1);
        const firstWithVariant = getFirstPrompt("D:/tmp/ws", "任务", {
            systemPromptVariant: index,
        });
        check(
            "变体 " + index + " 首轮保留项目与用户任务",
            firstWithVariant.indexOf("项目：ws") !== -1 &&
                firstWithVariant.indexOf("用户任务") !== -1 &&
                firstWithVariant.indexOf("Workspace Manifest") === -1
        );
    }

    console.log("\n=== 3. 抽签落在合法范围 ===");
    let valid = true;
    for (let i = 0; i < 200; i += 1) {
        const index = pickSystemPromptVariant();
        if (!Number.isInteger(index) || index < 0 || index >= SYSTEM_PROMPT_VARIANT_COUNT) {
            valid = false;
            break;
        }
    }
    check("抽签 200 次都落在合法范围", valid);

    console.log("\n=== 4. 回贴变体：默认与索引 0 是原文基准 ===");
    const small = { ok: true, action: "read", path: "a.js", content: "hello" };
    check(
        "成功回贴 0 与默认一致",
        getRuntimeOkPrompt(small, { variant: 0 }) === getRuntimeOkPrompt(small)
    );
    check(
        "失败回贴 0 与默认一致",
        getRuntimeErrorPrompt({ ok: false }, { variant: 0 }) ===
            getRuntimeErrorPrompt({ ok: false })
    );
    check("回贴变体数量 >= 2", RUNTIME_PROMPT_VARIANT_COUNT >= 2);

    console.log("\n=== 5. 回贴变体：JSON / 结束动作 / 长度 ===");
    for (let index = 0; index < RUNTIME_PROMPT_VARIANT_COUNT; index += 1) {
        const okPrompt = getRuntimeOkPrompt(small, { variant: index });
        const errPrompt = getRuntimeErrorPrompt(
            { ok: false, action: "exec", error: "boom" },
            { variant: index }
        );
        check("成功回贴 " + index + " 含紧凑 JSON", okPrompt.indexOf('{"ok":true') !== -1);
        check("失败回贴 " + index + " 含紧凑 JSON", errPrompt.indexOf('{"ok":false') !== -1);
        const partialRead = {
            ok: true,
            action: "read",
            path: ".agent/skills/novel-writing/SKILL.md",
            content: "x".repeat(4000),
            truncated: true,
            nextOffset: 4000,
            limit: 4000,
        };
        const readPrompt = getRuntimeOkPrompt(partialRead, { variant: index });
        check(
            "成功回贴 " + index + " 要求继续读完 read",
            readPrompt.includes("文件尚未读完") && readPrompt.includes('"offset":4000')
        );
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
            const snippets = actionObjects(prompt);
            check(
                label + "回贴 " + index + " 至少一个动作示例",
                snippets.length >= 1,
                "count=" + snippets.length
            );
            for (const snippet of snippets) {
                const { action, error } = parseSafely(JSON.stringify(snippet));
                check(
                    label + "回贴 " + index + " 动作可解析：" + snippet.action,
                    Boolean(action),
                    error || "null"
                );
            }
        }
        const big = { ok: true, action: "fetch", body: "x".repeat(20000) };
        check(
            "成功回贴 " + index + " 超长截断",
            getRuntimeOkPrompt(big, { variant: index }).length < 6000 &&
                getRuntimeOkPrompt(big, { variant: index }).indexOf("truncated") !== -1
        );
        const many = { ok: true, action: "read", entries: new Array(1000).fill("f.js") };
        check(
            "成功回贴 " + index + " 超长数组截断",
            getRuntimeOkPrompt(many, { variant: index }).indexOf("1000 items in total") !== -1
        );
    }

    const mismatches = getVariantMismatches();
    check(
        "所有变体重写的原文行都精确命中 SYSTEM_PROMPT",
        mismatches.length === 0,
        mismatches.map((m) => m.key).join(" | ")
    );

    console.log("\n=== 6. 发送失败 / 格式错误提示词 ===");
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
    const jsonErr = new Error("Unknown action: foo");
    check("EMPTY_RESPONSE 归类为回复为空", humanReason(sendErr).indexOf("空") !== -1);
    check(
        "输入框未清空归类为没发出去",
        humanReason(new Error("input box was not cleared")).indexOf("没发出去") !== -1
    );
    check(
        "超时归类为连接超时",
        humanReason(new Error("page.goto: Timeout 30000ms exceeded")).indexOf("超时") !== -1
    );
    check("解析错误保留误写的动作名", describeParseError(jsonErr).indexOf("foo") !== -1);
    check(
        "参数类错误原样保留",
        describeParseError(new Error("path is required")) === "path is required"
    );
    check("发送失败变体数量 >= 2", SEND_ERROR_VARIANT_COUNT >= 2);
    check("格式错误变体数量 >= 2", JSON_ERROR_VARIANT_COUNT >= 2);
    check(
        "发送失败默认与 0 一致",
        getSendErrorPrompt(sendErr) === getSendErrorPrompt(sendErr, { variant: 0 })
    );
    check(
        "格式错误默认与 0 一致",
        getJsonErrorPrompt(jsonErr) === getJsonErrorPrompt(jsonErr, { variant: 0 })
    );
    check(
        "发送失败非法索引退回 0",
        getSendErrorPrompt(sendErr, { variant: 99 }) === getSendErrorPrompt(sendErr, { variant: 0 })
    );
    check(
        "格式错误非法索引退回 0",
        getJsonErrorPrompt(jsonErr, { variant: -3 }) === getJsonErrorPrompt(jsonErr, { variant: 0 })
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
        check("发送失败 " + index + " 要求 JSON 动作", text.indexOf("JSON 动作对象") !== -1);
    }

    const jsonSeen = new Set();
    for (let index = 0; index < JSON_ERROR_VARIANT_COUNT; index += 1) {
        const text = getJsonErrorPrompt(jsonErr, { variant: index });
        check("格式错误 " + index + " 与更早变体不同", !jsonSeen.has(text));
        jsonSeen.add(text);
        check("格式错误 " + index + " 长度 < 200", text.length < 200, "len=" + text.length);
        for (const word of HOST_WORDS) {
            check("格式错误 " + index + " 不含宿主术语：" + word, text.indexOf(word) === -1);
        }
        check(
            "格式错误 " + index + " 要求一次只给一个动作",
            /一个 JSON 动作|一个动作|一次一个|一轮只给一个|仅输出一个/.test(text)
        );
        const examples = actionObjects(text);
        check(
            "格式错误 " + index + " 至少一个可解析示例",
            examples.length >= 1 &&
                examples.every((snippet) => Boolean(parseSafely(JSON.stringify(snippet)).action)),
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
