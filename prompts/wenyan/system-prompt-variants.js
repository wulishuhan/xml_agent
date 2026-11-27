/**
 * 文言文协议首轮提示词措辞变体（实验协议 wenyan）
 * 与 xml 版同构：0 为原文基准，1-3 为语义等价的文言改写；
 * 动作语法行原样保留，只改散文句。
 * 每张重写的 key 必须与 system-prompt.js 里的整行逐字一致。
 */
const { SYSTEM_PROMPT } = require("./system-prompt");

const OPENING = "吾司执行，汝司谋断：每轮只出一令，吾行而实报，汝再定进退。";

const REWRITES = [
    // 0 = 原文基准
    {},

    // 1
    {
        [OPENING]: "吾有一役，赖汝谋划：每轮只出一令，吾依令而行，如实回报，汝复定行止。",
        "约法：": "条规：",
        "- 未阅勿猜；目录只列一层，路径皆相对项目根":
            "- 未见之档勿臆测；目录只列一层，路径皆相对项目根",
    },

    // 2
    {
        [OPENING]: "此役由吾执行，由汝调度：一轮一令，吾行之后据实奉告，再由汝裁断下一步。",
        "- 未阅勿猜；目录只列一层，路径皆相对项目根":
            "- 未见之档勿臆测；目录只列一层，路径皆相对项目根",
    },

    // 3
    {
        [OPENING]: "吾司执行，汝司谋断：每轮予我一令，我行之而实报，汝乃定后续。",
        "- 出错依实自修；不能修，以 答 陈明，勿妄造":
            "- 凡有误按实自正；不能正则以 答 据实陈明，勿虚饰",
    },
];

const SYSTEM_PROMPT_VARIANT_COUNT = REWRITES.length;

function applyRewrites(base, rewrites) {
    let text = base;
    for (const key of Object.keys(rewrites)) {
        text = text.split(key).join(rewrites[key]);
    }
    return text;
}

function getSystemPromptVariant(index) {
    const resolved =
        Number.isInteger(index) && index >= 0 && index < REWRITES.length ? index : 0;
    return applyRewrites(SYSTEM_PROMPT, REWRITES[resolved]);
}

function pickSystemPromptVariant() {
    return Math.floor(Math.random() * SYSTEM_PROMPT_VARIANT_COUNT);
}

function getVariantMismatches() {
    const mismatches = [];
    REWRITES.forEach((map, index) => {
        for (const key of Object.keys(map)) {
            if (SYSTEM_PROMPT.indexOf(key) === -1) {
                mismatches.push({ variant: index, key });
            }
        }
    });
    return mismatches;
}

module.exports = {
    SYSTEM_PROMPT_VARIANT_COUNT,
    getSystemPromptVariant,
    pickSystemPromptVariant,
    getVariantMismatches,
};
