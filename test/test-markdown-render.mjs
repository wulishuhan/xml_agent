import {
    looksLikeMarkdown,
    renderMarkdown,
    lineLooksLikeMarkdown,
} from "../webui/frontend/src/services/markdown.mjs";

const ASTERISK = String.fromCharCode(42);
const BACKTICK = String.fromCharCode(96);
const LBRACKET = String.fromCharCode(91);
const RBRACKET = String.fromCharCode(93);
const LPAREN = String.fromCharCode(40);
const RPAREN = String.fromCharCode(41);

let passed = 0;
let failed = 0;

function check(name, condition) {
    if (condition) {
        passed++;
        console.log("PASS: " + name);
    } else {
        failed++;
        console.log("FAIL: " + name);
    }
}

// 纯文本不应被当作 Markdown
check("plain text not markdown", looksLikeMarkdown("这是一段普通文字。") === false);
check("plain text render empty", renderMarkdown("这是一段普通文字。") === "");
check("english plain text not markdown", looksLikeMarkdown("hello world") === false);

// Markdown 特征识别
check("heading detected", looksLikeMarkdown("# 标题\n内容") === true);
check("list detected", looksLikeMarkdown("- item1\n- item2") === true);
check("ordered list detected", looksLikeMarkdown("1. first\n2. second") === true);

const boldText = "这是 " + ASTERISK + ASTERISK + "加粗" + ASTERISK + ASTERISK + " 文字";
check("bold detected", looksLikeMarkdown(boldText) === true);

const codeFenceText =
    BACKTICK + BACKTICK + BACKTICK + "js\nconsole.log(1)\n" + BACKTICK + BACKTICK + BACKTICK;
check("code fence detected", looksLikeMarkdown(codeFenceText) === true);

const linkText = "参见 " + LBRACKET + "文档" + RBRACKET + LPAREN + "https://example.com" + RPAREN;
check("link detected", looksLikeMarkdown(linkText) === true);

check("table detected", looksLikeMarkdown("| a | b |\n| - | - |") === true);
check("blockquote detected", looksLikeMarkdown("> 引用内容") === true);
check("hr detected", looksLikeMarkdown("---") === true);

// 渲染结果
const h1 = renderMarkdown("# 标题");
check("heading renders h1", h1.indexOf("<h1") !== -1 && h1.indexOf("标题") !== -1);

const bold = renderMarkdown(boldText);
check("bold renders strong", bold.indexOf("<strong>") !== -1);

const list = renderMarkdown("- a\n- b");
check("list renders ul/li", list.indexOf("<ul>") !== -1 && list.indexOf("<li>") !== -1);

const code = renderMarkdown(codeFenceText);
check("code fence renders pre/code", code.indexOf("<pre>") !== -1 && code.indexOf("<code") !== -1);

const table = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
check("table renders table", table.indexOf("<table>") !== -1);

const link = renderMarkdown(linkText);
check("link renders anchor", link.indexOf("<a ") !== -1);

// 非 markdown 文本渲染为空
check("render empty for plain", renderMarkdown("no markdown here at all") === "");
check("render empty for empty", renderMarkdown("") === "");
check("render empty for null", renderMarkdown(null) === "");

// lineLooksLikeMarkdown 边界
check("line blank false", lineLooksLikeMarkdown("") === false);
check("line plain false", lineLooksLikeMarkdown("normal sentence") === false);

console.log("\nTotal: " + (passed + failed) + ", Passed: " + passed + ", Failed: " + failed);
if (failed > 0) {
    process.exit(1);
}
