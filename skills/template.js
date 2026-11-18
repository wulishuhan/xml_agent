/**
 * Skill 文档组装：把「何时使用」与正文拼成一份自包含的 Markdown。
 *
 * 为什么要单独一个模块：
 * - 新建技能和编辑技能都要走同一套拼装逻辑，避免两处拼出不同的结构；
 * - 「何时使用」在 1.2.0 里有两个落点：frontmatter `description`（首轮提示词的
 *   用途一行）和正文 `## 何时使用` 小节（模型 read 全文时能看到完整触发规则）。
 *   这里保证两者一致，且重复保存不会追加出第二个小节。
 */

const TRIGGER_HEADING = "## 何时使用";

/** 去掉正文里已有的同名小节（直到下一个 1-3 级标题或 `---`）。 */
function stripSection(body, heading) {
    const lines = String(body || "")
        .replace(/\r\n/g, "\n")
        .split("\n");
    const idx = lines.findIndex((line) => line.trim() === heading);
    if (idx === -1) {
        return lines.join("\n");
    }
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^#{1,3}\s+/.test(line) || line.trim() === "---") {
            end = i;
            break;
        }
    }
    const out = lines.slice(0, idx).concat(lines.slice(end));
    while (out.length > 0 && out[out.length - 1].trim() === "") {
        out.pop();
    }
    return out.join("\n");
}

/** 把正文拆成「何时使用」和「正文其余部分」，供编辑器使用。 */
function splitSkillDocument(content) {
    const text = String(content || "");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const idx = lines.findIndex((line) => line.trim() === TRIGGER_HEADING);
    if (idx === -1) {
        return { whenToUse: "", content: text };
    }
    const collected = [];
    for (let i = idx + 1; i < lines.length; i += 1) {
        if (/^#{1,3}\s+/.test(lines[i]) || lines[i].trim() === "---") {
            break;
        }
        collected.push(lines[i]);
    }
    const trigger = collected.join("\n").trim();
    const rest = lines.slice(0, idx).join("\n").trim();
    return { whenToUse: trigger, content: rest };
}

/**
 * 组装最终文档。
 * payload: { name, description, whenToUse, content }
 * whenToUse 缺省时用 description 兜底；两者都没有则不写「何时使用」小节。
 */
function composeSkillDocument(payload) {
    const source = payload || {};
    const name = String(source.name || "").trim();
    const description = String(source.description || "").trim();
    const whenToUse = String(source.whenToUse || "").trim();
    const content = String(source.content || "").trim();
    const trigger = whenToUse || description;

    const parts = [];
    if (name) {
        parts.push("name: " + name);
    }
    if (trigger) {
        parts.push("description: " + trigger);
    }
    const front = parts.length > 0 ? "---\n" + parts.join("\n") + "\n---\n\n" : "";

    let body = content;
    if (trigger) {
        body = stripSection(body, TRIGGER_HEADING).trim();
        body = body + "\n\n" + TRIGGER_HEADING + "\n\n" + trigger + "\n";
    }

    return (front + body).replace(/\s+$/, "\n");
}

module.exports = {
    TRIGGER_HEADING,
    stripSection,
    splitSkillDocument,
    composeSkillDocument,
};
