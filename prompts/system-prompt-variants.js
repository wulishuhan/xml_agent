/**
 * 首轮提示词的措辞变体池（降风控特征）
 *
 * 网页对话平台会把首轮提示词当用户消息读。同一段话在多个会话里原样重复，
 * 本身就是"脚本在批量操作"的文本指纹。这里提供 N 套语义等价、措辞不同的
 * 版本，每个会话抽一套，让会话之间的首消息文本不同。
 *
 * 实现方式刻意保守：只对散文句子做"整行精确替换"，XML 动作示例、结构锚点
 * （动作可以这样写 / Workspace Manifest / 用户任务）全部原样保留。这样：
 * - 模型的动作语法输入完全一致，行为不会漂；
 * - test-prompt-examples.js 里钉住的示例片段仍然逐字存在；
 * - 变体 0 就是原始 SYSTEM_PROMPT，指纹测试与旧调用方完全兼容。
 *
 * 注意：SYSTEM_PROMPT 在 v1.3.0 改为半文半白后，这里三套变体同步改成
 * 语义等价的其它半文表述；每张重写的 key 必须与 system-prompt.js 整行逐字一致，
 * 否则那一行会静默退回原文、变体退化（由 getVariantMismatches + 单测兜底）。
 */
const { SYSTEM_PROMPT } = require("./system-prompt");

/**
 * 每套变体是一张 { 原文行: 改写行 } 的映射。
 * key 必须与 system-prompt.js 里的整行逐字一致；不在映射里的行原样保留。
 */
const REWRITES = [
    // 0 = 原文基准（空映射）。指纹测试钉的就是这个索引。
    {},

    // 1 = 更简的半文措辞
    {
        "我于本机维护一项目，望你分步示令：每轮只出一动作，我照做后据实回报，你据此定下一步。":
            "本机有一项目，请你逐条下令：每轮仅给一动作，我执行后如实回告，由你定后续。",
        "动作可以这样写（属性用双引号，路径皆相对项目根；动作直书正文，勿用代码块包裹）：":
            "动作可以这样写（属性用双引号；路径一律相对项目根；直接写在正文里，不要包代码块）：",
        读文件或目录: "查看文件或目录",
        "新建或整体重写文件（内容置于 CDATA，父目录自动建）":
            "新建或整篇重写文件（正文置于 CDATA，父目录自动创建）",
        "局部修改现有文件（优先用此，勿整篇重写）": "只改现有文件的几处（尽量用它，别整篇重写）",
        '- old 须与原文逐字一致（含缩进）且唯一；不唯一则多带上下文，或用 all="true" 全替换':
            '- old 须与原文逐字相同（含缩进）且唯一；不唯一就多带上下文，或用 all="true" 全替',
        "- new 留空表示删除该段": "- new 留空即删除此段",
        "- 任一处失配则整条不写入；文件不存在则用 write": "- 有一处不匹配整条都不写入；文件尚未存在则用 write",
        执行命令: "跑一条命令",
        "截图（存于项目内并返回相对路径，成功后图直接发你）":
            "截个图（存进项目并返回相对路径，成功后图片直接发你）",
        "source 取 screen / window（需 windowTitle）/ browser_page（可选 url、selector、fullPage）；每轮至多 8 个 target，宜 4-6 个。":
            "source 取 screen / window（要 windowTitle）/ browser_page（可选 url、selector、fullPage）；每轮最多 8 个 target，建议 4-6 个。",
        最终答复: "给用户的最终回答",
        收尾: "结束",
        "规矩：": "约定：",
        "- 未读之文件勿猜，先 read；读目录仅返一层 entries，据此定下一步":
            "- 没读过的文件别猜，先 read；读目录只返回一层 entries，据此决定下一步",
        "- 项目既有结构沿用之，勿推倒重来；改毕须验语法与运行（文档类免），临时验证文件用后即删":
            "- 沿用项目现有结构，别推倒重来；改完要验证语法和运行（文档类免），临时验证文件用完就删",
        "- 解释、分析、排查、总结类任务，做完必要的 read / exec / 截图后须以 <answer> 直接作答，勿只报执行过程":
            "- 解释、分析、排查、总结类任务，做完必要的 read / exec / 截图后要用 <answer> 直接回答，别只汇报执行了什么",
        "- 修改类任务于 <answer> 中说明改了什么、动了哪些文件、验证结果":
            "- 修改类任务在 <answer> 里说清改了什么、动了哪些文件、验证结果",
        "- <answer> 独占一轮，下一轮再给 <done/>，勿写在同一轮":
            "- <answer> 单独占一轮，下一轮再给 <done/>，不要写在同一轮",
        "- 出错依真实报错修之；修不好则以 <answer> 如实说明":
            "- 出错就按真实报错修；修不好就用 <answer> 如实说明",
        "- 结论一律以实读内容与运行结果为准，勿编造": "- 结论一律以实际读到的内容和运行结果为准，别编造",
    },

    // 2 = 工单 / 协作口吻
    {
        "我于本机维护一项目，望你分步示令：每轮只出一动作，我照做后据实回报，你据此定下一步。":
            "手头有个本机项目在改，想与你分步协作：每轮只给一条指令，我执行后把结果原文发你，你据此推进。",
        "动作可以这样写（属性用双引号，路径皆相对项目根；动作直书正文，勿用代码块包裹）：":
            "动作可以这样写（属性用双引号；路径相对项目根目录；直接写正文，不用代码块）：",
        读文件或目录: "读取文件或目录",
        "新建或整体重写文件（内容置于 CDATA，父目录自动建）":
            "新建或整体覆盖文件（内容放 CDATA，父目录自动创建）",
        "局部修改现有文件（优先用此，勿整篇重写）": "仅改动文件现存的几处（优先选它，不要整篇覆盖）",
        '- old 须与原文逐字一致（含缩进）且唯一；不唯一则多带上下文，或用 all="true" 全替换':
            '- old 必须与原文逐字一致（含缩进）并且在文件中唯一；不唯一就多带几行上下文，或用 all="true" 表示全部替换',
        "- new 留空表示删除该段": "- new 留空即表示删掉这一段",
        "- 任一处失配则整条不写入；文件不存在则用 write": "- 任一处匹配失败则整条动作不写入；文件不存在时改用 write",
        执行命令: "执行命令",
        "截图（存于项目内并返回相对路径，成功后图直接发你）":
            "截图（保存到项目内并返回相对路径，成功后图片会直接发给你）",
        "source 取 screen / window（需 windowTitle）/ browser_page（可选 url、selector、fullPage）；每轮至多 8 个 target，宜 4-6 个。":
            "source 取 screen / window（需要 windowTitle）/ browser_page（可选 url、selector、fullPage）；一次最多 8 个 target，建议 4-6 个。",
        最终答复: "最终答复用户",
        收尾: "结束会话",
        "规矩：": "协作规则：",
        "- 未读之文件勿猜，先 read；读目录仅返一层 entries，据此定下一步":
            "- 未读过的文件先 read 再看，别凭空猜；读目录只返回一层 entries，按它决定接下来读哪些",
        "- 项目既有结构沿用之，勿推倒重来；改毕须验语法与运行（文档类免），临时验证文件用后即删":
            "- 沿用项目现有结构，不要推倒重来；改完做语法与运行验证（文档类可跳过），临时验证文件用完即删",
        "- 解释、分析、排查、总结类任务，做完必要的 read / exec / 截图后须以 <answer> 直接作答，勿只报执行过程":
            "- 解释、分析、排查、总结类任务，做完必要的 read / exec / 截图后必须用 <answer> 直接作答，不要只汇报执行过程",
        "- 修改类任务于 <answer> 中说明改了什么、动了哪些文件、验证结果":
            "- 修改类任务在 <answer> 里说明改动内容、涉及文件与验证结果",
        "- <answer> 独占一轮，下一轮再给 <done/>，勿写在同一轮":
            "- <answer> 与 <done/> 分开两轮给，不要写在一起",
        "- 出错依真实报错修之；修不好则以 <answer> 如实说明":
            "- 依据真实报错修正；修不好就用 <answer> 如实说明",
        "- 结论一律以实读内容与运行结果为准，勿编造": "- 一切结论以实际读到的内容及运行结果为准，不得编造",
    },

    // 3 = 简短指令口吻
    {
        "我于本机维护一项目，望你分步示令：每轮只出一动作，我照做后据实回报，你据此定下一步。":
            "本机有个项目，想让你一步步指挥：一次一条操作，我这边执行完把结果贴回，你再判断下一步。",
        "动作可以这样写（属性用双引号，路径皆相对项目根；动作直书正文，勿用代码块包裹）：":
            "动作可以这样写（属性双引号；路径相对项目根目录；正文里直接写，不要代码块）：",
        读文件或目录: "读文件或列目录",
        "新建或整体重写文件（内容置于 CDATA，父目录自动建）":
            "新建或重写整个文件（内容放 CDATA，父目录自动建）",
        "局部修改现有文件（优先用此，勿整篇重写）": "只修改文件里已有的几处（优先用它，别整篇重写）",
        '- old 须与原文逐字一致（含缩进）且唯一；不唯一则多带上下文，或用 all="true" 全替换':
            '- old 须逐字匹配原文（含缩进）且唯一；不唯一就多带上下文，或用 all="true" 全替换',
        "- new 留空表示删除该段": "- new 留空即删掉这段",
        "- 任一处失配则整条不写入；文件不存在则用 write": "- 一处不匹配整条就不写；文件不存在就用 write",
        执行命令: "执行命令",
        "截图（存于项目内并返回相对路径，成功后图直接发你）":
            "截图（存项目内、返回相对路径，成功后图直接发你）",
        "source 取 screen / window（需 windowTitle）/ browser_page（可选 url、selector、fullPage）；每轮至多 8 个 target，宜 4-6 个。":
            "source 取 screen / window（要 windowTitle）/ browser_page（可选 url、selector、fullPage）；一轮最多 8 个 target，建议 4-6 个。",
        最终答复: "给用户最终答案",
        收尾: "结束",
        "规矩：": "注意事项：",
        "- 未读之文件勿猜，先 read；读目录仅返一层 entries，据此定下一步":
            "- 没读过的先 read，不要猜；读目录只返回一层 entries，据此决定下一步",
        "- 项目既有结构沿用之，勿推倒重来；改毕须验语法与运行（文档类免），临时验证文件用后即删":
            "- 沿用现有结构别推倒重来；改完验证语法和运行（文档类免），临时验证文件用完删",
        "- 解释、分析、排查、总结类任务，做完必要的 read / exec / 截图后须以 <answer> 直接作答，勿只报执行过程":
            "- 解释、分析、排查、总结类任务，做完必要的 read / exec / 截图后用 <answer> 直接回答，别只报动作",
        "- 修改类任务于 <answer> 中说明改了什么、动了哪些文件、验证结果":
            "- 修改类任务在 <answer> 里说明改了什么、哪些文件、验证结果",
        "- <answer> 独占一轮，下一轮再给 <done/>，勿写在同一轮":
            "- <answer> 单独一轮，下一轮再给 <done/>，不要同轮",
        "- 出错依真实报错修之；修不好则以 <answer> 如实说明":
            "- 按真实错误修；修不好就用 <answer> 如实说明",
        "- 结论一律以实读内容与运行结果为准，勿编造": "- 结论以实际读取和执行结果为准，不要编造",
    },
];

/** 变体总数（含索引 0 的原文基准）。 */
const SYSTEM_PROMPT_VARIANT_COUNT = REWRITES.length;

/**
 * 取指定索引的提示词文本。索引越界或非整数时退回原文基准。
 * @param {number} index 变体索引，0 表示原文。
 * @returns {string}
 */
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

/**
 * 新会话抽签：均匀随机取一个变体索引。
 * 调用方（Agent）在构造时抽一次，整场会话复用，保证会话内文本一致。
 * @returns {number}
 */
function pickSystemPromptVariant() {
    return Math.floor(Math.random() * REWRITES.length);
}

/**
 * 自检：每张重写的 key 必须能在 SYSTEM_PROMPT 里精确命中整行。
 * 正文被改动却忘了同步映射时，getSystemPromptVariant 会静默把那行退回原文，
 * 变体悄悄退化却没有任何报错。这里把失配显式暴露出来，交给测试固化成红灯。
 * @returns {{ variant: number, key: string }[]} 失配清单，空数组表示全部命中
 */
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

// 模块加载时提醒一次（不抛错，避免提示词微调直接让生产环境崩）；
// 真正的强制校验在 test/unit/test-prompt-variants.js。
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
