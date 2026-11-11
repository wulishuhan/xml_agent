/**
 * 会话记忆压缩的单元测试
 *
 * 压缩是确定性规则，因此每条断言都能精确到条数与内容：
 * - 档位语义（off / light / strong / auto）；
 * - 每条规则单独生效且不乱动别的记录（截断、折叠噪声、合并重复、省略中段）；
 * - 统计口径（before/after 的条数与字符、节省比例）；
 * - 边界：空列表、循环引用的 event、非法档位。

 * 不读真实会话目录：这里的输入全是内存里造出来的记录。
 */

const assert = require("assert");

const compress = require("../../webui/session/memory-compress");

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

/** 造一条普通记录。 */
function rec(id, content, type = "stdout", event = null) {
    const record = { id, type, content, timestamp: Number(String(id).replace(/\D/g, "")) || 1 };
    if (event) {
        record.event = event;
    }
    return record;
}

/** 造 n 条 Agent step 噪声（连续的一整段）。 */
function noiseRun(n, start = 1) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(rec("n" + (start + i), "Agent step " + (start + i)));
    }
    return out;
}

// ---------------------------------------------------------------
// 档位基础语义
// ---------------------------------------------------------------

check("off 档原样返回，但给的是副本（改它不影响入参）", () => {
    const input = [rec("1", "hello"), rec("2", "world")];
    const result = compress.compressRecords(input, { level: "off" });
    assert.strictEqual(result.stats.level, "off");
    assert.strictEqual(result.records.length, 2);
    assert.strictEqual(result.stats.before.chars, result.stats.after.chars);
    result.records[0].content = "被改了";
    assert.strictEqual(input[0].content, "hello");
});

check("非法档位报错且错误码稳定", () => {
    assert.throws(
        () => compress.compressRecords([], { level: "ultra" }),
        (error) => error.code === "MEMORY_COMPRESS_INVALID"
    );
});

check("空列表不炸，统计全 0", () => {
    const result = compress.compressRecords([], { level: "strong" });
    assert.deepStrictEqual(result.records, []);
    assert.strictEqual(result.stats.before.count, 0);
    assert.strictEqual(result.stats.savedPercent, 0);
});

check("同样的输入两次压缩结果完全一致（确定性规则，不调用模型）", () => {
    const input = noiseRun(6).concat([rec("9", "x".repeat(5000))]);
    const a = compress.compressRecords(input, { level: "strong", maxChars: 500 });
    const b = compress.compressRecords(input, { level: "strong", maxChars: 500 });
    assert.deepStrictEqual(
        a.records.map((item) => item.content),
        b.records.map((item) => item.content)
    );
});

// ---------------------------------------------------------------
// light：去事件副本、截断、折叠噪声
// ---------------------------------------------------------------

check("light 去掉 event 副本（content 已经含同样信息）", () => {
    const input = [
        rec("1", "Runtime action: read {...}", "stdout", { type: "runtime.result", ok: true }),
        rec("2", "没有事件"),
    ];
    const result = compress.compressRecords(input, { level: "light" });
    assert.strictEqual(result.stats.strippedEvents, 1);
    assert.strictEqual(result.records[0].event, undefined);
    assert.strictEqual(result.records[0].content, "Runtime action: read {...}", "content 不动");
    assert.ok(result.stats.savedChars > 0, "去掉事件应体现为字符节省");
});

check("light 截断超长单条，保留头尾并写明省略多少字符", () => {
    const long = "HEAD" + "x".repeat(5000) + "TAIL";
    const input = [rec("1", long)];
    const result = compress.compressRecords(input, {
        level: "light",
        maxRecordChars: 1000,
    });
    const content = result.records[0].content;
    assert.strictEqual(result.stats.truncated, 1);
    assert.ok(content.length < long.length);
    assert.ok(content.startsWith("HEAD"), "开头保留");
    assert.ok(content.endsWith("TAIL"), "结尾保留");
    assert.ok(/省略 \d+ 字符/.test(content), "要有省略说明：" + content.slice(0, 80));
});

check("未超长的记录不被截断（不制造无意义的省略说明）", () => {
    const input = [rec("1", "短内容")];
    const result = compress.compressRecords(input, { level: "light", maxRecordChars: 1000 });
    assert.strictEqual(result.stats.truncated, 0);
    assert.strictEqual(result.records[0].content, "短内容");
});

check("light 折叠连续过程噪声，单独一条保留", () => {
    const input = [rec("1", "开工")].concat(noiseRun(5)).concat([rec("9", "结束")]);
    const result = compress.compressRecords(input, { level: "light" });
    assert.strictEqual(result.records.length, 3, "首 + 1 条噪声摘要 + 尾");
    assert.ok(/合并了 5 条过程提示 — Agent step/.test(result.records[1].content));
    assert.strictEqual(result.stats.noiseCollapsed, 5);

    const single = compress.compressRecords([rec("1", "Agent step 7")], { level: "light" });
    assert.strictEqual(single.records.length, 1, "只有一条时保留原文");
    assert.strictEqual(single.records[0].content, "Agent step 7");
});

check("噪声折叠只吃连续段，中间隔了别的记录就断开", () => {
    const input = noiseRun(2)
        .concat([rec("9", "真正的内容")])
        .concat(noiseRun(3, 10));
    const result = compress.compressRecords(input, { level: "light" });
    const contents = result.records.map((item) => item.content);
    assert.strictEqual(result.records.length, 3);
    assert.ok(/合并了 2 条/.test(contents[0]));
    assert.strictEqual(contents[1], "真正的内容");
    assert.ok(/合并了 3 条/.test(contents[2]));
});

check("light 不合并普通重复、不省略中段（强压才做）", () => {
    const input = [
        rec("1", "同样的报错"),
        rec("2", "同样的报错"),
        rec("3", "同样的报错"),
        rec("4", "尾部"),
    ];
    const result = compress.compressRecords(input, { level: "light", maxChars: 10 });
    assert.strictEqual(result.records.length, 4);
    assert.strictEqual(result.stats.mergedRuns, 0);
    assert.strictEqual(result.stats.omitted, 0);
});

// ---------------------------------------------------------------
// strong：再合并重复、按预算省略中段
// ---------------------------------------------------------------

check("strong 合并连续完全相同的记录", () => {
    const input = [rec("1", "重试中"), rec("2", "重试中"), rec("3", "重试中"), rec("4", "成功")];
    const result = compress.compressRecords(input, { level: "strong", maxChars: 100000 });
    assert.strictEqual(result.records.length, 2);
    assert.ok(/相同记录 ×3/.test(result.records[0].content));
    assert.strictEqual(result.stats.mergedRuns, 2);
});

check("strong 按预算省略中段：保留开头与结尾，中间只留一行说明", () => {
    const input = [];
    for (let i = 0; i < 10; i++) {
        input.push(rec(String(i + 1), "第 " + i + " 条：" + "x".repeat(50)));
    }
    const result = compress.compressRecords(input, {
        level: "strong",
        maxChars: 300,
        keepHead: 2,
    });
    const contents = result.records.map((item) => item.content);
    assert.ok(contents[0].startsWith("第 0 条"), "头部保留");
    assert.ok(contents[contents.length - 1].startsWith("第 9 条"), "尾部保留");
    const marker = contents.filter((item) => /省略中段/.test(item));
    assert.strictEqual(marker.length, 1, "只插一行说明");
    assert.ok(result.stats.omitted > 0);
    assert.ok(result.stats.after.chars < result.stats.before.chars);
});

check("strong 预算极小也至少留下最后一条（会话末尾决定做到哪儿了）", () => {
    const input = [];
    for (let i = 0; i < 6; i++) {
        input.push(rec(String(i + 1), "第 " + i + " 条：" + "y".repeat(100)));
    }
    const result = compress.compressRecords(input, { level: "strong", maxChars: 50, keepHead: 2 });
    const last = result.records[result.records.length - 1];
    assert.ok(last.content.startsWith("第 5 条"), "最后一条必须在：" + last.content.slice(0, 20));
});

// ---------------------------------------------------------------
// auto：按体积决定要不要压
// ---------------------------------------------------------------

check("auto 对小会话不动手（一条都不改）", () => {
    const input = [rec("1", "开工", "stdout", { type: "agent.started" }), rec("2", "结束")];
    const result = compress.compressRecords(input, { level: "auto" });
    assert.strictEqual(result.stats.level, "off");
    assert.strictEqual(result.records[0].event.type, "agent.started", "事件副本还在");
});

check("auto 超过字符预算时启用压缩", () => {
    const input = [];
    for (let i = 0; i < 20; i++) {
        input.push(
            rec(String(i + 1), "内容 " + i + " " + "z".repeat(200), "stdout", { type: "x" })
        );
    }
    const result = compress.compressRecords(input, { level: "auto", maxChars: 1000 });
    assert.notStrictEqual(result.stats.level, "off");
    assert.ok(result.stats.after.chars < result.stats.before.chars);
    assert.ok(result.stats.savedPercent > 0);
});

check("auto 条数超上限也会触发（几千条短记录同样拖慢渲染）", () => {
    const input = [];
    for (let i = 0; i < 30; i++) {
        input.push(rec(String(i + 1), "短 " + i));
    }
    const result = compress.compressRecords(input, {
        level: "auto",
        maxChars: 1000000,
        maxRecords: 10,
    });
    assert.notStrictEqual(result.stats.level, "off");
});

check("auto 在 light 就够用时不会升级到 strong（不做多余的有损操作）", () => {
    // 内容总量超预算，但去掉事件副本后就够了
    const input = [];
    for (let i = 0; i < 20; i++) {
        input.push(rec(String(i + 1), "ok " + i, "stdout", { type: "x", pad: "p".repeat(300) }));
    }
    const result = compress.compressRecords(input, { level: "auto", maxChars: 2000 });
    assert.strictEqual(result.stats.level, "light");
    assert.strictEqual(result.stats.mergedRuns, 0);
});

// ---------------------------------------------------------------
// 统计与工具函数
// ---------------------------------------------------------------

check("stats 的 before/after 与实际记录一致，节省比例可核对", () => {
    const input = noiseRun(4).concat([rec("9", "内容")]);
    const result = compress.compressRecords(input, { level: "light" });
    assert.strictEqual(result.stats.before.count, 5);
    assert.strictEqual(result.stats.after.count, result.records.length);
    assert.strictEqual(
        result.stats.after.chars,
        compress.measure(result.records).chars,
        "after 与 measure 口径一致"
    );
    const expected =
        Math.round(
            ((result.stats.before.chars - result.stats.after.chars) / result.stats.before.chars) *
                1000
        ) / 10;
    assert.strictEqual(result.stats.savedPercent, expected);
});

check("event 有循环引用时只算 content，统计不崩", () => {
    const event = { type: "loop" };
    event.self = event;
    const record = rec("1", "带环的事件", "stdout", event);
    assert.strictEqual(compress.recordChars(record), "带环的事件".length);
    const result = compress.compressRecords([record], { level: "light" });
    assert.strictEqual(result.records[0].event, undefined, "循环引用的事件同样被去掉");
});

check("humanChars 按量级给单位", () => {
    assert.strictEqual(compress.humanChars(12), "12 字符");
    assert.strictEqual(compress.humanChars(1500), "1.5K 字符");
    assert.strictEqual(compress.humanChars(2500000), "2.5M 字符");
});

check("summarize 只给转移结果要用的那几个字段", () => {
    const stats = compress.compressRecords(noiseRun(4), { level: "light" }).stats;
    const summary = compress.summarize(stats);
    assert.deepStrictEqual(Object.keys(summary).sort(), [
        "afterChars",
        "afterCount",
        "beforeChars",
        "beforeCount",
        "level",
        "savedPercent",
    ]);
    assert.strictEqual(compress.summarize(null), null);
});

check("describeCompression 给出一句可读的日志文案，off 时返回 null", () => {
    const light = compress.compressRecords(noiseRun(4), { level: "light" }).stats;
    const text = compress.describeCompression(light);
    assert.ok(/记忆压缩（light）/.test(text), text);
    assert.ok(/条 \/ .*字符 → /.test(text), text);
    const off = compress.compressRecords([rec("1", "x")], { level: "off" }).stats;
    assert.strictEqual(compress.describeCompression(off), null);
});

// ---------------------------------------------------------------

let failed = 0;
for (const { name, fn } of checks) {
    try {
        fn();
        console.log("  PASS " + name);
    } catch (error) {
        failed++;
        console.log("  FAIL " + name);
        console.log("       " + (error && error.message));
    }
}
console.log("");
if (failed) {
    console.log("test-memory-compress: " + failed + "/" + checks.length + " FAILED");
    process.exit(1);
}
console.log("test-memory-compress: " + checks.length + "/" + checks.length + " PASS");
