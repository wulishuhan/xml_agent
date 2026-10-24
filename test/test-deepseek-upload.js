// 验证 DeepSeek 图片上传能力（不启动真实浏览器，仅校验实现与配置）。
const assert = require("assert");
const fs = require("fs");
// 1) BrowserAgent 基类应提供通用 uploadImages
const ba = fs.readFileSync("providers/browser-agent.js", "utf8");
assert.ok(ba.indexOf("async uploadImages(") !== -1, "BrowserAgent 应提供 uploadImages");
assert.ok(ba.indexOf("filechooser") !== -1, "应使用 filechooser 事件处理上传对话框");
assert.ok(ba.indexOf("setInputFiles") !== -1, "应回退到 setInputFiles");
// 2) DeepSeekProvider 应定义上传按钮选择器并复用基类方法
const ds = fs.readFileSync("providers/deepseek.js", "utf8");
assert.ok(ds.indexOf("uploadButtonSelectors") !== -1, "DeepSeek 应定义 uploadButtonSelectors");
assert.ok(ds.indexOf("super.uploadImages") !== -1, "DeepSeek 应复用基类 uploadImages");
assert.ok(
    ds.indexOf("ds-button--capsule") !== -1,
    "上传按钮选择器应使用稳定的结构类名（避开随机哈希）"
);
// 3) 上传按钮选择器不应依赖随机哈希类名
const hashPattern = /f02f0e25/;
assert.strictEqual(hashPattern.test(ds), false, "选择器不应写死随机哈希类名");
console.log("DEEPSEEK UPLOAD TESTS PASSED");
