/**
上下文预算估算的单元测试。

重点验证三件事：
1. token 折算口径（中文按字、英文按 4 字符）。
2. prompt 重建用的是真实模板 —— 断言直接拿 getRuntimeOkPrompt 的长度对比，
   而不是相信一个自己写死的数字。
3. 分级与降级：快满要报 warn/critical，被压缩过的旧会话要标 degraded。
*/

const assert = require("assert");
const contextBudget = require("../../webui/session/context-budget");
const { getRuntimeOkPrompt, getRuntimeErrorPrompt } = require("../../prompts/runtime-prompt");

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log("PASS " + name);
    } catch (error) {
        failed++;
        console.log("FAIL " + name);
        console.log("     " + error.message);
    }
}

// ---------------------------------------------------------------
// 1. token 折算
// ---------------------------------------------------------------

check("中文按 1 字 ≈ 1 token", () => {
    assert.strictEqual(contextBudget.estimateTokens("你好世界"), 4);
});

check("英文按 4 字符 ≈ 1 token", () => {
    assert.strictEqual(contextBudget.estimateTokens("abcd"), 1);
    assert.strictEqual(contextBudget.estimateTokens("abcdefgh"), 2);
});

check("中英混排分别计数后再向上取整", () => {
    // 1 个 ASCII（0.25）+ 1 个汉字（1）= 1.25 → 2
    assert.strictEqual(contextBudget.estimateTokens("a你"), 2);
});

check("空文本是 0，不是 NaN", () => {
    assert.strictEqual(contextBudget.estimateTokens(""), 0);
    assert.strictEqual(contextBudget.estimateTokens(null), 0);
});

check("全角标点按汉字计，避免低估中文句子", () => {
    assert.strictEqual(contextBudget.estimateTokens("，。"), 2);
});

// ---------------------------------------------------------------
// 2. 窗口大小归一化
// ---------------------------------------------------------------

check("未配置时默认 1M", () => {
    assert.strictEqual(contextBudget.normalizeLimit(undefined), contextBudget.DEFAULT_LIMIT);
    assert.strictEqual(contextBudget.DEFAULT_LIMIT, 1000000);
});

check("把比例误填成窗口大小时回退默认值", () => {
    // 有人会把 0.8 填进 limit，这种值当窗口没有意义
    assert.strictEqual(contextBudget.normalizeLimit(0.8), contextBudget.DEFAULT_LIMIT);
    assert.strictEqual(contextBudget.normalizeLimit(-5), contextBudget.DEFAULT_LIMIT);
});

check("字符串数字能用", () => {
    assert.strictEqual(contextBudget.normalizeLimit("200000"), 200000);
});

// ---------------------------------------------------------------
// 3. 从记录重建上下文
// ---------------------------------------------------------------

check("成功的一轮用 getRuntimeOkPrompt 重建，长度与真实模板一致", () => {
    const result = { ok: true, action: "read", path: "a.js", content: "x".repeat(100) };
    const output = [
        {
            type: "stdout",
            content: "Provider response received (50 chars)",
            event: { type: "provider.response", step: 1, length: 50 },
        },
        {
            type: "stdout",
            content: "Runtime action: read",
            event: { type: "runtime.result", step: 1, result },
        },
    ];
    const parts = contextBudget.collectParts(output);
    assert.strictEqual(parts.steps, 1);
    assert.strictEqual(parts.promptsChars, getRuntimeOkPrompt(result).length);
    assert.strictEqual(parts.repliesChars, 50);
    assert.strictEqual(parts.rebuilt, true);
});

check("失败的一轮用 getRuntimeErrorPrompt 重建", () => {
    const result = { ok: false, action: "read", error: "File or directory does not exist" };
    const output = [
        {
            type: "stdout",
            content: "Runtime action: read",
            event: { type: "runtime.result", step: 1, result },
        },
    ];
    const parts = contextBudget.collectParts(output);
    assert.strictEqual(parts.promptsChars, getRuntimeErrorPrompt(result).length);
});

check("没有 event 的记录只计入 recordsChars", () => {
    const output = [{ type: "stdout", content: "hello" }];
    const parts = contextBudget.collectParts(output);
    assert.strictEqual(parts.steps, 0);
    assert.strictEqual(parts.promptsChars, 0);
    assert.strictEqual(parts.recordsChars, 5);
    assert.strictEqual(parts.rebuilt, false);
});

check("collectParts 不修改传入的记录", () => {
    const output = [
        {
            type: "stdout",
            content: "Runtime action: read",
            event: { type: "runtime.result", step: 1, result: { ok: true, action: "read" } },
        },
    ];
    const snapshot = JSON.stringify(output);
    contextBudget.collectParts(output);
    assert.strictEqual(JSON.stringify(output), snapshot);
});

// ---------------------------------------------------------------
// 4. 分级
// ---------------------------------------------------------------

check("空会话只算首轮提示词，等级是 normal", () => {
    const usage = contextBudget.measure({ info: {}, output: [] });
    assert.ok(usage.used > 0, "首轮提示词本身也要算进占用");
    assert.strictEqual(usage.steps, 0);
    assert.strictEqual(usage.level, "normal");
    assert.strictEqual(usage.degraded, false);
    assert.ok(usage.ratio > 0 && usage.ratio < 0.01);
});

check("到 80% 报 warn", () => {
    // 首轮按 0.5 token/字符折算：160000 字符 → 80000 token / 100000 窗口 = 80%
    const usage = contextBudget.measure({
        info: {},
        output: [],
        firstPromptChars: 160000,
        limit: 100000,
    });
    assert.strictEqual(usage.ratio, 0.8);
    assert.strictEqual(usage.level, "warn");
});

check("到 92% 报 critical", () => {
    const usage = contextBudget.measure({
        info: {},
        output: [],
        firstPromptChars: 184000,
        limit: 100000,
    });
    assert.strictEqual(usage.ratio, 0.92);
    assert.strictEqual(usage.level, "critical");
});

check("超过窗口时 remaining 归零，不出现负数", () => {
    const usage = contextBudget.measure({
        info: {},
        output: [],
        firstPromptChars: 4000000,
        limit: 1000000,
    });
    assert.strictEqual(usage.remaining, 0);
    assert.strictEqual(usage.level, "critical");
});

check("阈值可以调，不必依赖默认 0.8", () => {
    const usage = contextBudget.measure({
        info: {},
        output: [],
        firstPromptChars: 100000,
        limit: 100000,
        warnRatio: 0.5,
    });
    // 100000 字符 → 50000 token / 100000 = 50%
    assert.strictEqual(usage.ratio, 0.5);
    assert.strictEqual(usage.level, "warn");
});

// ---------------------------------------------------------------
// 5. 降级与图片
// ---------------------------------------------------------------

check("event 被压缩掉的会话标 degraded，并用 content 当上下界", () => {
    const usage = contextBudget.measure({
        info: {},
        output: [{ type: "stdout", content: "x".repeat(1000) }],
    });
    assert.strictEqual(usage.degraded, true);
    assert.strictEqual(usage.chars.prompts, 1000);
    assert.ok(contextBudget.describe(usage).includes("估算"));
});

check("图片按张计入占用", () => {
    const withImages = contextBudget.measure({
        info: { images: ["a.png", "b.png"] },
        output: [],
        firstPromptChars: 1000,
    });
    const without = contextBudget.measure({
        info: {},
        output: [],
        firstPromptChars: 1000,
    });
    assert.strictEqual(withImages.used - without.used, contextBudget.IMAGE_TOKENS * 2);
    assert.strictEqual(withImages.images, 2);
});

check("同一份输入两次算出的结果完全一致", () => {
    const output = [
        {
            type: "stdout",
            content: "Runtime action: exec",
            event: { type: "runtime.result", step: 1, result: { ok: true, action: "exec" } },
        },
        {
            type: "stdout",
            content: "Provider response received (20 chars)",
            event: { type: "provider.response", step: 1, length: 20 },
        },
    ];
    const first = contextBudget.measure({ info: { task: "写第 3 章" }, output });
    const second = contextBudget.measure({ info: { task: "写第 3 章" }, output });
    assert.deepStrictEqual(first, second);
});

// ---------------------------------------------------------------
// 6. 真实模板的常量确实被算进去了
// ---------------------------------------------------------------

check("首轮提示词包含系统提示词，不会只算 task", () => {
    const short = contextBudget.firstPromptChars("a", { manifestChars: 0 });
    const long = contextBudget.firstPromptChars("a".repeat(500), { manifestChars: 0 });
    assert.strictEqual(long - short, 499);
    // 系统提示词本身是几千字，首轮不可能只有 task 那么长
    assert.ok(short > 1000, "首轮字符数应包含系统提示词，实际 " + short);
});

console.log("");
console.log("test-context-budget: " + passed + "/" + (passed + failed) + " PASS");
if (failed > 0) {
    process.exitCode = 1;
}
