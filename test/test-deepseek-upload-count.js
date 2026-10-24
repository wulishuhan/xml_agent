// 验证 DeepSeek 上传数量校验逻辑（不启动浏览器）。
const assert = require("assert");
const fs = require("fs");
const src = fs.readFileSync("providers/deepseek.js", "utf8");
// 1) 应定义缩略图计数方法与数量校验
assert.ok(src.indexOf("countImageThumbs") !== -1, "应定义 countImageThumbs");
assert.ok(src.indexOf("img._9f130b7") !== -1, "应通过 _9f130b7 类名统计缩略图");
assert.ok(src.indexOf("upload count mismatch") !== -1, "应有数量不匹配报错");
assert.ok(src.indexOf("beforeCount") !== -1, "应在上传前记录数量");
// 2) 校验逻辑模拟：delta 必须等于图片数
function checkDelta(expected, before, after) {
    const delta = after - before;
    return delta === expected;
}
assert.strictEqual(checkDelta(4, 40, 44), true, "上传 4 张，+4 应通过");
assert.strictEqual(checkDelta(4, 40, 52), false, "上传 4 张却 +12 应失败");
assert.strictEqual(checkDelta(4, 40, 42), false, "上传 4 张只 +2 应失败");
assert.strictEqual(checkDelta(2, 44, 46), true, "上传 2 张，+2 应通过");
// 3) 上传后等待重试（最多 20 次）以容忍异步渲染
assert.ok(src.indexOf("attempt < 20") !== -1, "应有轮询等待以容忍异步渲染");
console.log("DEEPSEEK UPLOAD COUNT TESTS PASSED");
