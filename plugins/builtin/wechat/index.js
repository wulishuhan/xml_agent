/**
内置插件：wechat（微信桌面版）

能力（四个动作）：
- wechat-status  微信是否在跑、当前是否在前台、剩余发送额度
- wechat-open    搜索并打开一个会话，用 OCR 读出会话标题校验「到底打开的是谁」
- wechat-send    给「当前已校验过的会话」发一条文本
- wechat-read    把当前会话可见的消息 OCR 成文本（同时可存一张截图）

设计上的取舍（重要，别看代码猜）：

1. **为什么没有 `to` 参数**：WeChat 4.x 是 Qt 应用，UIA 只暴露 1 个节点，没有可用的
   无障碍树。搜索下拉里同一个名字会出现「会话」「搜索聊天记录」「打开」「怎么恢复
   历史记录」等多个条目，点错一条就会落到别的会话上。所以发送拆成两步：先 open
   并校验标题，再 send 到「当前这个会话」。send 不接受收件人，也就没法盲发。
2. **为什么发送前要再 OCR 一次标题**：open 之后用户可能在 GUI 里自己切了会话，
   或者搜索下拉自己变了。send 会把 ticket 里的标题传给引擎，标题对不上就一条都不发。
3. **配额**：默认 10 分钟 5 条（硬上限 30），同会话 2 分钟内内容高度相似（≥0.8）
   的第二次发送直接拒绝。这是给「跑飞的模型」准备的刹车，不是给你正常使用的限制：
   实测模型会在 send 成功后又 open 一遍、把同一句话改几个字再发一次。
4. **审计**：每次发送写一行到插件私有目录（sends.jsonl），面板里能翻到最近记录。
   聊天内容本身不进日志，只记会话名、字数与是否回读到。
*/

const fs = require("fs");
const path = require("path");

const { runAction } = require("./engine/driver");

const SEND_WINDOW_MS = 10 * 60 * 1000;
// 模型重发时几乎不会一字不改，实测是「慢点」改成「慢一些」这种微调，
// 所以判重窗口放到 2 分钟、并用相似度而不是字符串相等。
const DUPLICATE_WINDOW_MS = 120 * 1000;
const DUPLICATE_SIMILARITY = 0.8;
const SEND_LOG = "sends.jsonl";
const RECENT_LIMIT = 10;

// 群发/遍历联系人的写法直接拒绝：这个插件只做「一次一个会话」。
const BROADCAST_WORDS = ["所有人", "全体", "全部", "所有", "群发", "everyone", "broadcast"];

function clockOf(ms) {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * 相似度 = 多重集字符重合数 / 较长者长度（顺序无关）。
 * 与 ps1 里回读打分的 Get-Coverage 同一口径：模型重发时只改几个字，
 * 用字符串相等判定必然漏，用编辑距离又太重，字符覆盖够用。
 */
function similarity(a, b) {
    const norm = (value) =>
        String(value || "")
            .replace(/\s+/g, "")
            .toLowerCase();
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) {
        return x === y ? 1 : 0;
    }
    const pool = new Map();
    for (const ch of y) {
        pool.set(ch, (pool.get(ch) || 0) + 1);
    }
    let hit = 0;
    for (const ch of x) {
        const left = pool.get(ch) || 0;
        if (left > 0) {
            hit += 1;
            pool.set(ch, left - 1);
        }
    }
    return hit / Math.max(x.length, y.length);
}

function clampInt(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(num)));
}

function readSendLog(storage) {
    let text = "";
    try {
        text = storage.readText(SEND_LOG, "");
    } catch (error) {
        return [];
    }
    const rows = [];
    for (const line of String(text).split("\n")) {
        if (!line.trim()) {
            continue;
        }
        try {
            rows.push(JSON.parse(line));
        } catch (error) {
            // 坏行跳过：日志不该让面板或配额失效
        }
    }
    return rows;
}

function setup(ctx) {
    const config = ctx.config || {};
    const maxSends = clampInt(config.maxSendsPer10Min, 5, 1, 30);
    const ticketTtlMs = clampInt(config.ticketTtlSeconds, 180, 30, 1800) * 1000;
    const maxChars = clampInt(config.maxMessageChars, 1500, 50, 4000);
    const dryRun = config.dryRun === true;

    // ticket：最近一次校验通过的会话。send 只认它，不认模型说的名字。
    const state = { ticket: null };
    const history = readSendLog(ctx.storage);
    const state2 = {
        sends: history
            .map((row) => Date.parse(row.ts))
            .filter((ts) => Number.isFinite(ts))
            .slice(-50),
    };

    function recentSends(now) {
        return state2.sends.filter((ts) => now - ts < SEND_WINDOW_MS);
    }

    function quotaSnapshot() {
        const now = Date.now();
        const used = recentSends(now);
        const oldest = used.length > 0 ? Math.min.apply(null, used) : 0;
        return {
            used: used.length,
            limit: maxSends,
            windowMinutes: SEND_WINDOW_MS / 60000,
            resetAt: used.length >= maxSends ? clockOf(oldest + SEND_WINDOW_MS) : null,
        };
    }

    function ticketSnapshot() {
        if (!state.ticket) {
            return { active: false, title: null, expiresInSeconds: 0 };
        }
        const age = Date.now() - state.ticket.at;
        const left = Math.max(0, ticketTtlMs - age);
        return {
            active: left > 0,
            title: state.ticket.title,
            expiresInSeconds: Math.round(left / 1000),
        };
    }

    // fs 只在动作执行期下发（setup 期没有），所以这里必须用 run 的 ctx
    function screenshotPath(runCtx, target, fallback) {
        const relative = String(target || fallback);
        const absolute = runCtx.fs.resolve(relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        return { relative: relative.split(path.sep).join("/"), absolute: absolute };
    }

    // ------------------------------------------------------------ actions

    ctx.actions.register({
        name: "wechat-status",
        schema: { attrs: {} },
        async run() {
            const result = await runAction("status", { timeoutMs: 20000 });
            return Object.assign({}, result, {
                action: "wechat-status",
                quota: quotaSnapshot(),
                ticket: ticketSnapshot(),
            });
        },
        meta: {
            prompt: {
                group: "wechat",
                usage: "<wechat-status/>",
                note: "查微信客户端是否在跑、当前是否在前台，以及还剩多少发送额度。",
                priority: 60,
            },
            permission: ["system:window"],
            mutating: false,
            timeoutMs: 30000,
            summary: (result) => "wechat-status " + (result.running ? "running" : "not running"),
        },
    });

    ctx.actions.register({
        name: "wechat-open",
        schema: {
            attrs: {
                to: { type: "string", required: true, nonEmpty: true, maxLength: 64 },
                path: { type: "string", maxLength: 200 },
            },
        },
        validate(node) {
            const to = String(node["@_to"] || "").trim();
            const lower = to.toLowerCase();
            for (const word of BROADCAST_WORDS) {
                if (lower.indexOf(word) >= 0) {
                    throw new Error(
                        "wechat-open 只接受一个具体会话名，不能是「" + to + "」这种群发/遍历写法"
                    );
                }
            }
        },
        async run(node, runCtx) {
            const to = String(runCtx.attrs.to || "").trim();
            const shot = screenshotPath(runCtx, runCtx.attrs.path, "screenshots/wechat-open.png");
            const result = await runAction("open", {
                payload: to,
                outPng: shot.absolute,
                timeoutMs: 90000,
            });

            if (result.ok && result.matched) {
                state.ticket = { title: result.chatTitle || to, at: Date.now() };
                ctx.logger.info("已打开会话：" + state.ticket.title);
            } else if (result.ok === false) {
                state.ticket = null;
            }

            return Object.assign({}, result, {
                action: "wechat-open",
                target: to,
                path: result.path ? shot.relative : null,
                ticket: ticketSnapshot(),
            });
        },
        meta: {
            prompt: {
                group: "wechat",
                usage: '<wechat-open to="文件传输助手"/>',
                note:
                    "在微信里搜索并打开一个会话（人/群）。成功后会读出会话标题校验，" +
                    "标题对不上就返回 ok=false 且不会建立发送许可。发消息前必须先 open。",
                priority: 95,
            },
            permission: ["system:window", "system:screen", "workspace:write"],
            mutating: true,
            timeoutMs: 100000,
            summary: (result) =>
                "wechat-open " + (result.target || "") + " -> " + (result.chatTitle || "-"),
            collectImages: (result) => (result.path ? [result.path] : []),
            promptResult: (result) => ({
                ok: result.ok,
                action: result.action,
                target: result.target,
                chatTitle: result.chatTitle,
                matched: result.matched,
                error: result.error,
                ticket: result.ticket,
            }),
        },
    });

    ctx.actions.register({
        name: "wechat-send",
        schema: {
            attrs: {
                text: { type: "string", required: true, nonEmpty: true },
                path: { type: "string", maxLength: 200 },
            },
        },
        validate(node) {
            const text = String(node["@_text"] || "");
            if (text.length > maxChars) {
                throw new Error(
                    "消息太长（" +
                        text.length +
                        " 字符），上限 " +
                        maxChars +
                        "；请拆成几条或改用 wechat-open 后人工发送"
                );
            }
        },
        async run(node, runCtx) {
            const text = String(runCtx.attrs.text || "");
            const ticket = ticketSnapshot();

            if (!ticket.active) {
                return {
                    ok: false,
                    action: "wechat-send",
                    sent: false,
                    error: "还没有打开并校验过会话（或已过期）。先调用 wechat-open 打开目标会话，再发送。",
                };
            }

            const quota = quotaSnapshot();
            if (quota.used >= quota.limit) {
                return {
                    ok: false,
                    action: "wechat-send",
                    sent: false,
                    error:
                        "10 分钟内已发送 " +
                        quota.used +
                        " 条，达到上限 " +
                        quota.limit +
                        "（" +
                        quota.resetAt +
                        " 重置）。这条没有发出。",
                    quota: quota,
                };
            }

            const now = Date.now();
            // 只看同会话最近 3 条：换会话后说同样的「收到」是正常的。
            // 模型实测会把同一句话改几个字重发（慢点→慢一些），所以按相似度判。
            const duplicate = history
                .slice(-3)
                .reverse()
                .find(
                    (item) =>
                        item &&
                        item.chat === ticket.title &&
                        Number.isFinite(Date.parse(item.ts)) &&
                        now - Date.parse(item.ts) < DUPLICATE_WINDOW_MS &&
                        // 审计日志只留 80 字，比较时把新文本截到同样长度，
                        // 否则长消息重发会被长度差拉低相似度而漏判。
                        similarity(item.text, text.slice(0, item.text.length)) >=
                            DUPLICATE_SIMILARITY
                );
            if (duplicate) {
                return {
                    ok: false,
                    action: "wechat-send",
                    sent: false,
                    error:
                        "这段内容 " +
                        Math.round(DUPLICATE_WINDOW_MS / 1000) +
                        " 秒内已经发过一次（相似度 " +
                        similarity(duplicate.text, text).toFixed(2) +
                        "），疑似重复触发；这次没有发。",
                };
            }

            if (dryRun) {
                // 只确认「当前会话还是不是那个会话」，不粘贴、不回车
                const probe = await runAction("read", { timeoutMs: 45000 });
                return {
                    ok: probe.ok === true,
                    action: "wechat-send",
                    sent: false,
                    dryRun: true,
                    chatTitle: probe.title,
                    error: probe.ok ? null : probe.error,
                };
            }

            const shot = screenshotPath(runCtx, runCtx.attrs.path, "screenshots/wechat-send.png");
            const result = await runAction("send", {
                payload: text,
                expectTitle: ticket.title,
                outPng: shot.absolute,
                timeoutMs: 60000,
            });

            if (result.ok && result.chatTitle) {
                const entry = {
                    ts: new Date().toISOString(),
                    chat: result.chatTitle,
                    chars: text.length,
                    text: text.slice(0, 80),
                    verified: result.verified === true,
                };
                history.push(entry);
                if (history.length > 200) {
                    history.shift();
                }
                state2.sends.push(Date.now());
                try {
                    ctx.storage.appendLine(SEND_LOG, JSON.stringify(entry));
                } catch (error) {
                    ctx.logger.warn("发送记录写入失败：" + error.message);
                }
                ctx.logger.info(
                    "已发送到 " +
                        result.chatTitle +
                        "（" +
                        text.length +
                        " 字符，回读校验 " +
                        (result.verified ? "通过" : "未通过") +
                        "）"
                );
            }

            return Object.assign({}, result, {
                action: "wechat-send",
                chat: result.chatTitle || ticket.title,
                quota: quotaSnapshot(),
                path: result.path ? shot.relative : null,
            });
        },
        meta: {
            prompt: {
                group: "wechat",
                usage: '<wechat-send text="收到，我晚点回你"/>',
                note:
                    "给「当前已用 wechat-open 校验过」的会话发一条文本。没有 to 参数——" +
                    "要换人先 open。默认 10 分钟最多 5 条，重复内容会被拒。",
                priority: 90,
            },
            permission: ["system:window", "system:screen", "workspace:write"],
            mutating: true,
            timeoutMs: 70000,
            summary: (result) =>
                "wechat-send " + (result.chat || "-") + (result.sent === false ? " (refused)" : ""),
            collectImages: (result) => (result.path ? [result.path] : []),
        },
    });

    ctx.actions.register({
        name: "wechat-read",
        schema: {
            attrs: {
                path: { type: "string", maxLength: 200 },
            },
        },
        async run(node, runCtx) {
            const shot = screenshotPath(runCtx, runCtx.attrs.path, "screenshots/wechat-read.png");
            const result = await runAction("read", { outPng: shot.absolute, timeoutMs: 45000 });
            return Object.assign({}, result, {
                action: "wechat-read",
                count: Array.isArray(result.lines) ? result.lines.length : 0,
                path: result.path ? shot.relative : null,
            });
        },
        meta: {
            prompt: {
                group: "wechat",
                usage: '<wechat-read path="screenshots/wechat.png"/>',
                note:
                    "读当前会话：把可见消息 OCR 成文本（有噪声，只适合看个大概），" +
                    "同时存一张窗口截图，截图会随动作一起给你。",
                priority: 70,
            },
            permission: ["system:window", "system:screen", "workspace:write"],
            mutating: false,
            timeoutMs: 60000,
            summary: (result) => "wechat-read " + (result.count || 0) + " lines",
            collectImages: (result) => (result.path ? [result.path] : []),
        },
    });

    // ------------------------------------------------------------ panel + api

    ctx.api.get("/summary", () => ({
        quota: quotaSnapshot(),
        ticket: ticketSnapshot(),
        dryRun: dryRun,
        recent: history.slice(-RECENT_LIMIT).reverse(),
    }));

    ctx.ui.registerPanel({
        id: "wechat",
        title: "WeChat",
        description: "发送额度、当前会话与最近的发送记录",
        blocks: [
            {
                kind: "status",
                title: "Overview",
                path: "/summary",
                items: [
                    { label: "Sent (10 min)", value: "quota.used" },
                    { label: "Limit", value: "quota.limit" },
                    { label: "Current chat", value: "ticket.title" },
                    { label: "Ticket expires in", value: "ticket.expiresInSeconds" },
                ],
            },
            {
                kind: "table",
                title: "Recent sends",
                path: "/summary",
                rows: "recent",
                columns: [
                    { key: "ts", label: "Time" },
                    { key: "chat", label: "Chat" },
                    { key: "chars", label: "Chars" },
                    { key: "verified", label: "Verified" },
                ],
                empty: "还没有发送记录。",
            },
            {
                kind: "note",
                text:
                    "发送必须两步：先 wechat-open 打开会话（会用 OCR 校验标题），再 wechat-send。" +
                    "send 没有收件人参数，只会发到当前已校验的会话；标题对不上时一条都不发。" +
                    "配额 " +
                    maxSends +
                    " 条 / 10 分钟，可在插件配置里调整（上限 30）。" +
                    (dryRun ? " 当前是 dryRun 模式：只校验不发送。" : ""),
            },
        ],
    });
}

module.exports = {
    setup,
};
