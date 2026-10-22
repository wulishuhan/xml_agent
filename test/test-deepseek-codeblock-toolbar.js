const assert = require("assert");
const clean = require("../providers/markdown-code-clean");
// 模拟带工具栏的代码块文本
const dirty = ["text", "复制", "下载", "const a = 1;", "const b = 2;"].join("\n");
const cleaned = clean.stripCodeToolbarLabels(dirty);
assert.ok(cleaned.indexOf("复制") === -1, "should remove 复制");
assert.ok(cleaned.indexOf("下载") === -1, "should remove 下载");
assert.ok(!/^text$/m.test(cleaned), "should remove bare text line");
assert.ok(cleaned.indexOf("const a = 1;") !== -1, "should keep real code");
const dirtyEnglish = "Copy\nDownload\nprint('hi')";
const cleanedEnglish = clean.stripCodeToolbarLabels(dirtyEnglish);
assert.ok(cleanedEnglish.indexOf("Copy") === -1, "should remove Copy");
assert.ok(cleanedEnglish.indexOf("Download") === -1, "should remove Download");
assert.ok(cleanedEnglish.indexOf("print('hi')") !== -1, "should keep real code");
const pureCode = "function foo() {\n  return 1;\n}";
assert.strictEqual(clean.stripCodeToolbarLabels(pureCode), pureCode, "pure code unchanged");
assert.strictEqual(clean.stripCodeToolbarLabels(""), "");
assert.strictEqual(clean.stripCodeToolbarLabels(null), "");
console.log("All deepseek codeblock toolbar checks passed.");
