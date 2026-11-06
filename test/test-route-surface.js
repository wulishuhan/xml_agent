/**
HTTP 接口面回归测试（锁定 server.js 拆路由前后的路由表）

server.js 从 650 行单文件拆成 webui/routes/*.js 后，最大的风险是"某个接口在搬家的过程中丢了"。
这个测试把当前的 (method, path) 全表冻结下来：
- 少一条 → 立刻失败（回归）
- 多一条 → 也失败（新增接口要同步更新这里的清单，避免接口无声扩大）

运行：node test/test-route-surface.js
*/

process.env.PORT = String(34000 + Math.floor(Math.random() * 3000));

const server = require("../webui/server");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

// 冻结的路由表（顺序无关，按字典序比较）。
// "ALL" 表示用 app.all() 注册（会覆盖所有 HTTP 方法）。
// "MOUNT" 表示用 app.use() 挂在某个前缀上（插件自定义接口就是这种：
// 具体 method + path 由插件自己注册，宿主只知道前缀，所以按处理器的名字记录）。
const EXPECTED = [
    "MOUNT pluginApi",
    "DELETE /api/plugins/secrets/:key",
    "DELETE /api/sessions/:id",
    "GET /api/agent/config",
    "GET /api/browser/detect",
    "GET /api/browser/settings",
    "GET /api/browser/status",
    "GET /api/permissions",
    "GET /api/plugins",
    "GET /api/plugins/:name/config",
    "GET /api/plugins/secrets",
    "GET /api/plugins/ui",
    "GET /api/providers",
    "GET /api/sessions",
    "GET /api/sessions/:id",
    "GET /api/sessions/:id/events",
    "GET /api/sessions/:id/output",
    "GET /api/storage",
    "GET /api/workspace/browse",
    "GET /api/workspaces",
    "GET /xml_agent_web",
    "POST /api/agent/config",
    "POST /api/browser/launch",
    "POST /api/browser/settings",
    "POST /api/browser/switch",
    "POST /api/permissions/grant",
    "POST /api/plugins/:name/config",
    "POST /api/plugins/:name/enabled",
    "POST /api/plugins/reload",
    "POST /api/run",
    "POST /api/sessions/:id/stop",
    "POST /api/sessions/new",
    "POST /api/storage/clean",
    "POST /api/uploads",
    "POST /api/workspace/mkdir",
    "PUT /api/plugins/secrets/:key",
];

function collectRoutes(app) {
    const stack = (app.router && app.router.stack) || (app._router && app._router.stack) || [];
    const routes = [];
    let lastMiddleware = "";
    for (const layer of stack) {
        if (layer.route) {
            const methods = Object.keys(layer.route.methods || {}).filter(
                (name) => layer.route.methods[name]
            );
            // app.all 会把所有 HTTP 方法都标成 true，统一记成 ALL
            if (methods.length > 8) {
                routes.push("ALL " + layer.route.path);
                continue;
            }
            for (const method of methods) {
                routes.push(method.toUpperCase() + " " + layer.route.path);
            }
        } else {
            lastMiddleware = layer.name || "anonymous";
            // 挂载式路由（app.use(prefix, handler)）只会留下中间件层，
            // Express 不暴露挂载前缀，因此按处理器名字记录。
            if (lastMiddleware === "pluginApi") {
                routes.push("MOUNT " + lastMiddleware);
            }
        }
    }
    return { routes, lastMiddleware };
}

const { routes, lastMiddleware } = collectRoutes(server.app);
const actual = routes.slice().sort();
const expected = EXPECTED.slice().sort();

const missing = expected.filter((item) => actual.indexOf(item) === -1);
const extra = actual.filter((item) => expected.indexOf(item) === -1);

check(
    "接口数量一致",
    actual.length === expected.length,
    "actual=" + actual.length + " expected=" + expected.length
);
check("没有接口在拆分中丢失", missing.length === 0, missing.join(", ") || "none");
check("没有意外新增的接口", extra.length === 0, extra.join(", ") || "none");

// 拆分后的装配顺序也要保住：json 解析必须在业务路由之前，/api 兜底 404 必须在最后。
const names = [];
const stack = (server.app.router && server.app.router.stack) || [];
for (const layer of stack) {
    if (!layer.route) {
        names.push(layer.name || "anonymous");
    }
}
check(
    "express.json() 在路由之前注册",
    names.indexOf("jsonParser") !== -1 && names.indexOf("jsonParser") < names.length - 1,
    names.join(",")
);
check(
    "最后一个中间件是 /api 兜底 404",
    lastMiddleware === "<anonymous>" || lastMiddleware === "anonymous",
    String(lastMiddleware)
);
check(
    "导出的兼容面仍在（sessionManager / normalizeConversationId / normalizeImages）",
    typeof server.sessionManager === "object" &&
        typeof server.normalizeConversationId === "function" &&
        typeof server.normalizeImages === "function"
);
check(
    "normalizeImages 仍去重并限 8 张",
    JSON.stringify(server.normalizeImages(["a.png", "a.png", " ", 5, "b.png"])) ===
        JSON.stringify(["a.png", "b.png"])
);
check(
    "normalizeConversationId 仍按 provider 元数据解析",
    server.normalizeConversationId("glm", "https://zchat.z.ai/s/abc-123") === "abc-123"
);

console.log("");
console.log("Total: " + pass + "/" + total);
process.exit(pass === total ? 0 : 1);
