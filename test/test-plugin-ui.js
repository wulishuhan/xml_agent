/**
插件声明式 UI（P4）+ 插件接口测试

P4 的约定：面板由插件以纯 JSON 声明，宿主渲染；插件不向浏览器下发任何可执行代码。
面板要显示数据就需要接口，因此同时落地了 ctx.api.*（限定在 /api/plugins/<name>/api 之下）。

覆盖：
1. sdk 层校验（路由路径/方法/处理函数、面板 block 结构）
2. 注册表：路由登记、面板登记、非法面板只跳过并记录
3. 调用：GET / POST / 未知路径 / 未知插件 / 处理函数抛错
4. 一致性守卫：内置 audit-log 面板引用的每个 path 都必须有对应的已注册接口

运行：node test/test-plugin-ui.js
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const sdk = require("../plugins/sdk");
const registryModule = require("../plugins/registry");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function capture(fn) {
    try {
        const value = fn();
        return { ok: true, value };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

function writePlugin(dir, name, manifest, indexSource) {
    const pluginDir = path.join(dir, name);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify(Object.assign({ name, version: "1.0.0", apiVersion: 1 }, manifest), null, 2),
        "utf8"
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), indexSource, "utf8");
    return pluginDir;
}

async function main() {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-ui-store-"));
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-ui-user-"));
    const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

    try {
        console.log("=== 1. sdk：接口定义校验 ===");
        check(
            "合法路由被归一化",
            (() => {
                const route = sdk.normalizeApiRoute("get", "/summary", () => ({}));
                return route.method === "GET" && route.path === "/summary";
            })()
        );
        check(
            "方法必须大写归一（post → POST）",
            sdk.normalizeApiRoute("post", "/do", () => ({})).method === "POST"
        );
        check(
            "路径必须以 / 开头",
            (() => {
                const result = capture(() => sdk.normalizeApiRoute("GET", "summary", () => ({})));
                return !result.ok && result.error.indexOf("/") !== -1;
            })()
        );
        check(
            "路径不允许 ..",
            (() => {
                const result = capture(() => sdk.normalizeApiRoute("GET", "/../x", () => ({})));
                return !result.ok;
            })()
        );
        check(
            "非法方法被拒绝",
            (() => {
                const result = capture(() => sdk.normalizeApiRoute("PATCH", "/x", () => ({})));
                return !result.ok && result.error.indexOf("PATCH") !== -1;
            })()
        );
        check(
            "缺少处理函数被拒绝",
            (() => {
                const result = capture(() => sdk.normalizeApiRoute("GET", "/x"));
                return !result.ok;
            })()
        );

        console.log("\n=== 2. sdk：面板定义校验 ===");
        const validPanel = sdk.normalizePanel({
            id: "demo",
            title: "Demo",
            blocks: [
                { kind: "note", text: "hello" },
                { kind: "status", path: "/summary", items: [{ label: "Total", value: "total" }] },
                {
                    kind: "table",
                    path: "/summary",
                    rows: "recent",
                    columns: [{ key: "ts", label: "Time" }],
                },
                { kind: "action", label: "Run", path: "/run", method: "post" },
            ],
        });
        check(
            "合法面板被归一化（4 种 block）",
            validPanel.blocks.length === 4 &&
                validPanel.blocks[3].method === "POST" &&
                validPanel.blocks[2].rows === "recent"
        );
        check(
            "未知 block 类型被拒绝",
            (() => {
                const result = capture(() =>
                    sdk.normalizePanel({ id: "x", title: "X", blocks: [{ kind: "iframe" }] })
                );
                return !result.ok && result.error.indexOf("iframe") !== -1;
            })()
        );
        check(
            "status 缺少 items 被拒绝",
            (() => {
                const result = capture(() =>
                    sdk.normalizePanel({
                        id: "x",
                        title: "X",
                        blocks: [{ kind: "status", path: "/s", items: [] }],
                    })
                );
                return !result.ok;
            })()
        );
        check(
            "block 缺少 path 被拒绝",
            (() => {
                const result = capture(() =>
                    sdk.normalizePanel({
                        id: "x",
                        title: "X",
                        blocks: [{ kind: "table", columns: [{ key: "a" }] }],
                    })
                );
                return !result.ok && result.error.indexOf("path") !== -1;
            })()
        );
        check(
            "action 缺少 label 被拒绝",
            (() => {
                const result = capture(() =>
                    sdk.normalizePanel({
                        id: "x",
                        title: "X",
                        blocks: [{ kind: "action", path: "/run" }],
                    })
                );
                return !result.ok && result.error.indexOf("label") !== -1;
            })()
        );

        console.log("\n=== 3. 注册表：接口与面板 ===");
        writePlugin(
            userDir,
            "panel-plugin",
            { kind: "ui", permissions: [], description: "声明式面板示例" },
            `
module.exports = {
    setup(ctx) {
        const state = { hits: 0 };
        ctx.api.get("/summary", () => ({ hits: state.hits, rows: [{ ts: "t1", event: "demo" }] }));
        ctx.api.post("/bump", (request) => {
            state.hits += 1;
            return { hits: state.hits, got: request.body || null, query: request.query || {} };
        });
        ctx.api.get("/boom", () => {
            throw new Error("handler exploded");
        });
        ctx.ui.registerPanel({
            id: "demo",
            title: "Demo panel",
            blocks: [
                { kind: "status", path: "/summary", items: [{ label: "Hits", value: "hits" }] },
                { kind: "table", path: "/summary", rows: "rows", columns: [{ key: "ts", label: "Time" }] },
                { kind: "action", label: "Bump", path: "/bump", method: "POST", body: { n: 1 } },
            ],
        });
    },
};
`
        );
        writePlugin(
            userDir,
            "bad-panel-plugin",
            { kind: "ui", permissions: [] },
            `
module.exports = {
    setup(ctx) {
        ctx.ui.registerPanel({ id: "bad", title: "Bad", blocks: [{ kind: "nope" }] });
    },
};
`
        );
        writePlugin(
            userDir,
            "bad-route-plugin",
            { kind: "ui", permissions: [] },
            `
module.exports = {
    setup(ctx) {
        ctx.api.get("no-leading-slash", () => ({}));
    },
};
`
        );

        const registry = registryModule.createRegistry({
            storeRoot,
            dirs: [userDir],
            logger: silentLogger,
        });
        registry.load();
        registryModule.setRegistryForTests(registry);

        const statuses = registry.getStatus();
        const panelPlugin = statuses.filter((item) => item.name === "panel-plugin")[0];
        check(
            "插件接口被登记",
            Boolean(panelPlugin) &&
                JSON.stringify(panelPlugin.apiRoutes) ===
                    JSON.stringify(["GET /summary", "POST /bump", "GET /boom"]),
            panelPlugin ? panelPlugin.apiRoutes.join(",") : "missing"
        );
        check("合法插件无 UI 错误", Boolean(panelPlugin) && panelPlugin.uiErrors.length === 0);
        check(
            "非法面板只跳过并记录原因",
            (() => {
                const bad = statuses.filter((item) => item.name === "bad-panel-plugin")[0];
                return Boolean(bad) && bad.status === "loaded" && bad.uiErrors.length === 1;
            })(),
            (() => {
                const bad = statuses.filter((item) => item.name === "bad-panel-plugin")[0];
                return bad ? bad.uiErrors.join("; ") : "missing";
            })()
        );
        check(
            "非法接口路径导致插件加载失败",
            (() => {
                const bad = statuses.filter((item) => item.name === "bad-route-plugin")[0];
                return Boolean(bad) && bad.status === "error";
            })()
        );

        console.log("\n=== 4. 面板清单 ===");
        const manifest = registry.getUiManifest();
        const demoPanel = manifest.panels.filter((item) => item.plugin === "panel-plugin")[0];
        check("面板出现在 ui manifest", Boolean(demoPanel) && demoPanel.id === "demo");
        check(
            "面板带 basePath（前端据此拼接口地址）",
            Boolean(demoPanel) && demoPanel.basePath === "/api/plugins/panel-plugin/api",
            demoPanel ? demoPanel.basePath : "missing"
        );
        check(
            "被跳过的面板不出现在清单里",
            manifest.panels.every((item) => item.id !== "bad")
        );

        console.log("\n=== 5. 调用插件接口 ===");
        const getResult = await registry.callPluginApi("panel-plugin", "GET", "/summary", {});
        check(
            "GET 正常返回",
            getResult.status === 200 &&
                getResult.body.hits === 0 &&
                Array.isArray(getResult.body.rows),
            JSON.stringify(getResult.body)
        );
        const postResult = await registry.callPluginApi("panel-plugin", "POST", "/bump", {
            body: { n: 1 },
            query: { a: "b" },
        });
        check(
            "POST 拿到 body 与 query",
            postResult.status === 200 &&
                postResult.body.hits === 1 &&
                postResult.body.got.n === 1 &&
                postResult.body.query.a === "b",
            JSON.stringify(postResult.body)
        );
        const wrongMethod = await registry.callPluginApi("panel-plugin", "DELETE", "/summary", {});
        check("方法不匹配返回 404", wrongMethod.status === 404, String(wrongMethod.status));
        const unknownPath = await registry.callPluginApi("panel-plugin", "GET", "/nope", {});
        check("未知路径返回 404", unknownPath.status === 404, String(unknownPath.status));
        const unknownPlugin = await registry.callPluginApi("no-such-plugin", "GET", "/x", {});
        check("未知插件返回 404", unknownPlugin.status === 404, String(unknownPlugin.status));
        const boom = await registry.callPluginApi("panel-plugin", "GET", "/boom", {});
        check(
            "处理函数抛错返回 500 且带原因",
            boom.status === 500 && String(boom.body.error).indexOf("exploded") !== -1,
            boom.body.error
        );

        console.log("\n=== 6. 内置 audit-log 的面板与接口一致 ===");
        const auditStatus = registry.getStatus().filter((item) => item.name === "audit-log")[0];
        const auditPanel = registry
            .getUiManifest()
            .panels.filter((item) => item.plugin === "audit-log")[0];
        check("audit-log 声明了面板", Boolean(auditPanel));
        const referencedPaths = [];
        for (const block of (auditPanel && auditPanel.blocks) || []) {
            if (block.path && referencedPaths.indexOf(block.path) === -1) {
                referencedPaths.push(block.path);
            }
        }
        check(
            "面板引用的每个 path 都有对应的已注册接口",
            referencedPaths.length > 0 &&
                referencedPaths.every((item) =>
                    (auditStatus.apiRoutes || []).some((route) => route.endsWith(" " + item))
                ),
            referencedPaths.join(",")
        );
        const summary = await registry.callPluginApi("audit-log", "GET", "/summary", {});
        check(
            "audit-log /summary 可调用",
            summary.status === 200 &&
                typeof summary.body.total === "number" &&
                Array.isArray(summary.body.recent),
            JSON.stringify(Object.keys(summary.body || {}))
        );
    } finally {
        registryModule.resetRegistry();
        for (const dir of [storeRoot, userDir]) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (error) {
                // ignore
            }
        }
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);
    process.exit(pass === total ? 0 : 1);
}

main().catch((error) => {
    console.error("Test run failed:", error && error.stack ? error.stack : error);
    process.exit(1);
});
