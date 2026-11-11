/**
上下文预算：估算一个会话在 provider 那边已经占掉了多少上下文窗口。

为什么需要它：模型平台的上下文是有限窗口（现在主流 1M），满了以后平台
会自己截断早期内容，模型「突然忘事」，而本地完全没有提示。这个模块只做一件事：
把会话历史折算成一个 token 数量，让上层能在快满之前提醒用户转移记忆。

数据来源与精度
- 上下文 = 首轮提示词 + Σ(每轮发给模型的 prompt + 模型回复的文本)。
- 每轮 prompt 不是猜的：`runtime.result` 事件里存着该轮的完整 result，
  用它跑一遍真实的提示词模板（getRuntimeOkPrompt / getRuntimeErrorPrompt）
  就能还原当轮实际发送的文本，再直接对它数一遍 token。
- 模型回复只有长度（`provider.response.length`，当时没存正文），按经验比例折算。
- 唯一无法精确的是首轮提示词里的工作区清单（要扫盘才知道），按经验常量估；
  相对 1M 的窗口它是零头，需要精确时用 options.firstPromptChars 传进来。

降级：老会话如果被 memory-compress 压缩过，event 字段已被删掉，prompt 重建不了，
此时退回「用记录 content 之和当下界」，并在结果里标 degraded，让上层知道这是估算。

token 估算口径：CJK 按 1 字 ≈ 1 token，ASCII 按 4 字符 ≈ 1 token，其他按 2 字符。
对中文这是偏高估的（实际约 1.5 字/token），偏高估意味着「早一点预警」，
在预算提醒这个场景里保守是安全的。

性能：一次线性遍历，不拼接大字符串、不保留历史文本，只累加数字。
2000 条记录的会话在几十毫秒内算完，可以在每步结束后调用。
*/

const { getSystemPrompt } = require("../../prompts/index.js");
const { getRuntimeOkPrompt, getRuntimeErrorPrompt } = require("../../prompts/runtime-prompt.js");

/** 默认上下文窗口：1M。可用环境变量 XML_AGENT_CONTEXT_LIMIT 覆盖。 */
const DEFAULT_LIMIT = 1000000;
/** 超过这个比例开始提醒转移。 */
const DEFAULT_WARN_RATIO = 0.8;
/** 超过这个比例视为「随时会截断」，横幅要变红。 */
const DEFAULT_CRITICAL_RATIO = 0.92;
/** 首轮提示词里工作区清单的字符数经验值（清单本身有 1200 条目上限）。 */
const DEFAULT_MANIFEST_CHARS = 8000;
/** 一张图片进上下文的大致 token 数（各平台不同，取常见量级）。 */
const IMAGE_TOKENS = 1200;
/**
模型回复的 token/字符比：回复是 XML 动作，标签和代码占比高，
比纯中文稀，取 0.45（比纯英文的 0.25 保守，宁可高估）。
*/
const REPLY_TOKENS_PER_CHAR = 0.45;
/** 首轮提示词：系统提示词以中文说明为主，但夹着大量 XML 示例。 */
const FIRST_PROMPT_TOKENS_PER_CHAR = 0.5;
/** 降级估算：记录 content 多为中文渲染文案。 */
const DEGRADED_TOKENS_PER_CHAR = 0.5;

const LEVELS = ["normal", "warn", "critical"];

let cachedSystemPromptChars = 0;

/** 系统提示词是常量，长度算一次就够。 */
function systemPromptChars() {
    if (!cachedSystemPromptChars) {
        try {
            cachedSystemPromptChars = String(getSystemPrompt() || "").length;
        } catch (error) {
            // 模板加载失败不该让预警功能整体挂掉，退一个量级正确的常量
            cachedSystemPromptChars = 8000;
        }
    }
    return cachedSystemPromptChars;
}

function isCJK(code) {
    return (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        // 中文全角标点：逗号句号引号这些都按汉字计，避免低估
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff00 && code <= 0xffef)
    );
}

/**
把一段文本折算成 token 数。
逐字符分类而不是按正则切分：混合文本（中英夹杂的代码注释）按正则容易两头都算错。
*/
function estimateTokens(text) {
    const source = typeof text === "string" ? text : String(text || "");
    let cjk = 0;
    let ascii = 0;
    let other = 0;
    for (const char of source) {
        const code = char.codePointAt(0);
        if (code < 0x80) {
            ascii++;
        } else if (isCJK(code)) {
            cjk++;
        } else {
            other++;
        }
    }
    return Math.ceil(cjk + ascii / 4 + other / 2);
}

function toRatio(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        return fallback;
    }
    return number;
}

function normalizeLimit(value) {
    const number = Number(value);
    // 小于 1000 的一律当成误传（有人会把比例填进来）；上限不设，窗口可能更大
    return Number.isFinite(number) && number >= 1000 ? Math.trunc(number) : DEFAULT_LIMIT;
}

/**
逐条记录还原上下文构成。

返回 { promptsChars, promptsTokens, repliesChars, repliesTokens, steps, rebuilt, recordsChars }
- rebuilt=false 表示根本没找到 runtime.result 事件（被压缩过），调用方要降级
*/
function collectParts(output) {
    const list = Array.isArray(output) ? output : [];
    let promptsChars = 0;
    let promptsTokens = 0;
    let repliesChars = 0;
    let repliesTokens = 0;
    let steps = 0;
    let recordsChars = 0;

    for (const record of list) {
        const content = String((record && record.content) || "");
        recordsChars += content.length;
        const event = record && record.event;
        if (!event || typeof event !== "object") {
            continue;
        }
        if (event.type === "runtime.result" && event.result) {
            // 用真实模板重放，与当时发给模型的文本一致
            // （promptView 的精简逻辑在模板内部处理）
            const result = event.result;
            const prompt =
                result.ok === false ? getRuntimeErrorPrompt(result) : getRuntimeOkPrompt(result);
            promptsChars += prompt.length;
            promptsTokens += estimateTokens(prompt);
            steps++;
        } else if (event.type === "provider.response") {
            const length = Number(event.length) || 0;
            repliesChars += length;
            repliesTokens += Math.ceil(length * REPLY_TOKENS_PER_CHAR);
        }
    }

    return {
        promptsChars,
        promptsTokens,
        repliesChars,
        repliesTokens,
        steps,
        rebuilt: steps > 0,
        recordsChars,
    };
}

/**
首轮提示词字符数：系统提示词（精确）+ 任务 + 清单（估算）。

清单要扫工作区才能精确，这里给经验值即可：相对 1M 窗口它是零头，
而扫盘会阻塞事件循环——为一个 3% 的精度同步读几千个文件不划算。
*/
function firstPromptChars(task, options = {}) {
    const manifestChars =
        Number(options.manifestChars) > 0 ? Number(options.manifestChars) : DEFAULT_MANIFEST_CHARS;
    return systemPromptChars() + String(task || "").length + manifestChars;
}

function levelOf(ratio, warnRatio, criticalRatio) {
    if (ratio >= criticalRatio) {
        return "critical";
    }
    if (ratio >= warnRatio) {
        return "warn";
    }
    return "normal";
}

/**
估算会话的上下文占用。

参数：
    info / output   会话元信息与记录（AgentSession 上的字段）
    limit           窗口大小，默认 1M
    warnRatio       提醒阈值，默认 0.8
    criticalRatio   危险阈值，默认 0.92
    manifestChars   首轮清单字符数（覆盖经验值）
    firstPromptChars 直接指定首轮提示词字符数（最精确，调用方算得出时传）
    images          随任务附带的图片数量（info.images 优先）

返回：
    {
      limit, used, ratio, remaining, level,
      chars: { firstPrompt, prompts, replies, total },
      steps, images, degraded, warnRatio, criticalRatio
    }
*/
function measure(options = {}) {
    const info = options.info || {};
    const output = options.output || [];
    const limit = normalizeLimit(options.limit);
    const warnRatio = toRatio(options.warnRatio, DEFAULT_WARN_RATIO);
    const criticalRatio = toRatio(options.criticalRatio, DEFAULT_CRITICAL_RATIO);

    const parts = collectParts(output);
    // event 被压缩掉的会话：prompt 重建不了，用记录 content 当上下文的下界
    const degraded = !parts.rebuilt && parts.recordsChars > 0;

    const firstChars =
        Number(options.firstPromptChars) > 0
            ? Number(options.firstPromptChars)
            : firstPromptChars(info.task, options);
    const firstTokens = Math.ceil(firstChars * FIRST_PROMPT_TOKENS_PER_CHAR);

    const promptsChars = degraded ? parts.recordsChars : parts.promptsChars;
    const promptsTokens = degraded
        ? Math.ceil(parts.recordsChars * DEGRADED_TOKENS_PER_CHAR)
        : parts.promptsTokens;
    // 压缩过 event 的会话，provider.response 也一起没了，回复部分无从统计
    const repliesChars = degraded ? 0 : parts.repliesChars;
    const repliesTokens = degraded ? 0 : parts.repliesTokens;

    const imageCount = Array.isArray(info.images)
        ? info.images.length
        : Array.isArray(options.images)
          ? options.images.length
          : 0;

    const used = firstTokens + promptsTokens + repliesTokens + imageCount * IMAGE_TOKENS;
    const ratio = limit > 0 ? used / limit : 0;

    return {
        limit,
        used,
        ratio: Number(ratio.toFixed(4)),
        remaining: Math.max(0, limit - used),
        level: levelOf(ratio, warnRatio, criticalRatio),
        chars: {
            firstPrompt: firstChars,
            prompts: promptsChars,
            replies: repliesChars,
            total: firstChars + promptsChars + repliesChars,
        },
        steps: parts.steps,
        images: imageCount,
        degraded,
        warnRatio,
        criticalRatio,
    };
}

/** 给日志 / 控制台用的一句话。 */
function describe(usage) {
    if (!usage) {
        return "";
    }
    if (usage.degraded) {
        return "上下文约 " + Math.round(usage.ratio * 100) + "%（估算）";
    }
    return "上下文 " + Math.round(usage.ratio * 100) + "%";
}

module.exports = {
    DEFAULT_LIMIT,
    DEFAULT_WARN_RATIO,
    DEFAULT_CRITICAL_RATIO,
    DEFAULT_MANIFEST_CHARS,
    IMAGE_TOKENS,
    LEVELS,
    estimateTokens,
    normalizeLimit,
    collectParts,
    firstPromptChars,
    measure,
    describe,
};
