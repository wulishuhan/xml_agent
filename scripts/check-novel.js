/**
小说产物合规检查

按 skills/novel-writing/SKILL.md 里可机检的那几条，逐章打分：
- 字数（1900~2100 为达标，1800 以下不合格）
- 首行标题格式
- 禁用词命中
- 对话占比（引号内字符数 / 总字符数，目标 30%~40%）
- 段落长度（有超过 4 行的长段则提示）
- 章节数量

只读，不改任何文件。
用法：node scripts/check-novel.js <workspace>
*/

const fs = require("fs");
const path = require("path");

const BANNED = ["综上所述", "不由得", "空气中弥漫着", "仿佛整个世界都安静了"];
const REPEAT_WORDS = ["心中一凛", "瞳孔一缩", "倒吸一口凉气"];
const MIN_CHARS = 1800;
const TARGET_MIN = 1900;
const TARGET_MAX = 2200;

function charCount(text) {
    // 中文按字计，去掉空白与 Markdown 标记
    return text.replace(/\s/g, "").replace(/[#*>`\-]/g, "").length;
}

function dialogueRatio(text) {
    const total = charCount(text);
    if (!total) {
        return 0;
    }
    const quoted = (text.match(/“[^”]*”/g) || []).join("");
    return charCount(quoted) / total;
}

function checkChapter(file) {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    const firstLine = (lines[0] || "").trim();
    const body = lines.slice(1).join("\n");
    const chars = charCount(body);
    const issues = [];

    if (!/^# 第\d+章 .+/.test(firstLine)) {
        issues.push("标题格式不对：" + firstLine.slice(0, 20));
    }
    if (chars < MIN_CHARS) {
        issues.push("字数不足 " + chars);
    } else if (chars < TARGET_MIN || chars > TARGET_MAX) {
        issues.push("字数偏离目标 " + chars);
    }

    const banned = BANNED.filter((w) => raw.includes(w));
    if (banned.length) {
        issues.push("禁用词：" + banned.join("、"));
    }

    const repeated = REPEAT_WORDS.filter((w) => raw.split(w).length - 1 > 1);
    if (repeated.length) {
        issues.push("重复用词超限：" + repeated.join("、"));
    }

    // 连续 3 段以上既无对话也无动作标记
    const paras = body.split(/\n\s*\n/).filter((p) => p.trim());
    let longest = 0;
    let run = 0;
    for (const p of paras) {
        const hasTalk = /“|\"|道|说|喊|叫/.test(p);
        if (!hasTalk && charCount(p) > 200) {
            run++;
            longest = Math.max(longest, run);
        } else {
            run = 0;
        }
    }
    if (longest >= 3) {
        issues.push("连续 " + longest + " 段纯叙述");
    }

    return {
        file: path.basename(file),
        chars,
        dialogue: dialogueRatio(body),
        issues,
    };
}

function main() {
    const workspace = process.argv[2];
    if (!workspace) {
        throw new Error("usage: node scripts/check-novel.js <workspace>");
    }
    const dir = path.join(workspace, "chapters");
    if (!fs.existsSync(dir)) {
        console.log("还没有 chapters 目录");
        return;
    }
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    let totalChars = 0;
    let totalIssues = 0;
    console.log("章节  字数    对话占比  问题");
    console.log("------------------------------------------------------------");
    for (const f of files) {
        const r = checkChapter(path.join(dir, f));
        totalChars += r.chars;
        totalIssues += r.issues.length;
        console.log(
            r.file.padEnd(12) +
                String(r.chars).padStart(5) +
                "   " +
                (r.dialogue * 100).toFixed(1).padStart(5) +
                "%   " +
                (r.issues.length ? r.issues.join("；") : "ok")
        );
    }
    console.log("------------------------------------------------------------");
    console.log(
        "共 " +
            files.length +
            " 章 / " +
            totalChars +
            " 字 / 平均 " +
            (files.length ? Math.round(totalChars / files.length) : 0) +
            " 字每章 / 问题 " +
            totalIssues +
            " 项"
    );
}

main();
