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
const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** frontmatter 只支持一层 key: value，值里的换行必须压平，否则会把后续行顶成新字段。 */
function frontValue(value) {
    return String(value == null ? "" : value)
        .replace(/[\r\n]+/g, " ")
        .trim();
}

/** 找到小节正文的结束位置：下一个 1-3 级标题或 `---`。 */
function sectionEnd(lines, idx) {
    for (let i = idx + 1; i < lines.length; i += 1) {
        if (/^#{1,3}\s+/.test(lines[i]) || lines[i].trim() === "---") {
            return i;
        }
    }
    return lines.length;
}

/** 去掉正文里已有的同名小节（直到下一个 1-3 级标题或 `---`）。 */
function stripSection(body, heading) {
    const lines = String(body || "")
        .replace(/\r\n/g, "\n")
        .split("\n");
    const idx = lines.findIndex((line) => line.trim() === heading);
    if (idx === -1) {
        return lines.join("\n");
    }
    const end = sectionEnd(lines, idx);
    const out = lines.slice(0, idx).concat(lines.slice(end));
    while (out.length > 0 && out[out.length - 1].trim() === "") {
        out.pop();
    }
    return out.join("\n");
}

/**
 * 把正文拆成「何时使用」和「正文其余部分」，供编辑器使用。
 *
 * 关键：小节**之后**的章节也要原样留在 content 里。旧实现只取 `slice(0, idx)`，
 * 遇到 1.1.x 那种「何时使用在中间、后面还有 --- 和正文」的文档，用户一保存
 * 后半段就静默消失了。
 */
function splitSkillDocument(content) {
    const text = String(content || "");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const idx = lines.findIndex((line) => line.trim() === TRIGGER_HEADING);
    if (idx === -1) {
        return { whenToUse: "", content: text };
    }
    const end = sectionEnd(lines, idx);
    const trigger = lines
        .slice(idx + 1, end)
        .join("\n")
        .trim();
    const rest = lines.slice(0, idx).concat(lines.slice(end)).join("\n").trim();
    return { whenToUse: trigger, content: rest };
}

/**
 * 基于原文档合并 frontmatter：只改 name / description，其余行（tags、version、
 * 自定义字段、注释、顺序、引号写法）原样保留。结构化保存不再把用户自己加的
 * 元数据整片重写掉。
 *
 * fields: { name, description }
 *   - name 为空表示「不改动原值」；
 *   - description 为 "" 表示删掉 description 行（清空「何时使用」时保持一致）；
 *   - description 为 undefined 表示「不改动」。
 */
function mergeFrontMatter(text, fields) {
    const source = String(text || "");
    const match = FRONT_MATTER_RE.exec(source);
    const inner = match ? match[1] : "";
    const lines = inner ? inner.split(/\r?\n/) : [];
    const out = [];
    let hasName = false;
    let hasDescription = false;
    for (const line of lines) {
        const pair = /^(\s*)([A-Za-z0-9_-]+)(\s*:\s*)(.*)$/.exec(line);
        if (pair) {
            const key = pair[2].toLowerCase();
            if (key === "name") {
                hasName = true;
                if (fields.name) {
                    out.push(pair[1] + "name" + pair[3] + frontValue(fields.name));
                    continue;
                }
            } else if (key === "description") {
                hasDescription = true;
                if (fields.description !== undefined) {
                    if (fields.description !== "") {
                        out.push(
                            pair[1] + "description" + pair[3] + frontValue(fields.description)
                        );
                    }
                    continue;
                }
            }
        }
        // 未知字段、注释、空行、多行值：一律原样保留
        out.push(line);
    }
    if (fields.name && !hasName) {
        out.push("name: " + frontValue(fields.name));
    }
    if (fields.description && !hasDescription) {
        out.push("description: " + frontValue(fields.description));
    }
    if (!match && out.length === 0) {
        return "";
    }
    return "---\n" + out.join("\n") + "\n---\n\n";
}

/** 只组装正文：去掉旧的「何时使用」小节，再把新值统一追加到末尾。 */
function composeSkillBody(payload) {
    const source = payload || {};
    const description = String(source.description || "").trim();
    const whenToUse = String(source.whenToUse || "").trim();
    const trigger = whenToUse || description;
    let body = String(source.content || "").trim();
    if (trigger) {
        body = stripSection(body, TRIGGER_HEADING).trim();
        body = body + "\n\n" + TRIGGER_HEADING + "\n\n" + trigger + "\n";
    }
    return body;
}

/**
 * 组装最终文档。
 * payload: { name, description, whenToUse, content, originalText? }
 * whenToUse 缺省时用 description 兜底；两者都没有则不写「何时使用」小节。
 * originalText 传入时按原样保留 frontmatter 里的其它字段（见 writeSkillFields）。
 */
function composeSkillDocument(payload) {
    const source = payload || {};
    const name = String(source.name || "").trim();
    const description = String(source.description || "").trim();
    const whenToUse = String(source.whenToUse || "").trim();
    const trigger = whenToUse || description;
    const front = mergeFrontMatter(source.originalText || "", {
        name: name || undefined,
        description: trigger,
    });
    return (front + composeSkillBody(source)).replace(/\s+$/, "\n");
}

module.exports = {
    TRIGGER_HEADING,
    frontValue,
    sectionEnd,
    stripSection,
    splitSkillDocument,
    mergeFrontMatter,
    composeSkillBody,
    composeSkillDocument,
};
