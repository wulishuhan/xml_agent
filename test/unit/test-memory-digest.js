/**
 * 会话摘要（memory-digest）的单元测试
 *
 * 摘要要解决的是"模型拿不到历史"这件事，所以考试重点只有两个：
 * 1. 能不能从流水账里挑出有用的东西（改过哪些文件、跑了什么命令、报了什么错）；
 * 2. 挑出来之后是不是一页纸（字符预算、确定性、无内容时不说假话）。
 *
 * 全部用内存里造的记录，不读真实会话目录。
 */

const assert = require("assert");

const digest = require("../../webui/session/memory-digest");

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

/** 造一条运行时结果记录：content 是给人看的渲染，event 是原始对象。 */
function call(index, action, result) {
    return {
        id: "c" + index,
        type: "stdout",
        content: "Runtime action: " + action,
        timestamp: 1700000000000 + index * 1000,
        event: { type: "runtime.result", action: action, result: result },
    };
}

function text(index, content, timestamp) {
    return {
        id: "t" + index,
        type: "stdout",
        content: content,
        timestamp: timestamp || 1700000000000,
    };
}

const INFO = {
    id: "aaa",
    provider: "deepseek",
    workspace: "D:\\ws",
    task: "写完第 3 章",
    status: "completed",
    createdAt: 1700000000000,
    startedAt: 1700000000000,
    finishedAt: 1700000005000,
    runCount: 2,
};

function sample() {
    return [
        call(1, "read", {
            ok: true,
            action: "read",
            path: "src/outline.md",
            type: "file",
            content: "...",
        }),
        call(2, "read", {
            ok: true,
            action: "read",
            path: "src/outline.md",
            type: "file",
            content: "...",
        }),
        call(3, "write", { ok: true, action: "write", path: "src/ch3.md" }),
        call(4, "exec", {
            ok: false,
            action: "exec",
            command: "cmd /c chcp 65001 >nul && npm test",
            exitCode: 1,
            stderr: "boom",
        }),
        call(5, "read", {
            ok: false,
            action: "read",
            path: "src/missing.js",
            error: "File or directory does not exist",
        }),
        text(6, "Agent completed with status: done"),
    ];
}

// ---------------------------------------------------------------
// 内容提取
// ---------------------------------------------------------------

check("改过的文件、读过的文件、命令、报错都被提炼出来", () => {
    const result = digest.buildDigest(sample(), { from: "aaa", to: "bbb", info: INFO });
    const md = result.markdown;
    assert.ok(/## 改过的文件（1）/.test(md), md);
    assert.ok(/`src\/ch3\.md`/.test(md), "写过的文件要在列表里");
    assert.ok(
        /## 读过的文件或目录（1）/.test(md),
        "同一个文件读两次只算一个条目，失败的 read 不算"
    );
    assert.ok(/`src\/outline\.md` ×2/.test(md), "读的次数要标出来");
    assert.ok(/## 执行过的命令（1）/.test(md), md);
    assert.ok(/## 报错（2）/.test(md), md);
    assert.ok(/src\/missing\.js/.test(md), "失败的 read 要出现在报错里");
});

check("命令剥掉每次都一样的壳，只留真正在跑的东西", () => {
    const result = digest.buildDigest(sample(), { from: "aaa", to: "bbb", info: INFO });
    assert.ok(/`npm test` ×1/.test(result.markdown), result.markdown);
    assert.ok(!/chcp 65001/.test(result.markdown), "不该把 chcp 前缀写进摘要");
    assert.ok(/其中 1 次失败/.test(result.markdown) || /退出码 1/.test(result.markdown));
});

check("exec 报错同样剥壳：不把 Command failed / cmd /c chcp 重复写几十遍", () => {
    const records = [
        call(1, "exec", {
            ok: false,
            action: "exec",
            command: "cmd /c chcp 65001 >nul && node diag.js",
            error: "Command failed: cmd /c chcp 65001 >nul && node diag.js SyntaxError: boom",
            exitCode: 1,
        }),
    ];
    const md = digest.buildDigest(records, { from: "aaa", to: "bbb", info: INFO }).markdown;
    assert.ok(!/Command failed/.test(md), "Command failed 没有信息量：" + md);
    assert.ok(!/chcp 65001/.test(md), md);
    assert.ok(/exec：node diag\.js SyntaxError: boom/.test(md), md);
});

check("时间取记录本身的跨度，而不是会话文件时间（后者被重写就会漂移）", () => {
    const first = 1700000000000;
    const last = 1700003600000;
    const records = [text(1, "开始干活", first), text(2, "收工", last)];
    // 会话文件的 createdAt 比真实运行时间晚了快 27 小时（迁移/重写后的典型情况）
    const info = Object.assign({}, INFO, {
        createdAt: first + 97200000,
        startedAt: null,
        finishedAt: null,
    });
    const md = digest.buildDigest(records, { from: "aaa", to: "bbb", info }).markdown;
    const expected =
        "- 时间：" + digest.formatTime(first) + " → " + digest.formatTime(last) + "（按记录时间）";
    assert.ok(md.includes(expected), "期望 " + expected + "，实际：" + md);
    assert.ok(!md.includes(digest.formatTime(info.createdAt)), "不该拿 createdAt 冒充运行时间");
});

check("任务原话与会话状态进摘要（接手的人先要知道在做什么）", () => {
    const result = digest.buildDigest(sample(), { from: "aaa", to: "bbb", info: INFO });
    assert.ok(/## 任务\n\n写完第 3 章/.test(result.markdown), result.markdown);
    assert.ok(/provider：deepseek/.test(result.markdown));
    assert.ok(/工作区：`D:\\ws`/.test(result.markdown));
    assert.ok(/状态：completed，运行 2 次/.test(result.markdown));
});

check("结尾说明这是摘要，并指向原会话", () => {
    const result = digest.buildDigest(sample(), { from: "aaa", to: "bbb", info: INFO });
    assert.ok(/以上是摘要，不是完整记录/.test(result.markdown));
    assert.ok(/会话 `aaa`/.test(result.markdown));
    assert.ok(/转到 `bbb`/.test(result.markdown));
});

check("尾部只留关键行，过程噪声与相邻重复被跳过", () => {
    const records = [
        text(1, "Provider request (step 1)"),
        text(2, "真正的内容"),
        text(3, "Agent stopped by user"),
        text(4, "Agent stopped by user"),
    ];
    const result = digest.buildDigest(records, { from: "aaa", to: "bbb", info: INFO });
    const tail = result.markdown.split("## 最后几个动作")[1] || "";
    assert.ok(/真正的内容/.test(tail));
    assert.ok(!/Provider request/.test(tail), "噪声不该出现在尾部");
    assert.strictEqual(tail.split("Agent stopped by user").length - 1, 1, "相邻重复只留一条");
});

check("尾部把动作写成「做了什么」，而不是一串 JSON", () => {
    const records = [
        call(1, "write", { ok: true, action: "write", path: "src/ch3.md" }),
        call(2, "read", {
            ok: false,
            action: "read",
            path: "src/missing.js",
            error: "File or directory does not exist",
        }),
        call(3, "exec", {
            ok: false,
            action: "exec",
            command: "cmd /c chcp 65001 >nul && npm test",
            exitCode: 1,
        }),
        call(4, "answer", { ok: true, action: "answer", content: "第 3 章写完了，等你确认" }),
        text(5, "Agent stopped by user"),
    ];
    const md = digest.buildDigest(records, { from: "aaa", to: "bbb", info: INFO }).markdown;
    const tail = md.split("## 最后几个动作")[1] || "";
    assert.ok(/write src\/ch3\.md/.test(tail), tail);
    assert.ok(/✗ read src\/missing\.js/.test(tail), "失败的动作要标出来：" + tail);
    assert.ok(/✗ exec npm test（退出码 1）/.test(tail), tail);
    assert.ok(/answer 第 3 章写完了/.test(tail), tail);
    assert.ok(/Agent stopped by user/.test(tail), "结束状态往往是最关键的一行：" + tail);
    assert.ok(!/"ok":/.test(tail), "不该把 JSON 原样写进摘要：" + tail);
});

check("列表被裁短时说明还有多少没列（标题数字与正文条数不能对不上）", () => {
    const records = [];
    for (let i = 0; i < 60; i++) {
        records.push(call(i, "write", { ok: true, action: "write", path: "src/f" + i + ".md" }));
    }
    const md = digest.buildDigest(records, { from: "aaa", to: "bbb", info: INFO }).markdown;
    assert.ok(/## 改过的文件（60）/.test(md), md);
    assert.ok(/另有 20 个文件未列出/.test(md), "列 40 条却说 60 个，必须交代剩下 20：" + md);
});

check("报错标题按去重后的条数写", () => {
    const records = [1, 2, 3].map((i) =>
        call(i, "read", {
            ok: false,
            action: "read",
            path: "src/missing.js",
            error: "File or directory does not exist",
        })
    );
    const md = digest.buildDigest(records, { from: "aaa", to: "bbb", info: INFO }).markdown;
    assert.ok(/## 报错（1）/.test(md), "三条同样的报错去重后只剩一条：" + md);
});

check("没有 event 的老记录也能贡献报错（文本兜底）", () => {
    const records = [
        { id: "old", type: "stderr", content: "exec: Command failed: npm run build", timestamp: 1 },
    ];
    const result = digest.buildDigest(records, { from: "aaa", to: "bbb", info: INFO });
    assert.ok(/报错（1）/.test(result.markdown), result.markdown);
    assert.ok(/Command failed/.test(result.markdown));
});

check("只预览（没给目标）时不会写成「从 aaa 转到 aaa」", () => {
    const same = digest.buildDigest(sample(), { from: "aaa", to: "aaa", info: INFO });
    assert.ok(/^> 会话 `aaa` ·/.test(same.markdown.split("\n")[2]), same.markdown.split("\n")[2]);
    const moved = digest.buildDigest(sample(), { from: "aaa", to: "bbb", info: INFO });
    assert.ok(/^> 从会话 `aaa` 转到 `bbb` ·/.test(moved.markdown.split("\n")[2]));
});

check("源会话没有任务描述时如实说明，不编造", () => {
    const result = digest.buildDigest([], {
        from: "aaa",
        to: "bbb",
        info: { workspace: "D:\\ws" },
    });
    assert.ok(/源会话没有记录任务描述/.test(result.markdown));
});

// ---------------------------------------------------------------
// 预算与确定性
// ---------------------------------------------------------------

check("字符预算生效：列表被裁短，整体不超过预算太多", () => {
    const records = [];
    for (let i = 0; i < 200; i++) {
        records.push(
            call(i, "write", { ok: true, action: "write", path: "src/file-" + i + ".js" })
        );
    }
    const small = digest.buildDigest(records, {
        from: "aaa",
        to: "bbb",
        info: INFO,
        maxChars: 1200,
    });
    assert.ok(small.chars <= 1200 + 40, "应在预算附近：" + small.chars);
    assert.ok(/改过的文件（200）/.test(small.markdown), "总数要保留，只是列表变短");
});

check("同样的输入两次生成完全一样（确定性，便于 diff 与复现）", () => {
    const a = digest.buildDigest(sample(), {
        from: "aaa",
        to: "bbb",
        info: INFO,
        now: 1700000123000,
    });
    const b = digest.buildDigest(sample(), {
        from: "aaa",
        to: "bbb",
        info: INFO,
        now: 1700000123000,
    });
    assert.strictEqual(a.markdown, b.markdown);
});

check("统计字段与实际内容一致", () => {
    const result = digest.buildDigest(sample(), { from: "aaa", to: "bbb", info: INFO });
    assert.strictEqual(result.calls, 5, "5 次 runtime.result");
    assert.strictEqual(result.files, 2, "只算成功的路径：outline.md 与 ch3.md");
    assert.strictEqual(result.commands, 1);
    assert.strictEqual(result.errors, 2);
    assert.strictEqual(result.chars, result.markdown.length);
});

check("摘要比原始记录小一个数量级（这才是它存在的理由）", () => {
    const records = [];
    for (let i = 0; i < 300; i++) {
        records.push(
            call(i, "read", {
                ok: true,
                action: "read",
                path: "src/f" + (i % 20) + ".js",
                content: "x".repeat(500),
            })
        );
    }
    const result = digest.buildDigest(records, { from: "aaa", to: "bbb", info: INFO });
    const rawChars = records.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
    assert.ok(result.chars < 8000, "摘要应在 8000 字符以内：" + result.chars);
    assert.ok(result.chars * 10 < rawChars, "至少小一个数量级");
});

// ---------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------

check("formatTime 输出本地时间，非法值返回 null", () => {
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(digest.formatTime(1700000000000)));
    assert.strictEqual(digest.formatTime(0), null);
    assert.strictEqual(digest.formatTime("abc"), null);
});

check("digestPath 固定落在工作区隐藏目录下", () => {
    assert.strictEqual(digest.digestPath("bbb"), ".xml-agent-memory/bbb.md");
    assert.strictEqual(digest.digestPath(""), ".xml-agent-memory/unknown.md");
});

check("oneLine 把多行压成一行并截断", () => {
    assert.strictEqual(digest.oneLine("a\n\nb   c"), "a b c");
    assert.ok(digest.oneLine("x".repeat(300), 20).length <= 21);
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
    console.log("test-memory-digest: " + failed + "/" + checks.length + " FAILED");
    process.exit(1);
}
console.log("test-memory-digest: " + checks.length + "/" + checks.length + " PASS");
