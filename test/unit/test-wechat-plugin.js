/**
wechat 插件的守卫逻辑单测（不碰真实微信）

被测的是「能不能发」这一层：广播词、ticket、配额、重复、dryRun，以及送给引擎的
expectTitle 是否真的等于刚校验过的会话名。引擎被整体打桩，测试里不会启动
PowerShell、不会动用户的微信窗口。

运行：node test/unit/test-wechat-plugin.js
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DRIVER_PATH = require.resolve(path.join(ROOT, "plugins/builtin/wechat/engine/driver"));
const PLUGIN_PATH = path.join(ROOT, "plugins/builtin/wechat/index.js");

let pass = 0;
let total = 0;

function check(name, fn) {
    total += 1;
    try {
        fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

async function checkAsync(name, fn) {
    total += 1;
    try {
        await fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

// ---------------------------------------------------------------- 打桩

const calls = [];

function stubDriver(result) {
    calls.push(result);
    return Promise.resolve(result);
}

let driverImpl = () => stubDriver({ ok: true, action: "status", running: true });

require.cache[DRIVER_PATH] = {
    id: DRIVER_PATH,
    filename: DRIVER_PATH,
    loaded: true,
    exports: {
        runAction(action, options) {
            calls.push({ action: action, options: options });
            return driverImpl(action, options);
        },
        materializeScript() {
            return "stub";
        },
    },
};

delete require.cache[PLUGIN_PATH];
// eslint-disable-next-line global-require
const plugin = require(PLUGIN_PATH);

function makeCtx(overrides) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wx-plugin-test-"));
    const actions = new Map();
    const storageLines = [];
    const ctx = {
        config: Object.assign(
            {
                maxSendsPer10Min: 3,
                ticketTtlSeconds: 180,
                maxMessageChars: 100,
                dryRun: false,
            },
            overrides && overrides.config
        ),
        workspace: workspace,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        // setup 期没有 fs（宿主只在动作执行期下发），这里刻意不给：
        // 插件若在 setup 闭包里用 ctx.fs 会当场炸，正是要测的坑。
        storage: {
            appendLine(name, line) {
                storageLines.push({ name: name, line: line });
            },
            readText() {
                return storageLines.map((entry) => entry.line).join("\n");
            },
            list() {
                return [];
            },
            remove() {
                return false;
            },
        },
        actions: {
            register(def) {
                actions.set(def.name, def);
            },
        },
        api: { get() {}, post() {}, put() {}, delete() {}, register() {} },
        ui: { registerPanel() {}, registerSettings() {}, registerComposerAction() {} },
        hooks: { on() {} },
        onDispose() {},
        permissions: { check: () => true, policy: () => "allow" },
        secrets: { get: () => null, getAll: () => ({}), denied: true },
    };
    plugin.setup(ctx);
    return { ctx: ctx, actions: actions, storageLines: storageLines, workspace: workspace };
}

function runAction(actions, name, attrs, node) {
    const def = actions.get(name);
    assert.ok(def, "动作 " + name + " 未注册");
    const runCtx = {
        attrs: Object.assign({}, attrs),
        fs: { resolve: (target) => path.resolve(os.tmpdir(), String(target)) },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        storage: { appendLine() {}, readText: () => "" },
        config: {},
        workspace: os.tmpdir(),
        signal: { aborted: false },
    };
    return def.run(node || {}, runCtx);
}

// ---------------------------------------------------------------- 用例

check("四个动作都注册了", () => {
    const { actions } = makeCtx();
    for (const name of ["wechat-status", "wechat-open", "wechat-send", "wechat-read"]) {
        assert.ok(actions.has(name), name + " 未注册");
    }
});

check("wechat-send 没有收件人参数（防止盲发）", () => {
    const { actions } = makeCtx();
    const attrs = actions.get("wechat-send").schema.attrs;
    assert.deepStrictEqual(Object.keys(attrs).sort(), ["path", "text"]);
});

check("群发类会话名在 validate 阶段被拒", () => {
    const { actions } = makeCtx();
    const def = actions.get("wechat-open");
    for (const bad of ["所有人", "全体成员", "群发助手", "everyone", "Broadcast"]) {
        assert.throws(() => def.validate({ "@_to": bad }), /具体会话名/, bad + " 应被拒绝");
    }
    // 不做裸 "all" 匹配：会误伤 Allen / 小 all 这类正常名字
    assert.doesNotThrow(() => def.validate({ "@_to": "文件传输助手" }));
    assert.doesNotThrow(() => def.validate({ "@_to": "Allen" }));
});

check("超长消息在 validate 阶段被拒", () => {
    const { actions } = makeCtx();
    const def = actions.get("wechat-send");
    assert.throws(() => def.validate({ "@_text": "x".repeat(101) }), /消息太长/);
    assert.doesNotThrow(() => def.validate({ "@_text": "x".repeat(100) }));
});

(async () => {
    await checkAsync("没有 open 过时 send 直接拒绝，且不会调用引擎", async () => {
        const { actions } = makeCtx();
        calls.length = 0;
        const result = await runAction(actions, "wechat-send", { text: "在吗" });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.sent, false);
        assert.match(result.error, /wechat-open/);
        assert.strictEqual(calls.length, 0, "不该调用驱动");
    });

    await checkAsync("open 校验失败时不建立发送许可", async () => {
        const { actions } = makeCtx();
        driverImpl = () =>
            stubDriver({ ok: false, action: "open", matched: false, chatTitle: "搜索聊天记录" });
        const opened = await runAction(actions, "wechat-open", { to: "张三" }, { "@_to": "张三" });
        assert.strictEqual(opened.ok, false);
        assert.strictEqual(opened.ticket.active, false);

        const sent = await runAction(actions, "wechat-send", { text: "在吗" });
        assert.strictEqual(sent.ok, false);
        assert.strictEqual(sent.sent, false);
    });

    await checkAsync("open 成功后才允许发送，且 expectTitle 等于校验过的会话名", async () => {
        const { actions } = makeCtx();
        driverImpl = (action) => {
            if (action === "open") {
                return stubDriver({
                    ok: true,
                    action: "open",
                    matched: true,
                    chatTitle: "文件传输助手",
                });
            }
            return stubDriver({
                ok: true,
                action: "send",
                chatTitle: "文件传输助手",
                verified: true,
                echoScore: 1,
            });
        };
        await runAction(actions, "wechat-open", { to: "文件传输助手" }, { "@_to": "文件传输助手" });
        calls.length = 0;
        const sent = await runAction(actions, "wechat-send", { text: "自测" });
        assert.strictEqual(sent.ok, true);
        const sendCall = calls.find((call) => call.action === "send");
        assert.strictEqual(sendCall.options.expectTitle, "文件传输助手");
    });

    await checkAsync("发送成功会写一条审计", async () => {
        const { actions, storageLines } = makeCtx();
        driverImpl = (action) =>
            stubDriver(
                action === "open"
                    ? { ok: true, action: "open", matched: true, chatTitle: "张三" }
                    : { ok: true, action: "send", chatTitle: "张三", verified: true }
            );
        await runAction(actions, "wechat-open", { to: "张三" }, { "@_to": "张三" });
        await runAction(actions, "wechat-send", { text: "好的" });
        assert.strictEqual(storageLines.length, 1);
        const entry = JSON.parse(storageLines[0].line);
        assert.strictEqual(entry.chat, "张三");
        assert.strictEqual(entry.chars, 2);
        assert.strictEqual(entry.verified, true);
    });

    await checkAsync("超过 10 分钟配额后拒发", async () => {
        const { actions } = makeCtx({ config: { maxSendsPer10Min: 2 } });
        driverImpl = (action) =>
            stubDriver(
                action === "open"
                    ? { ok: true, action: "open", matched: true, chatTitle: "张三" }
                    : { ok: true, action: "send", chatTitle: "张三", verified: true }
            );
        await runAction(actions, "wechat-open", { to: "张三" }, { "@_to": "张三" });
        await runAction(actions, "wechat-send", { text: "第一条" });
        await runAction(actions, "wechat-send", { text: "第二条" });
        const third = await runAction(actions, "wechat-send", { text: "第三条" });
        assert.strictEqual(third.ok, false);
        assert.strictEqual(third.sent, false);
        assert.match(third.error, /上限/);
        assert.ok(third.quota.resetAt, "应给出重置时间");
    });

    await checkAsync("同一段文本 2 分钟内重复发送被拒", async () => {
        const { actions } = makeCtx();
        driverImpl = (action) =>
            stubDriver(
                action === "open"
                    ? { ok: true, action: "open", matched: true, chatTitle: "张三" }
                    : { ok: true, action: "send", chatTitle: "张三", verified: true }
            );
        await runAction(actions, "wechat-open", { to: "张三" }, { "@_to": "张三" });
        const first = await runAction(actions, "wechat-send", { text: "重复内容" });
        const second = await runAction(actions, "wechat-send", { text: "重复内容" });
        assert.strictEqual(first.ok, true);
        assert.strictEqual(second.ok, false);
        assert.match(second.error, /重复/);
    });

    // 真机翻车点：Qwen 在 send 成功后又会 open 一遍，把同一句话改几个字重发。
    // 字符串相等判定拦不住（"慢点" → "慢一些"），所以按相似度判。
    await checkAsync("模型改几个字重发也被判重", async () => {
        const { actions } = makeCtx();
        driverImpl = (action) =>
            stubDriver(
                action === "open"
                    ? { ok: true, action: "open", matched: true, chatTitle: "张三" }
                    : { ok: true, action: "send", chatTitle: "张三", verified: true }
            );
        await runAction(actions, "wechat-open", { to: "张三" }, { "@_to": "张三" });
        const first = await runAction(actions, "wechat-send", {
            text: "这个是本地 agent 通过 CDP 驱动浏览器对话页，每轮要等模型回复再执行动作，所以大概十几秒到半分钟，比直接在网页聊慢点，但日常够用哈。",
        });
        const second = await runAction(actions, "wechat-send", {
            text: "这个是本地 agent 通过 CDP 驱动浏览器对话页，每轮要等模型回复再执行动作，所以一轮大概十几秒到半分钟，比直接在网页上聊慢一些，但日常够用哈。",
        });
        assert.strictEqual(first.ok, true);
        assert.strictEqual(second.ok, false, "微调措辞的重发应被拦下");
        assert.match(second.error, /相似度/);
    });

    await checkAsync("换会话后同样的文本可以正常发送", async () => {
        const { actions } = makeCtx();
        let target = "张三";
        driverImpl = (action) =>
            stubDriver(
                action === "open"
                    ? { ok: true, action: "open", matched: true, chatTitle: target }
                    : { ok: true, action: "send", chatTitle: target, verified: true }
            );
        await runAction(actions, "wechat-open", { to: "张三" }, { "@_to": "张三" });
        const first = await runAction(actions, "wechat-send", { text: "收到，我看下" });
        target = "李四";
        await runAction(actions, "wechat-open", { to: "李四" }, { "@_to": "李四" });
        const second = await runAction(actions, "wechat-send", { text: "收到，我看下" });
        assert.strictEqual(first.ok, true);
        assert.strictEqual(second.ok, true, "换了会话就不该判重");
    });

    await checkAsync("内容不同的两条消息不会被误判为重发", async () => {
        const { actions } = makeCtx();
        driverImpl = (action) =>
            stubDriver(
                action === "open"
                    ? { ok: true, action: "open", matched: true, chatTitle: "张三" }
                    : { ok: true, action: "send", chatTitle: "张三", verified: true }
            );
        await runAction(actions, "wechat-open", { to: "张三" }, { "@_to": "张三" });
        const first = await runAction(actions, "wechat-send", { text: "好的，我看下这个问题" });
        const second = await runAction(actions, "wechat-send", {
            text: "另外你那边环境是什么版本？",
        });
        assert.strictEqual(first.ok, true);
        assert.strictEqual(second.ok, true, "不相干的内容不该被相似度拦下");
    });

    await checkAsync("dryRun 只校验当前会话，不粘贴回车", async () => {
        const { actions } = makeCtx({ config: { dryRun: true } });
        driverImpl = (action) =>
            stubDriver(
                action === "open"
                    ? { ok: true, action: "open", matched: true, chatTitle: "张三" }
                    : { ok: true, action: "read", title: "张三", lines: [] }
            );
        await runAction(actions, "wechat-open", { to: "张三" }, { "@_to": "张三" });
        calls.length = 0;
        const result = await runAction(actions, "wechat-send", { text: "演练" });
        assert.strictEqual(result.dryRun, true);
        assert.strictEqual(result.sent, false);
        assert.ok(!calls.some((call) => call.action === "send"), "dryRun 不该真正发送");
    });

    await checkAsync("wechat-status 汇总配额与 ticket", async () => {
        const { actions } = makeCtx();
        driverImpl = () =>
            stubDriver({ ok: true, action: "status", running: true, foreground: true });
        const result = await runAction(actions, "wechat-status", {});
        assert.strictEqual(result.running, true);
        assert.strictEqual(result.quota.limit, 3);
        assert.strictEqual(result.quota.used, 0);
        assert.strictEqual(result.ticket.active, false);
    });

    check("元信息声明了权限、可变性与图片回传", () => {
        const { actions } = makeCtx();
        const open = actions.get("wechat-open");
        assert.deepStrictEqual(open.meta.permission, [
            "system:window",
            "system:screen",
            "workspace:write",
        ]);
        assert.strictEqual(open.meta.mutating, true);
        assert.deepStrictEqual(open.meta.collectImages({ path: "screenshots/a.png" }), [
            "screenshots/a.png",
        ]);
        const read = actions.get("wechat-read");
        assert.strictEqual(read.meta.mutating, false);
        const promptResult = open.meta.promptResult({ ok: true, chatTitle: "张三", path: "x.png" });
        assert.strictEqual(promptResult.path, undefined, "回给模型的结果不该带路径");
    });

    console.log("");
    console.log("Total: " + pass + "/" + total);
    if (pass !== total) {
        process.exit(1);
    }
})();
