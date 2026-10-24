import { marked } from "marked";
// 关键：breaks 必须为 true。
// 大模型回复通常是"多行纯文本 + 少量 markdown"，breaks:false 时单换行会被合并成空格，
// 导致用户在 CDP 页面看到的换行，在 Web/桌面端渲染后消失。
marked.setOptions({ gfm: true, breaks: true });
const FENCE = String.fromCharCode(96, 96, 96);
const NL = String.fromCharCode(10);
const NBSP = String.fromCharCode(160);
export function lineLooksLikeMarkdown(line) {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (!trimmed) {
        return false;
    }
    if (trimmed.indexOf("# ") === 0 || trimmed.indexOf("## ") === 0) {
        return true;
    }
    if (trimmed.indexOf("### ") === 0 || trimmed.indexOf("#### ") === 0) {
        return true;
    }
    if (trimmed.indexOf("- ") === 0 || trimmed.indexOf("* ") === 0) {
        return true;
    }
    if (trimmed.indexOf("+ ") === 0) {
        return true;
    }
    if (trimmed.indexOf("> ") === 0) {
        return true;
    }
    if (/^\d+.\s/.test(trimmed)) {
        return true;
    }
    if (trimmed.indexOf("|") === 0 && trimmed.lastIndexOf("|") > 0) {
        return true;
    }
    return false;
}
export function looksLikeMarkdown(text) {
    if (typeof text !== "string" || !text.trim()) {
        return false;
    }
    if (text.indexOf("```") !== -1) {
        return true;
    }
    if (text.indexOf("**") !== -1) {
        return true;
    }
    if (text.indexOf("](") !== -1) {
        return true;
    }
    if (text.indexOf("---") !== -1) {
        return true;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lineLooksLikeMarkdown(lines[i])) {
            return true;
        }
    }
    return false;
}
// Markdown 规范会折叠行内连续空格，导致大模型刻意输出的对齐空格丢失。
// 这里把"非代码区域"的连续 2 个及以上空格替换为 空格 + NBSP，渲染后视觉保留。
// 代码围栏（```）内部完全不动，保证代码缩进与空格原样输出。
export function protectInlineSpaces(text) {
    if (typeof text !== "string" || !text) {
        return "";
    }
    const lines = text.split(NL);
    const out = [];
    let inFence = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.indexOf(FENCE) === 0) {
            inFence = !inFence;
            out.push(line);
            continue;
        }
        if (inFence) {
            out.push(line);
            continue;
        }
        // 行首缩进也要保留（否则 markdown 会把它当普通段落开头空格丢弃）。
        const leadingMatch = line.match(/^( +)/);
        const leading = leadingMatch ? leadingMatch[1] : "";
        const rest = leading ? line.slice(leading.length) : line;
        const leadingSafe = leading.length > 1 ? " " + NBSP.repeat(leading.length - 1) : leading;
        const restSafe = rest.replace(/ {2,}/g, (match) => " " + NBSP.repeat(match.length - 1));
        out.push(leadingSafe + restSafe);
    }
    return out.join(NL);
}
export function renderMarkdown(text) {
    if (typeof text !== "string" || !text.trim()) {
        return "";
    }
    if (!looksLikeMarkdown(text)) {
        return "";
    }
    try {
        const safe = protectInlineSpaces(text);
        const html = marked.parse(safe);
        return typeof html === "string" ? html : "";
    } catch (error) {
        return "";
    }
}
