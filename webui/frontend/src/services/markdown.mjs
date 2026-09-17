import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

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

export function renderMarkdown(text) {
    if (typeof text !== "string" || !text.trim()) {
        return "";
    }
    if (!looksLikeMarkdown(text)) {
        return "";
    }
    try {
        const html = marked.parse(text);
        return typeof html === "string" ? html : "";
    } catch (error) {
        return "";
    }
}
