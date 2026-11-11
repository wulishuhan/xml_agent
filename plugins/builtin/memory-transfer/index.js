/**
 * 内置插件：memory-transfer（action + api + 声明式面板）
 *
 * 做一件事：把一个会话的记忆压缩后转到另一个会话 id 上。
 * "记忆"分两层 —— 过程记录（output/task）与模型对话线程（conversationId），
 * 组合方式见 webui/session/memory-transfer.js 的 mode 说明；压缩规则见
 * webui/session/memory-compress.js 的档位说明。
 *
 * 为什么做成插件而不是内置动作：
 * - 它读写的不是 workspace，而是用户主目录下的会话存储，属于可选能力：
 *   不需要的人可以在 Plugins 面板关掉，关掉后模型也看不到这个动作；
 * - 权限单独成 sessions:read / sessions:write 两档，装到别人的机器上时会被要求授权。
 *
 * 模型侧只有一条动作：
 *     <memory-transfer from="aaa" to="bbb" mode="full" compress="auto"/>
 * 目标会话不存在时按源的 workspace/provider 自动新建（状态为已完成，不会自动开跑）。
 * compress 不传时用插件配置里的默认档位（默认 auto：只有超预算才压）。
 */

const MODES = ["full", "records", "link", "digest"];

const MODE_HINTS = {
    full: "记录与模型上下文都搬",
    records: "只搬记录，模型从新对话开始",
    link: "只接续模型上下文",
    digest: "只带任务与一页摘要（上下文满了换会话用这个）",
};

const COMPRESS_LEVELS = ["off", "auto", "light", "strong"];

const COMPRESS_HINTS = {
    off: "原样搬",
    auto: "超预算才压",
    light: "去事件副本 + 截断长记录 + 折叠过程噪声",
    strong: "light + 合并重复 + 省略中段",
};

const DIGEST_MODES = ["off", "auto", "always"];

const DIGEST_HINTS = {
    off: "不生成摘要",
    auto: "模型拿不到历史时才生成",
    always: "总是生成",
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
        compression: result.compression,
        // 摘要正文不往提示词里塞：模型该做的是按提示去 read 那个文件
        digest: result.digest
            ? {
                  file: result.digest.file,
                  path: result.digest.path,
                  chars: result.digest.chars,
                  lines: result.digest.lines,
                  counts: {
                      calls: result.digest.calls,
                      files: result.digest.files,
                      commands: result.digest.commands,
                      errors: result.digest.errors,
                  },
              }
            : null,
        warnings: result.warnings,
        target: result.target
            ? {
                  id: result.target.id,
                  outputCount: result.target.outputCount,
                  outputChars: result.target.outputChars,
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
            // to 可省略：省略时自动新开一个会话，适合「上下文快满了，接着干」的场景
            to: { type: "string", maxLength: 128 },
            mode: { type: "string", default: "full", enum: MODES },
            // 不设 default：留空时由插件配置决定，两个地方不打架
            compress: { type: "string", enum: COMPRESS_LEVELS },
            digest: { type: "string", enum: DIGEST_MODES },
        },
    },
    async run(node, ctx) {
        const attrs = ctx.attrs;
        try {
            const result = ctx.sessions.transfer({
                from: attrs.from,
                to: attrs.to,
                mode: attrs.mode,
                compress: attrs.compress,
                digest: attrs.digest,
            });
            return Object.assign({ action: "memory-transfer" }, result);
        } catch (error) {
            return {
                ok: false,
                action: "memory-transfer",
                from: attrs.from,
                to: attrs.to,
                mode: attrs.mode,
                compress: attrs.compress || null,
                digest: attrs.digest || null,
                code: (error && error.code) || null,
                error: (error && error.message) || String(error),
            };
        }
    },
    meta: {
        prompt: {
            group: "session",
            usage: '<memory-transfer from="aaa" to="bbb" mode="digest" digest="auto"/>',
            note:
                "把一个会话的记忆转到另一个会话 id；省略 to 会自动新开一个会话并在结果里返回它的 id。" +
                "mode=full 连过程记录和模型对话线程一起搬，" +
                "records 只搬记录，link 只接续模型上下文，" +
                "digest 只带任务和一页摘要（不搬记录、不接续线程）。" +
                "上下文快满要换会话时用 digest：新会话只需要知道大概做过什么，" +
                "把几千条旧记录搬过去只会让界面又长一遍；full 更不行，它会复用那条已经满了的线程，等于没换。" +
                "compress=auto（默认）只在记录超出预算时压缩，" +
                "light 去掉事件副本并折叠过程噪声，strong 还会省略中段，off 原样搬。" +
                "digest=auto（默认）在「模型拿不到历史」时（digest / records 模式或源会话没有对话线程）把之前的工作" +
                "压成一页 markdown 摘要落到工作区，并在新会话的 task 里写明先 read 它；" +
                "always 总是生成，off 不生成（mode=digest 配 digest=off 会被拒绝，因为那样什么都没搬）。" +
                "目标会话不存在时会按源会话的 workspace/provider 自动新建（不会自动开始运行）；" +
                "目标正在运行时会被拒绝。full / link 之后两个会话共用同一条 provider 对话线程，" +
                "在任一边继续聊都会影响另一边。",
            priority: 40,
        },
        permission: ["sessions:read", "sessions:write", "workspace:write"],
        mutating: true,
        timeoutMs: 15000,
        summary: (result) => "memory-transfer " + (result.from || "?") + " → " + (result.to || "?"),
        promptResult: promptView,
    },
};

function setup(ctx) {
    const config = ctx.config || {};
    const maxRecords = Number(config.maxOutputRecords);
    const compress = String(config.compress || "auto");
    const digest = String(config.digest || "auto");
    ctx.logger.info(
        "会话记忆转移已启用（单次最多 " +
            (maxRecords > 0 ? maxRecords : 2000) +
            " 条记录，压缩：" +
            COMPRESS_LEVELS.map((level) => level + "=" + COMPRESS_HINTS[level]).join(" / ") +
            "，默认 " +
            compress +
            "，字符预算 " +
            (Number(config.maxChars) > 0 ? Number(config.maxChars) : 300000) +
            "；摘要：" +
            DIGEST_MODES.map((mode) => mode + "=" + DIGEST_HINTS[mode]).join(" / ") +
            "，默认 " +
            digest +
            "；模式：" +
            MODES.map((mode) => mode + "=" + MODE_HINTS[mode]).join(" / ") +
            "）"
    );

    ctx.actions.register(ACTION);

    /**
     * 列会话：面板表格与接口共用。
     * 只返回摘要（不含 output 正文），否则一个有上万条输出的会话就能把面板拖死。
     */
    ctx.api.get("/sessions", (request) => {
        const limit = Number(request.query && request.query.limit);
        const sessions = request.sessions.list(Number.isFinite(limit) && limit > 0 ? limit : 20);
        return { total: sessions.length, sessions };
    });

    /**
     * 压缩预览：只读，不写任何会话。
     * 先看能省多少，再决定要不要搬 —— 省得为了看清代价先搬一遍。
     */
    ctx.api.post("/preview", (request) => {
        const body = request.body && typeof request.body === "object" ? request.body : {};
        try {
            const preview = request.sessions.preview({
                from: body.from,
                compress: body.compress,
                maxChars: body.maxChars,
            });
            return { ok: true, preview };
        } catch (error) {
            return {
                ok: false,
                code: (error && error.code) || null,
                error: (error && error.message) || String(error),
            };
        }
    });

    /**
     * 摘要预览：只读，不写文件。
     * 让用户先看一眼"模型将会读到什么"，再决定要不要真的转移。
     */
    ctx.api.post("/digest", (request) => {
        const body = request.body && typeof request.body === "object" ? request.body : {};
        try {
            const preview = request.sessions.previewDigest({
                from: body.from,
                to: body.to,
                maxChars: body.maxChars,
            });
            return { ok: true, preview };
        } catch (error) {
            return {
                ok: false,
                code: (error && error.code) || null,
                error: (error && error.message) || String(error),
            };
        }
    });

    /**
     * 转移接口：给前端 / 脚本用，与动作走同一份实现（ctx.sessions.transfer）。
     * body: { from, to, mode, compress, digest }
     *
     * 注意：HTTP 侧没有 host.workspace，不提供摘要写入口 ——
     * 结果的 digest.markdown 会带回来，需要落盘的话由调用方自己写。
     */
    ctx.api.post("/transfer", (request) => {
        const body = request.body && typeof request.body === "object" ? request.body : {};
        try {
            const result = request.sessions.transfer({
                from: body.from,
                to: body.to,
                mode: body.mode,
                compress: body.compress,
                digest: body.digest,
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
        description: "把一个会话的记忆（记录 + 模型对话线程）压缩后转到另一个会话",
        blocks: [
            {
                kind: "status",
                title: "Sessions",
                path: "/sessions",
                items: [
                    { label: "Listed", value: "total" },
                    { label: "Latest", value: "sessions.0.id" },
                    { label: "Latest records", value: "sessions.0.outputCount" },
                    { label: "Latest chars", value: "sessions.0.outputChars" },
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
                    { key: "outputChars", label: "Chars" },
                    { key: "hasConversation", label: "Thread" },
                    { key: "task", label: "Task" },
                ],
                empty: "No sessions yet — run a task first.",
            },
            {
                kind: "note",
                text:
                    '用法：对话里让模型调用 <memory-transfer from="aaa" to="bbb" mode="digest" digest="auto"/>，' +
                    '或 POST /api/plugins/memory-transfer/api/transfer {"from":"aaa","to":"bbb","mode":"digest"}。' +
                    "mode：full=记录+模型上下文，records=只搬记录，link=只接续模型上下文，" +
                    "digest=只带任务+摘要（上下文满了换会话用这个）。" +
                    "compress：auto=超预算才压（默认），light=去事件副本+截断长记录+折叠过程噪声，" +
                    "strong=再加合并重复与省略中段，off=原样搬。" +
                    "digest：auto=模型拿不到历史时生成摘要 md（默认），always=总是生成，off=不生成。" +
                    "摘要写到工作区的 .xml-agent-memory/<to>.md，并在新会话 task 里要求先 read 它——" +
                    "记录本身不会进模型上下文，摘要才是模型真正能读到的东西。" +
                    '想先看效果：POST /api/plugins/memory-transfer/api/preview {"from":"aaa","compress":"strong"}（压缩）' +
                    '或 /api/digest {"from":"aaa"}（摘要，均只读）。',
            },
        ],
    });
}

module.exports = {
    setup,
};
