import assert from "assert";
import {
    renderMarkdown,
    protectInlineSpaces,
    looksLikeMarkdown,
} from "../webui/frontend/src/services/markdown.mjs";
const NL = String.fromCharCode(10);
const NBSP = String.fromCharCode(160);
const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;
const BR_TAG = String.fromCharCode(60) + "br";
let passed = 0;
let total = 0;
function check(name, ok, detail) {
    total += 1;
    if (ok) passed += 1;
    const suffix = detail ? "  [" + detail + "]" : "";
    console.log((ok ? "PASS" : "FAIL") + " - " + name + suffix);
}
// 1. 带 markdown 特征的多行文本：单换行应渲染为 br 标签
const multiline = ["**标题**", "第一行内容", "第二行内容", "第三行内容"].join(NL);
const html1 = renderMarkdown(multiline);
check("多行文本渲染出 br 标签", html1.indexOf(BR_TAG) !== -1, html1.slice(0, 120));
// 2. 连续空格在非代码区域应保留（转换为 nbsp）
const withSpaces = ["**对齐**", "名称:    值A", "更长名称: 值B"].join(NL);
const html2 = renderMarkdown(withSpaces);
check("连续空格被保留(nbsp)", html2.indexOf(NBSP) !== -1, html2.slice(0, 160));
// 3. 代码围栏内的连续空格不应被替换
const fenced = ["**示例**", FENCE + "js", "const a =    1;", FENCE].join(NL);
const safe = protectInlineSpaces(fenced);
check("代码围栏内空格原样保留", safe.indexOf("const a =    1;") !== -1, JSON.stringify(safe));
// 4. protectInlineSpaces 对行首缩进也保留
const indented = ["**列表**", "    缩进四空格"].join(NL);
const safe2 = protectInlineSpaces(indented);
check("行首缩进被保留", safe2.indexOf(NBSP) !== -1, JSON.stringify(safe2));
// 5. 纯文本（无 markdown 特征）应返回空字符串，由前端回退到 pre-wrap
const plain = ["第一行", "第二行"].join(NL);
check("纯文本返回空(回退pre-wrap)", renderMarkdown(plain) === "");
check("纯文本 looksLikeMarkdown=false", looksLikeMarkdown(plain) === false);
// 6. 空输入安全
check("空字符串安全", renderMarkdown("") === "" && renderMarkdown(null) === "");
console.log("");
console.log("Total: " + passed + "/" + total);
if (passed !== total) {
    process.exit(1);
}
