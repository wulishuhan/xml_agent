/**
技能段（首轮提示词注入）

只列"模型当前工作区里真读得到"的技能。`read` 动作被沙箱限制在工作区内，
把安装包路径或 `~/.xml-agent/skills` 下的绝对路径写进提示词，模型一读就被拒绝，
只会白白烧掉几步。外部技能由用户在 Skills 面板点"安装到工作区"复制一份进来。

没有可读技能时返回空字符串 —— 此时首轮提示词与旧版本逐字节一致，
不会因为引入技能系统而改变任何既有任务的提示词。
*/

const MAX_SKILLS = 12;
const MAX_DESCRIPTION = 120;

function buildSkillPromptSection(skills, options = {}) {
    if (!Array.isArray(skills) || skills.length === 0) {
        return "";
    }
    const maxSkills = Number.isFinite(options.maxSkills)
        ? Math.max(1, options.maxSkills)
        : MAX_SKILLS;
    const entries = skills
        .filter((skill) => {
            if (!skill || typeof skill !== "object") {
                return false;
            }
            if (skill.enabled === false) {
                return false;
            }
            // 同名技能在多个来源里都存在时，只有最高优先级的那一份会进提示词，
            // 否则同一个技能会被列两遍、路径还互相矛盾。
            if (skill.active === false) {
                return false;
            }
            // workspacePath 为空 = 模型读不到，写进提示词只会让它撞墙。
            return typeof skill.workspacePath === "string" && skill.workspacePath.trim() !== "";
        })
        .slice(0, maxSkills);

    if (entries.length === 0) {
        return "";
    }

    const lines = entries.map((skill) => {
        const name = String(skill.name || skill.slug || "skill").trim();
        const description = String(skill.description || "")
            .replace(/\s+/g, " ")
            .trim();
        const clipped =
            description.length > MAX_DESCRIPTION
                ? description.slice(0, MAX_DESCRIPTION - 1) + "…"
                : description;
        const parts = ["- " + name, "  路径：" + skill.workspacePath];
        if (clipped) {
            parts.push("  用途：" + clipped);
        }
        return parts.join("\n");
    });

    return [
        "可用技能（Skill）",
        "",
        "技能文档是「这类任务该怎么做」的完整规范。任务与某个技能匹配时，",
        "先用 read 把它读完再动手；不匹配就不要读 —— 它会占掉大量上下文。",
        "",
        lines.join("\n"),
    ].join("\n");
}

module.exports = {
    buildSkillPromptSection,
};
