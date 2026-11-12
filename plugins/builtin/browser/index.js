/**
内置插件：browser（独立浏览器）

六个动作：browse-nav / browse-click / browse-fill / browse-text / browse-shot / browse-eval。

和 provider 的浏览器不是一回事：provider 那个窗口里跑的是模型自己（chatgpt.com 等），
这里是一个独立实例（独立端口 + 独立 user-data-dir），模型可以放心让它跳来跳去。

边界：
- 只允许 http/https，file://、javascript:、chrome:// 一律拒绝；
- browse-eval 默认关闭（配置 allowEval），并且限制返回值长度；
- 导航有超时，页面正文有长度上限（maxTextChars），避免把上下文撑爆。
*/

const fs = require("fs");
const path = require("path");

const engine = require("./engine/browser");

function setup(ctx) {
    const config = ctx.config || {};
    const port = Number(config.cdpPort) || 9333;
    const executablePath = String(config.executablePath || "");
    const allowEval = config.allowEval === true;
    const maxTextChars = Number(config.maxTextChars) || 4000;
    const navTimeout = Number(config.navigationTimeoutMs) || 30000;

    async function withPage() {
        return engine.ensurePage({ port: port, executablePath: executablePath });
    }

    function resolveShot(target) {
        const relative = String(target || "screenshots/browser.png");
        const absolute = ctx.fs.resolve(relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        return { relative: relative.split(path.sep).join("/"), absolute: absolute };
    }

    ctx.onDispose(() => {
        engine.close({ killLaunched: true }).catch(() => {});
    });

    ctx.actions.register({
        name: "browse-nav",
        schema: {
            attrs: {
                url: { type: "string", required: true, nonEmpty: true, maxLength: 2000 },
                waitFor: {
                    type: "string",
                    enum: ["domcontentloaded", "load", "networkidle"],
                    default: "domcontentloaded",
                },
            },
        },
        validate(node) {
            engine.assertHttpUrl(node["@_url"]);
        },
        async run(node, runCtx) {
            const url = engine.assertHttpUrl(runCtx.attrs.url);
            const page = await withPage();
            await page.goto(url, {
                waitUntil: runCtx.attrs.waitFor || "domcontentloaded",
                timeout: navTimeout,
            });
            const info = await engine.pageInfo(page);
            let body = "";
            try {
                body = await page.evaluate(() => (document.body ? document.body.innerText : ""));
            } catch (error) {
                body = "";
            }
            const sliced = engine.shorten(body, maxTextChars);
            return {
                ok: true,
                action: "browse-nav",
                url: info.url,
                title: info.title,
                text: sliced.text,
                textTruncated: sliced.truncated,
            };
        },
        meta: {
            prompt: {
                group: "browser",
                usage: '<browse-nav url="https://example.com"/>',
                note: "在独立浏览器里打开一个 http/https 页面，返回标题与正文（截断到上限）。",
                priority: 90,
            },
            permission: ["network:http"],
            mutating: false,
            timeoutMs: 60000,
            summary: (result) => "browse-nav " + (result.title || result.url || ""),
            promptResult: (result) => ({
                ok: result.ok,
                action: result.action,
                url: result.url,
                title: result.title,
                text: engine.shorten(result.text, maxTextChars).text,
                textTruncated: result.textTruncated,
                error: result.error,
            }),
        },
    });

    ctx.actions.register({
        name: "browse-click",
        schema: {
            attrs: {
                selector: { type: "string", required: true, nonEmpty: true, maxLength: 500 },
            },
        },
        async run(node, runCtx) {
            const page = await withPage();
            await page.click(runCtx.attrs.selector, { timeout: navTimeout });
            await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
            const info = await engine.pageInfo(page);
            return { ok: true, action: "browse-click", url: info.url, title: info.title };
        },
        meta: {
            prompt: {
                group: "browser",
                usage: '<browse-click selector="a.more"/>',
                note: "在当前页面点击一个 CSS 选择器命中的元素（先 browse-nav 再点）。",
                priority: 80,
            },
            permission: ["network:http"],
            mutating: false,
            timeoutMs: 60000,
            summary: (result) => "browse-click -> " + (result.title || result.url || ""),
        },
    });

    ctx.actions.register({
        name: "browse-fill",
        schema: {
            attrs: {
                selector: { type: "string", required: true, nonEmpty: true, maxLength: 500 },
                text: { type: "string", required: true },
            },
        },
        async run(node, runCtx) {
            const page = await withPage();
            await page.fill(runCtx.attrs.selector, runCtx.attrs.text, { timeout: navTimeout });
            return { ok: true, action: "browse-fill", selector: runCtx.attrs.selector };
        },
        meta: {
            prompt: {
                group: "browser",
                usage: '<browse-fill selector="#q" text="关键字"/>',
                note: "往输入框里填入文本（不提交；需要提交再 browse-click 提交按钮）。",
                priority: 70,
            },
            permission: ["network:http"],
            mutating: false,
            timeoutMs: 60000,
            summary: (result) => "browse-fill " + (result.selector || ""),
        },
    });

    ctx.actions.register({
        name: "browse-text",
        schema: {
            attrs: {
                selector: { type: "string", maxLength: 500 },
            },
        },
        async run(node, runCtx) {
            const page = await withPage();
            const selector = runCtx.attrs.selector;
            const raw = selector
                ? await page.innerText(selector, { timeout: navTimeout })
                : await page.evaluate(() => (document.body ? document.body.innerText : ""));
            const sliced = engine.shorten(raw, maxTextChars);
            const info = await engine.pageInfo(page);
            return {
                ok: true,
                action: "browse-text",
                url: info.url,
                title: info.title,
                text: sliced.text,
                textTruncated: sliced.truncated,
            };
        },
        meta: {
            prompt: {
                group: "browser",
                usage: '<browse-text selector="main"/>',
                note: "取当前页面或某个元素的可见文本；省略 selector 时取整页正文。",
                priority: 75,
            },
            permission: ["network:http"],
            mutating: false,
            timeoutMs: 60000,
            summary: (result) => "browse-text " + ((result.text || "").length + " chars"),
            promptResult: (result) => {
                const sliced = engine.shorten(result.text, maxTextChars);
                return {
                    ok: result.ok,
                    action: result.action,
                    url: result.url,
                    title: result.title,
                    text: sliced.text,
                    textTruncated: sliced.truncated,
                    error: result.error,
                };
            },
        },
    });

    ctx.actions.register({
        name: "browse-shot",
        schema: {
            attrs: {
                path: { type: "string", maxLength: 200 },
                fullPage: { type: "boolean", default: false },
            },
        },
        async run(node, runCtx) {
            const page = await withPage();
            const shot = resolveShot(runCtx.attrs.path);
            await page.screenshot({
                path: shot.absolute,
                fullPage: runCtx.attrs.fullPage === true,
            });
            const info = await engine.pageInfo(page);
            return {
                ok: true,
                action: "browse-shot",
                url: info.url,
                title: info.title,
                path: shot.relative,
            };
        },
        meta: {
            prompt: {
                group: "browser",
                usage: '<browse-shot path="screenshots/page.png" fullPage="false"/>',
                note: "给当前页面截图并存进 workspace，图片会随动作一起给你。",
                priority: 65,
            },
            permission: ["system:screen", "workspace:write"],
            mutating: true,
            timeoutMs: 60000,
            summary: (result) => "browse-shot " + (result.path || ""),
            collectImages: (result) => (result.path ? [result.path] : []),
        },
    });

    ctx.actions.register({
        name: "browse-eval",
        schema: {
            attrs: {
                script: { type: "string", required: true, nonEmpty: true },
            },
        },
        async run(node, runCtx) {
            if (!allowEval) {
                return {
                    ok: false,
                    action: "browse-eval",
                    error: "browse-eval 默认关闭（插件配置 allowEval=false）。需要它请在 Plugins 面板里打开该配置。",
                };
            }
            const page = await withPage();
            const raw = await page.evaluate((code) => {
                // eslint-disable-next-line no-new-func
                return new Function("return (" + code + ")")();
            }, runCtx.attrs.script);
            const sliced = engine.shorten(
                typeof raw === "string" ? raw : JSON.stringify(raw),
                maxTextChars
            );
            return {
                ok: true,
                action: "browse-eval",
                result: sliced.text,
                resultTruncated: sliced.truncated,
            };
        },
        meta: {
            prompt: {
                group: "browser",
                usage: '<browse-eval script="document.title"/>',
                note: "在页面里执行一个表达式并返回结果（默认关闭，需要用户显式开启 allowEval）。",
                priority: 20,
            },
            permission: ["network:http"],
            mutating: false,
            timeoutMs: 30000,
            summary: () => "browse-eval",
        },
    });

    ctx.api.get("/summary", () => {
        const page = engine.state.page;
        return {
            connected: !!engine.state.browser,
            port: engine.state.port || port,
            launchedPid: engine.state.launchedPid,
            url: page && !page.isClosed() ? page.url() : null,
            allowEval: allowEval,
            maxTextChars: maxTextChars,
        };
    });

    ctx.ui.registerPanel({
        id: "browser",
        title: "Browser",
        description: "独立浏览器的连接状态",
        blocks: [
            {
                kind: "status",
                title: "Overview",
                path: "/summary",
                items: [
                    { label: "Connected", value: "connected" },
                    { label: "CDP port", value: "port" },
                    { label: "Current URL", value: "url" },
                    { label: "allowEval", value: "allowEval" },
                ],
            },
            {
                kind: "note",
                text:
                    "这是独立实例（端口 " +
                    port +
                    "、独立 user-data-dir），和 provider 用的浏览器不是同一个窗口。" +
                    "只允许 http/https；browse-eval " +
                    (allowEval ? "已开启。" : "默认关闭。") +
                    "插件卸载时会关掉这里启动的进程。",
            },
        ],
    });
}

module.exports = {
    setup,
    dispose() {
        return engine.close({ killLaunched: true }).catch(() => {});
    },
};
