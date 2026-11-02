/**
内置插件：fetch（action）

演示一个完整的插件动作应该包含的五件事：
校验（schema）/ 执行（run）/ 模型文档（meta.prompt）/ 可观测（meta.summary）/ 安全（permission + timeout）。

安全要点：
- 域名白名单来自插件配置 allowHosts（默认只放行本机），空名单等于全部拒绝；
- 不跟随重定向（3xx 直接返回给模型），避免白名单被跳转绕过；
- 响应体积有硬上限，超出即截断并标记 truncated；
- 超时与取消通过 ctx.signal 传递给 HTTP 客户端。
*/

// 回给模型的响应体上限（字符）。完整响应体仍然保留在 Trace 与报告里。
const PROMPT_BODY_LIMIT = 4000;

const ACTION = {
    name: "fetch",
    schema: {
        attrs: {
            url: { type: "string", required: true, nonEmpty: true, maxLength: 2000 },
            method: {
                type: "string",
                default: "GET",
                enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
            },
            body: { type: "string", maxLength: 100000 },
            timeout: { type: "integer", min: 1, max: 120000 },
            maxBytes: { type: "integer", min: 1, max: 4194304 },
        },
    },
    async run(node, ctx) {
        const attrs = ctx.attrs;
        const url = attrs.url;
        const method = String(attrs.method || "GET").toUpperCase();
        try {
            const response = await ctx.http.request({
                url,
                method,
                body: attrs.body,
                timeoutMs: attrs.timeout,
                maxBytes: attrs.maxBytes,
                signal: ctx.signal,
            });
            const ok = response.status >= 200 && response.status < 400;
            const result = {
                ok,
                action: "fetch",
                url: ctx.redact(url),
                method,
                status: response.status,
                statusText: response.statusText,
                contentType: String(response.headers["content-type"] || ""),
                bytes: response.bytes,
                truncated: response.truncated,
                body: response.body,
            };
            if (!ok) {
                result.error = "HTTP " + response.status + " " + (response.statusText || "");
            }
            return result;
        } catch (error) {
            return {
                ok: false,
                action: "fetch",
                url: ctx.redact(url),
                method,
                code: (error && error.code) || null,
                error: (error && error.message) || String(error),
            };
        }
    },
    meta: {
        prompt: {
            group: "network",
            usage: '<fetch url="http://127.0.0.1:3000/api/health" method="GET"/>',
            note:
                "发起 HTTP 请求并返回状态码与响应体（默认最多 1MB，超出会标记 truncated）。" +
                "只允许访问插件配置 allowHosts 白名单内的主机；不跟随重定向，3xx 会原样返回。" +
                "需要 POST 时把内容放在 body 属性里。",
            priority: 50,
        },
        permission: ["network:http"],
        mutating: false,
        timeoutMs: 60000,
        summary: (result) =>
            "fetch " +
            (result.method || "GET") +
            " " +
            (result.url || "") +
            " → " +
            (result.status === undefined ? "failed" : result.status),
        // 回给模型的视图：响应体可能很大，截到 PROMPT_BODY_LIMIT 字符，
        // 完整内容仍保留在 Trace / 报告里。
        promptResult: (result) => {
            const view = Object.assign({}, result);
            const body = String(
                result.body === undefined || result.body === null ? "" : result.body
            );
            if (body.length > PROMPT_BODY_LIMIT) {
                view.body = body.substring(0, PROMPT_BODY_LIMIT);
                view.bodyTruncatedForPrompt = true;
                view.originalBodyLength = body.length;
            }
            return view;
        },
    },
};

function setup(ctx) {
    ctx.actions.register(ACTION);
    const allowHosts =
        ctx.config && Array.isArray(ctx.config.allowHosts) ? ctx.config.allowHosts : [];
    ctx.logger.info(
        "允许的主机白名单：" + (allowHosts.length ? allowHosts.join(", ") : "（空，全部拒绝）")
    );
}

module.exports = {
    setup,
};
