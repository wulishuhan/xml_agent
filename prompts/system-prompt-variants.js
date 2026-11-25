const { SYSTEM_PROMPT } = require("./system-prompt");

const REWRITES = [
    {},
    {
        "请协助完成本机项目任务。每轮只输出一个 JSON 动作对象，不要输出 XML、解释文字或多个动作。":
            "请一起处理这个本机项目。每次只返回一个 JSON 动作对象，不要 XML、解释或多个动作。",
        "规矩：": "约定：",
        "通常第一步先用 read 读取项目根目录，再按真实内容推进。":
            "一般先用 read 查看项目根目录，再根据实际内容继续。",
    },
    {
        "请协助完成本机项目任务。每轮只输出一个 JSON 动作对象，不要输出 XML、解释文字或多个动作。":
            "本机项目需要你协助完成。每轮仅给一个 JSON 动作对象，避免 XML、说明文字和并列动作。",
        "规矩：": "协作规则：",
        "通常第一步先用 read 读取项目根目录，再按真实内容推进。":
            "通常先以 read 列出项目根目录，然后依照真实内容逐步推进。",
    },
    {
        "请协助完成本机项目任务。每轮只输出一个 JSON 动作对象，不要输出 XML、解释文字或多个动作。":
            "请协助推进本机项目，一次只回一个 JSON 动作对象，不带 XML、解释或多个动作。",
        "规矩：": "注意事项：",
        "通常第一步先用 read 读取项目根目录，再按真实内容推进。":
            "第一步通常用 read 看项目根目录，之后按实际情况继续。",
    },
];

const SYSTEM_PROMPT_VARIANT_COUNT = REWRITES.length;

function getSystemPromptVariant(index) {
    const resolved = Number.isInteger(index) && index >= 0 && index < REWRITES.length ? index : 0;
    if (resolved === 0) {
        return SYSTEM_PROMPT;
    }
    const rewrite = REWRITES[resolved];
    return SYSTEM_PROMPT.split("\n")
        .map((line) => (Object.prototype.hasOwnProperty.call(rewrite, line) ? rewrite[line] : line))
        .join("\n");
}

function pickSystemPromptVariant() {
    return Math.floor(Math.random() * REWRITES.length);
}

function getVariantMismatches() {
    const lines = new Set(SYSTEM_PROMPT.split("\n"));
    const mismatches = [];
    REWRITES.forEach((rewrite, index) => {
        Object.keys(rewrite).forEach((key) => {
            if (!lines.has(key)) {
                mismatches.push({ variant: index, key });
            }
        });
    });
    return mismatches;
}

const initialMismatches = getVariantMismatches();
if (initialMismatches.length) {
    console.warn(
        "[prompt-variants] " +
            initialMismatches.length +
            " 条重写的原文行已失配，对应变体会静默退化：" +
            initialMismatches
                .slice(0, 3)
                .map((m) => "v" + m.variant + ":" + JSON.stringify(m.key.slice(0, 24)))
                .join(", ")
    );
}

module.exports = {
    getSystemPromptVariant,
    pickSystemPromptVariant,
    getVariantMismatches,
    SYSTEM_PROMPT_VARIANT_COUNT,
};
