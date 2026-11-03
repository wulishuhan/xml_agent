/**
重试退避策略单测（agent/retry.js）

纯函数，不需要浏览器 / HTTP，这一层可以在毫秒级跑完，
是后续 agent-core 改动的安全网。

运行：node test/unit/test-retry.js
*/

const { nextDelay } = require("../../agent/retry");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

const cases = [
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 16000],
];

for (const [attempt, expected] of cases) {
    const actual = nextDelay(attempt);
    check("第 " + attempt + " 次失败等待 " + expected + "ms", actual === expected, String(actual));
}

check("第 6 次触顶（32000 → 30000）", nextDelay(6) === 30000, String(nextDelay(6)));
check("第 100 次仍触顶", nextDelay(100) === 30000, String(nextDelay(100)));

check("0 按第一次处理", nextDelay(0) === 1000, String(nextDelay(0)));
check("负数按第一次处理", nextDelay(-5) === 1000, String(nextDelay(-5)));
check("非数字按第一次处理", nextDelay(undefined) === 1000, String(nextDelay(undefined)));
check("字符串数字可解析", nextDelay("3") === 4000, String(nextDelay("3")));

check(
    "可覆盖 baseMs",
    nextDelay(3, { baseMs: 500 }) === 2000,
    String(nextDelay(3, { baseMs: 500 }))
);
check(
    "可覆盖 maxMs",
    nextDelay(10, { maxMs: 5000 }) === 5000,
    String(nextDelay(10, { maxMs: 5000 }))
);

// 单调不减：延迟不应随重试次数回退，否则退避策略失效。
let monotonic = true;
let previous = 0;
for (let attempt = 1; attempt <= 20; attempt++) {
    const current = nextDelay(attempt);
    if (current < previous) {
        monotonic = false;
    }
    previous = current;
}
check("延迟单调不减", monotonic);

console.log("\nTotal: " + pass + "/" + total);
if (pass !== total) {
    process.exitCode = 1;
}
