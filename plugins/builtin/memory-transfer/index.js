/**
内置插件：memory-transfer（action + api + 声明式面板）

做一件事：把一个会话的记忆转到另一个会话 id 上。
"记忆"分两层 —— 过程记录（output/task）与模型对话线程（conversationId），
组合方式见 webui/session/memory-transfer.js 的 mode 说明。

为什么做成插件而不是内置动作：
- 它读写的不是 workspace，而是用户主目录下的会话存储，属于可选能力：
  不需要的人可以在 Plugins 面板关掉，关掉后模型也看不到这个动作；
- 权限单独成 sessions:read / sessions:write 两档，装到别人的机器上时会被要求授权。

模型侧只有一条动作：
    <memory-transfer from="aaa" to="bbb" mode="full"/>
目标会话不存在时按源的 workspace/provider 自动新建（状态为已完成，不会自动开跑）。
*/

const MODES = ["full", "records", "link"];

const MODE_HINTS = {
    full: "记录与模型上下文都搬",
    records: "只搬记录，模型从新对话开始",
    link: "只接续模型上下文",
};

/** 给模型看的精简视图：完整结果在 Trace / 报告里，这里只留判断下一步要用的字段。 */
function promptView(result) {
    return {
        ok: result.ok,
        from: result.from,
        to: result.to,
        mode: result.mode,
        created: result.created,
        copied: result.copied,
        warnings: result.warnings,
        target: result.target
            ? {
                  id: result.target.id,
                  outputCount: result.target.outputCount,
                  hasConversation: result.target.hasConversation,
              }
            : null,
        error: result.error,
    };
}

const ACTION = {
    name: "memory-transfer",
    schema: {
        attrs: {
            from: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
            to: { type: "string", required: true, nonEmpty: true, maxLength: 128 },
            mode: { type: "string", default: "full", enum: MODES },
        },
    },
    async run(node, ctx) {
        const attrs = ctx.attrs;
        try {
            const result = ctx.sessions.transfer({
                from: attrs.from,
                to: attrs.to,
                mode: attrs.mode,
            });
            return Object.assign({ action: "memory-transfer" }, result);
        } catch (error) {
            return {
                ok: false,
                action: "memory-transfer",
                from: attrs.from,
                to: attrs.to,
                mode: attrs.mode,
                code: (error && error.code) || null,
                error: (error && error.message) || String(error),
            };
        }
    },
    meta: {
        prompt: {
            group: "session",
            usage: '<memory-transfer from="aaa" to="bbb" mode="full"/>',
            note:
                "把一个会话的记忆转到另一个会话 id。mode=full 连过程记录和模型对话线程一起搬，" +
                "records 只搬记录，link 只接续模型上下文。目标会话不存在时会按源会话的 workspace/provider " +
                "自动新建（不会自动开始运行）；目标正在运行时会被拒绝。两个会话会共用同一条 provider " +
                "对话线程，之后在任一边继续聊都会影响另一边。",
            priority: 40,
        },
        permission: ["sessions:read", "sessions:write"],
        mutating: true,
        timeoutMs: 15000,
        summary: (result) => "memory-transfer " + (result.from || "?") + " → " + (result.to || "?"),
        promptResult: promptView,
    },
};

function setup(ctx) {
    const maxRecords = Number(ctx.config && ctx.config.maxOutputRecords);
    ctx.logger.info(
        "会话记忆转移已启用（单次最多 " +
            (maxRecords > 0 ? maxRecords : 2000) +
            " 条记录，模式：" +
            MODES.map((mode) => mode + "=" + MODE_HINTS[mode]).join(" / ") +
            "）"
    );

    ctx.actions.register(ACTION);

    /**
    列会话：面板表格与接口共用。
    只返回摘要（不含 output 正文），否则一个有上万条输出的会话就能把面板拖死。
    */
    ctx.api.get("/sessions", (request) => {
        const limit = Number(request.query && request.query.limit);
        const sessions = request.sessions.list(Number.isFinite(limit) && limit > 0 ? limit : 20);
        return { total: sessions.length, sessions };
    });

    /**
    转移接口：给前端 / 脚本用，与动作走同一份实现（ctx.sessions.transfer）。
    body: { from, to, mode }
    */
    ctx.api.post("/transfer", (request) => {
        const body = request.body && typeof request.body === "object" ? request.body : {};
        try {
            const result = request.sessions.transfer({
                from: body.from,
                to: body.to,
                mode: body.mode,
            });
            return { ok: true, result };
        } catch (error) {
            return {
                ok: false,
                code: (error && error.code) || null,
                error: (error && error.message) || String(error),
            };
        }
    });

    ctx.ui.registerPanel({
        id: "memory-transfer",
        title: "Memory Transfer",
        description: "把一个会话的记忆（记录 + 模型对话线程）转到另一个会话",
        blocks: [
            {
                kind: "status",
                title: "Sessions",
                path: "/sessions",
                items: [
                    { label: "Listed", value: "total" },
                    { label: "Latest", value: "sessions.0.id" },
                    { label: "Latest records", value: "sessions.0.outputCount" },
                ],
            },
            {
                kind: "table",
                title: "Recent sessions",
                path: "/sessions",
                rows: "sessions",
                columns: [
                    { key: "id", label: "Session" },
                    { key: "provider", label: "Provider" },
                    { key: "outputCount", label: "Records" },
                    { key: "hasConversation", label: "Thread" },
                    { key: "task", label: "Task" },
                ],
                empty: "No sessions yet — run a task first.",
            },
            {
                kind: "note",
                text:
                    '用法：对话里让模型调用 <memory-transfer from="aaa" to="bbb" mode="full"/>，' +
                    '或 POST /api/plugins/memory-transfer/api/transfer {"from":"aaa","to":"bbb","mode":"full"}。' +
                    "full=记录+模型上下文，records=只搬记录，link=只接续模型上下文。",
            },
        ],
    });
}

module.exports = {
    setup,
};
