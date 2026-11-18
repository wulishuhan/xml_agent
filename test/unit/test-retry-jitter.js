/**
 * 退避抖动单测（agent/retry.js）
 *
 * 覆盖：默认（不抖动）精确值保持不变、注入随机源后的区间边界、上限不越界、非法入参。
 *
 * 运行：node test/unit/test-retry-jitter.js
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

async function main() {
    // 默认 jitter 未传：保持精确值（旧测试的回归门槛）
    check("默认 1 次 1000ms", nextDelay(1) === 1000, String(nextDelay(1)));
    check("默认 2 次 2000ms", nextDelay(2) === 2000, String(nextDelay(2)));
    check("默认 6 次触顶 30000", nextDelay(6) === 30000, String(nextDelay(6)));

    // 注入随机源后的区间
    check(
        "抖动下限（random=0）",
        nextDelay(1, { jitter: 0.3, random: () => 0 }) === 700,
        String(nextDelay(1, { jitter: 0.3, random: () => 0 }))
    );
    check(
        "抖动中点（random=0.5）",
        nextDelay(1, { jitter: 0.3, random: () => 0.5 }) === 1000,
        String(nextDelay(1, { jitter: 0.3, random: () => 0.5 }))
    );
    check(
        "抖动上限（random=1）",
        nextDelay(1, { jitter: 0.3, random: () => 1 }) === 1300,
        String(nextDelay(1, { jitter: 0.3, random: () => 1 }))
    );

    // 抖动不会超过 max
    check(
        "抖动后不越过上限",
        nextDelay(6, { jitter: 0.3, random: () => 1 }) === 30000,
        String(nextDelay(6, { jitter: 0.3, random: () => 1 }))
    );

    // jitter=0 等价于不抖动
    check(
        "jitter=0 精确",
        nextDelay(3, { jitter: 0, random: () => 1 }) === 4000,
        String(nextDelay(3, { jitter: 0, random: () => 1 }))
    );

    // 随机结果确实落在区间内
    const values = [];
    for (let i = 0; i < 200; i += 1) {
        values.push(nextDelay(2, { jitter: 0.3 }));
    }
    check(
        "区间内随机",
        values.every((v) => v >= 1400 && v <= 2600),
        "min=" + Math.min.apply(null, values) + " max=" + Math.max.apply(null, values)
    );

    // 非法入参：归一为第一次失败（1000ms），抖动后仍在 [700, 1300]
    const invalid = nextDelay(undefined, { jitter: 0.3 });
    check("非法 attempt 按第一次处理", invalid >= 700 && invalid <= 1300, String(invalid));

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("FAILED: " + error.stack);
    process.exitCode = 1;
});
