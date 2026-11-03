/**
插件系统端到端测试（不依赖真实浏览器与大模型）

覆盖：
1. 发现 / 加载 / 隔离 / 版本与清单校验
2. XML 解析层对插件动作的校验（含错参报错）
3. Runtime 调用插件动作（成功 / 白名单拒绝 / 权限拒绝 / 超时 / 截断）
4. 内置动作完全不受影响
5. 钩子（hook 插件落盘审计日志）
6. 提示词区块生成与"无插件时提示词不变"
7. 事件格式器兜底与插件自定义格式器
8. SDK 契约自检

运行：node test/test-plugins.js
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const sdk = require("../plugins/sdk");
const registryModule = require("../plugins/registry");
const { extractXML } = require("../parse/xml-parse");
const { createRuntime } = require("../runtime");
const { getFirstPrompt } = require("../prompts/first-prompt");
const { SYSTEM_PROMPT } = require("../prompts/system-prompt");
const { getRuntimeOkPrompt } = require("../prompts/runtime-prompt");
const { AgentSession } = require("../webui/session/agent-session");

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
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

function startServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === "/slow") {
                setTimeout(() => {
                    res.writeHead(200, { "content-type": "text/plain" });
                    res.end("slow");
                }, 800);
                return;
            }
            if (req.url === "/big") {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end("x".repeat(20000));
                return;
            }
            if (req.url === "/err") {
                res.writeHead(500, { "content-type": "text/plain" });
                res.end("boom");
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

async function main() {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-plugin-store-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-plugin-ws-"));
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-plugin-user-"));
    const server = await startServer();
    const port = server.address().port;

    try {
        console.log("=== 1. 发现与加载 ===");
        const registry = registryModule.createRegistry({
            storeRoot,
            dirs: [userDir],
            logger: silentLogger,
        });
        registry.load();
        registryModule.setRegistryForTests(registry);

        const status = registry.getStatus();
        const fetchStatus = status.filter((item) => item.name === "fetch")[0];
        const auditStatus = status.filter((item) => item.name === "audit-log")[0];
        check("内置插件 fetch 已加载", Boolean(fetchStatus) && fetchStatus.status === "loaded");
        check("内置插件 audit-log 已加载", Boolean(auditStatus) && auditStatus.status === "loaded");
        check("动作表包含 fetch", registry.hasAction("fetch"));
        check(
            "内置插件声明的 network:http 默认 allow",
            Boolean(fetchStatus) &&
                fetchStatus.effectivePermissions.some(
                    (item) => item.scope === "network:http" && item.policy === "allow"
                )
        );

        console.log("\n=== 2. XML 解析层校验 ===");
        const parsed = extractXML('<fetch url="http://127.0.0.1:' + port + '/ok" method="GET"/>');
        check("合法 fetch 可解析", parsed.action === "fetch" && parsed.plugin === "fetch");
        check("解析结果带插件来源", parsed.plugin === "fetch", String(parsed.plugin));
        let missingUrlError = "";
        try {
            extractXML("<fetch/>");
        } catch (error) {
            missingUrlError = error.message;
        }
        check("缺少 url 被拒绝", missingUrlError.includes("url"), missingUrlError);
        let unknownAttrError = "";
        try {
            extractXML('<fetch url="http://127.0.0.1/' + port + '" bogus="1"/>');
        } catch (error) {
            unknownAttrError = error.message;
        }
        check("未知属性被拒绝", unknownAttrError.includes("bogus"), unknownAttrError);
        let unknownActionError = "";
        try {
            extractXML("<nope/>");
        } catch (error) {
            unknownActionError = error.message;
        }
        check(
            "未知动作仍然报错（保持 1.0.x 行为）",
            unknownActionError.includes("Unknown XML Action"),
            unknownActionError
        );

        console.log("\n=== 3. Runtime 调用插件动作 ===");
        const runtime = createRuntime(workspace);
        const okResult = await runtime.run({
            action: "fetch",
            node: { "@_url": "http://127.0.0.1:" + port + "/hello" },
        });
        check(
            "fetch 成功返回状态码与响应体",
            okResult.ok === true && okResult.status === 200 && okResult.body.includes("/hello"),
            "status=" + okResult.status
        );
        check(
            "结果带 plugin 与 durationMs",
            okResult.plugin === "fetch" && okResult.durationMs >= 0
        );
        check("默认 method 被 schema 补成 GET", okResult.method === "GET", String(okResult.method));

        const blocked = await runtime.run({
            action: "fetch",
            node: { "@_url": "http://example.com/" },
        });
        check(
            "白名单外主机被拒绝",
            blocked.ok === false && blocked.code === "HTTP_HOST_NOT_ALLOWED",
            String(blocked.error)
        );

        const httpError = await runtime.run({
            action: "fetch",
            node: { "@_url": "http://127.0.0.1:" + port + "/err" },
        });
        check(
            "5xx 返回 ok:false 且保留状态码",
            httpError.ok === false && httpError.status === 500,
            "status=" + httpError.status
        );

        const truncated = await runtime.run({
            action: "fetch",
            node: { "@_url": "http://127.0.0.1:" + port + "/big", "@_maxBytes": "1000" },
        });
        check(
            "超出 maxBytes 时截断并标记",
            truncated.ok === true && truncated.truncated === true && truncated.body.length === 1000,
            "len=" + (truncated.body || "").length
        );

        const timedOut = await runtime.run({
            action: "fetch",
            node: { "@_url": "http://127.0.0.1:" + port + "/slow", "@_timeout": "150" },
        });
        check(
            "请求超时被中断",
            timedOut.ok === false &&
                (timedOut.code === "HTTP_TIMEOUT" || timedOut.timedOut === true),
            String(timedOut.error)
        );

        console.log("\n=== 3b. 回给模型的精简视图 ===");
        const bigResult = await runtime.run({
            action: "fetch",
            node: { "@_url": "http://127.0.0.1:" + port + "/big", "@_maxBytes": "20000" },
        });
        check(
            "完整结果保留大响应体",
            bigResult.ok === true && bigResult.body.length === 20000,
            "len=" + bigResult.body.length
        );
        check(
            "promptView 截断响应体",
            Boolean(bigResult.promptView) &&
                bigResult.promptView.body.length === 4000 &&
                bigResult.promptView.bodyTruncatedForPrompt === true,
            bigResult.promptView ? "len=" + bigResult.promptView.body.length : "missing"
        );
        const promptForModel = getRuntimeOkPrompt(bigResult);
        check(
            "下一轮提示词不含完整响应体",
            promptForModel.length < 8000,
            "promptLen=" + promptForModel.length
        );

        console.log("\n=== 4. 内置动作不受影响 ===");
        fs.writeFileSync(path.join(workspace, "note.txt"), "hello", "utf8");
        const readResult = await runtime.run({
            action: "read",
            node: { "@_path": "note.txt" },
        });
        check(
            "内置 read 仍然工作",
            readResult.ok === true && readResult.content === "hello",
            String(readResult.error || "")
        );
        const unknownRuntime = await runtime.run({ action: "nope", node: {} }).catch((error) => ({
            ok: false,
            error: error.message,
        }));
        check(
            "未注册动作在 Runtime 层报 Unknown action",
            String(unknownRuntime.error).includes("Unknown action"),
            String(unknownRuntime.error)
        );

        console.log("\n=== 5. 权限模型 ===");
        fs.writeFileSync(
            path.join(storeRoot, "permissions.json"),
            JSON.stringify({ "network:http": "deny" }, null, 2),
            "utf8"
        );
        registry.reload();
        const denied = await runtime.run({
            action: "fetch",
            node: { "@_url": "http://127.0.0.1:" + port + "/ok" },
        });
        check(
            "权限被禁时返回结构化拒绝",
            denied.ok === false &&
                denied.permission === "network:http" &&
                String(denied.error).includes("permission denied"),
            String(denied.error)
        );
        registry.grantPermission("network:http", "allow");
        registry.reload();
        const afterGrant = await runtime.run({
            action: "fetch",
            node: { "@_url": "http://127.0.0.1:" + port + "/ok" },
        });
        check("授权后恢复正常", afterGrant.ok === true, String(afterGrant.error || ""));
        registry.grantPermission("network:http", "allow");

        console.log("\n=== 6. 钩子（hook 插件） ===");
        // 目录从注册表取，不在测试里重复拼路径：插件数据放在
        // <storeRoot>/plugin-data/<name>/，与插件安装目录分开。
        const auditFile = registry.storageDir("audit-log");
        const before = fs.existsSync(auditFile) ? fs.readdirSync(auditFile).length : 0;
        registry.emitHook("runtime.result", {
            step: 3,
            action: "fetch",
            result: { ok: true, action: "fetch", plugin: "fetch", durationMs: 12 },
        });
        registry.emitHook("action.denied", {
            action: "fetch",
            plugin: "fetch",
            scope: "network:http",
            policy: "deny",
            reason: "test",
        });
        const auditFiles = fs.existsSync(auditFile)
            ? fs.readdirSync(auditFile).filter((name) => name.endsWith(".jsonl"))
            : [];
        const auditText =
            auditFiles.length > 0
                ? fs.readFileSync(path.join(auditFile, auditFiles[0]), "utf8").trim().split("\n")
                : [];
        check(
            "审计日志已落盘",
            auditFiles.length > 0 && auditText.length >= 2,
            "files=" + auditFiles.length + " lines=" + auditText.length
        );
        check(
            "审计日志记录权限拒绝事件",
            auditText.some((line) => line.includes("action.denied")),
            auditText.length + " line(s)"
        );
        const beforeCheck = before >= 0;

        console.log("\n=== 7. 提示词区块 ===");
        const promptWithPlugins = getFirstPrompt(workspace, ["a.js"], "抓取接口", {
            registry,
        });
        check("首轮提示词包含插件动作", promptWithPlugins.includes("<fetch"));
        check("首轮提示词保留系统提示词原文", promptWithPlugins.includes(SYSTEM_PROMPT.trim()));
        check("首轮提示词含插件区块标题", promptWithPlugins.includes("插件能力"));

        const promptWithoutPlugins = getFirstPrompt(workspace, ["a.js"], "抓取接口", {
            registry: null,
        });
        check(
            "无插件时提示词不含插件区块",
            !promptWithoutPlugins.includes("插件能力") &&
                promptWithoutPlugins.startsWith("\n" + SYSTEM_PROMPT),
            String(promptWithoutPlugins.length)
        );

        console.log("\n=== 8. 事件格式器兜底 ===");
        const session = new AgentSession({ workspace, provider: "deepseek", task: "t" });
        const unknownLine = session.formatEvent({ type: "plugin.something.happened", value: 1 });
        check(
            "未知事件不再空白",
            typeof unknownLine === "string" && unknownLine.includes("plugin.something.happened"),
            String(unknownLine)
        );
        const builtinLine = session.formatEvent({ type: "step.started", step: 2 });
        check("内置事件文案未改变", builtinLine === "Agent step 2", String(builtinLine));

        console.log("\n=== 9. 用户插件：隔离与冲突 ===");
        const brokenDir = path.join(userDir, "broken-plugin");
        writePlugin(
            userDir,
            "broken-plugin",
            { kind: "action", permissions: [] },
            "module.exports = { setup() { throw new Error('boom'); } };\n"
        );
        writePlugin(
            userDir,
            "reserved-name",
            { kind: "action", permissions: [] },
            'module.exports = { setup(ctx) { ctx.actions.register({ name: "read", run: () => ({ ok: true }), meta: { prompt: { usage: "<read/>" } } }); } };\n'
        );
        writePlugin(
            userDir,
            "with-formatter",
            { kind: "ui", permissions: [] },
            'module.exports = { setup(ctx) { ctx.eventFormatters.register("plugin.with-formatter.tick", (event) => "TICK " + event.n); } };\n'
        );
        writePlugin(
            userDir,
            "slow-plugin",
            { kind: "action", permissions: [] },
            'module.exports = { setup(ctx) { ctx.actions.register({ name: "hang", run: () => new Promise(() => {}), meta: { prompt: { usage: "<hang/>" }, timeoutMs: 120 } }); } };\n'
        );
        registry.reload();
        const statuses = registry.getStatus();
        const broken = statuses.filter((item) => item.name === "broken-plugin")[0];
        const reserved = statuses.filter((item) => item.name === "reserved-name")[0];
        const formatterOwner = statuses.filter((item) => item.name === "with-formatter")[0];
        check(
            "setup 抛错的插件被隔离为 error",
            Boolean(broken) && broken.status === "error" && broken.error.includes("boom"),
            broken ? broken.error : "missing"
        );
        check(
            "占用内置动作名被拒绝",
            Boolean(reserved) && reserved.status === "error" && reserved.error.includes("内置动作"),
            reserved ? reserved.error : "missing"
        );
        check(
            "冲突插件不影响其它插件加载",
            statuses.filter((item) => item.status === "loaded").length >= 3,
            String(statuses.filter((item) => item.status === "loaded").length)
        );
        const customLine = session.formatEvent({ type: "plugin.with-formatter.tick", n: 7 });
        check("插件自定义事件格式器生效", customLine === "TICK 7", String(customLine));
        check(
            "内置 read 未被用户插件覆盖",
            registry.getActionDefinition("read") === null,
            String(registry.getActionPluginName("read"))
        );
        const hangResult = await runtime.run({ action: "hang", node: {} });
        check(
            "动作级超时生效（PLUGIN_TIMEOUT）",
            hangResult.ok === false && hangResult.timedOut === true,
            String(hangResult.error)
        );
        check(
            "超时后其它动作仍可用",
            (await runtime.run({ action: "read", node: { "@_path": "note.txt" } })).ok === true
        );

        console.log("\n=== 10. SDK 契约与工具函数 ===");
        const fetchPlugin = require("../plugins/builtin/fetch");
        const conformance = sdk.assertPluginConformance(fetchPlugin);
        check(
            "内置 fetch 通过契约自检",
            conformance.actions.length === 1 && conformance.actions[0].name === "fetch"
        );
        check("引擎区间 >=1.1.0 匹配 1.1.0", sdk.satisfiesEngines(">=1.1.0", "1.1.0"));
        check("引擎区间 >=1.1.0 不匹配 1.0.7", !sdk.satisfiesEngines(">=1.1.0", "1.0.7"));
        check("^1.2.3 允许 1.3.0", sdk.satisfiesEngines("^1.2.3", "1.3.0"));
        check("^1.2.3 不允许 2.0.0", !sdk.satisfiesEngines("^1.2.3", "2.0.0"));
        check("~1.2.3 不允许 1.3.0", !sdk.satisfiesEngines("~1.2.3", "1.3.0"));
        const attrs = sdk.normalizeAttrs(
            {
                schema: { attrs: { method: { type: "string", default: "GET" } } },
            },
            {}
        );
        check(
            "schema 默认值生效",
            attrs.ok === true && attrs.value.method === "GET",
            JSON.stringify(attrs.value)
        );

        console.log("\n=== 11. 一键禁用 ===");
        const disabled = registryModule.createRegistry({
            storeRoot,
            dirs: [userDir],
            enabled: false,
            logger: silentLogger,
        });
        disabled.load();
        check(
            "XML_AGENT_PLUGINS=0 时没有任何插件动作",
            disabled.hasAction("fetch") === false && disabled.getStatus().length === 0,
            "actions=" + disabled.actions.size
        );
        check(
            "禁用时提示词不含插件区块",
            !getFirstPrompt(workspace, [], "x", { registry: disabled }).includes("插件能力")
        );

        if (!beforeCheck) {
            console.log("（审计目录初始状态检查被跳过）");
        }
    } finally {
        try {
            server.close();
        } catch (error) {
            // ignore
        }
        for (const dir of [storeRoot, workspace, userDir]) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (error) {
                // ignore
            }
        }
        registryModule.resetRegistry();
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);
    process.exit(pass === total ? 0 : 1);
}

main().catch((error) => {
    console.error("Test run failed:", error && error.stack ? error.stack : error);
    process.exit(1);
});
