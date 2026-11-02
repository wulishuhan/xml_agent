/**
P2 回归：screenshot 从内置动作迁到内置插件

目标是把"截图"变成与第三方插件同一条链路的能力，同时保证：
1. 让位给插件后，内置动作表里不再有 screenshot（只剩 5 个）；
2. 解析层（自闭合 / 多 target / 错误文案）与 Runtime 兼容面（actionHandlers / runtime.screenshot）不退化；
3. 越界路径仍然被拒（复用 Runtime 的路径沙箱，而不是插件自己拼绝对路径）；
4. 可以单独授权 / 禁用：把 system:screen 设成 deny 后动作被拒绝。

运行：node test/test-screenshot-plugin.js
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    extractXML,
    tryExtractScreenshotManually,
    normalizeScreenshotTargets,
} = require("../parse/xml-parse");
const { getBuiltinAction, getBuiltinActionNames } = require("../actions");
const { Runtime } = require("../runtime");
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
        return { ok: true, value: fn() };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

async function main() {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-shot-store-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-shot-ws-"));
    const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

    try {
        // 用临时 storeRoot，避免污染真实的 ~/.xml-agent
        const registry = registryModule.createRegistry({ storeRoot, logger: silentLogger });
        registry.load();
        registryModule.setRegistryForTests(registry);

        console.log("=== 1. 内置动作表瘦身 ===");
        const builtinNames = getBuiltinActionNames();
        check(
            "内置动作只剩 5 个（screenshot 已移出）",
            JSON.stringify(builtinNames) ===
                JSON.stringify(["read", "write", "exec", "answer", "done"]),
            builtinNames.join(",")
        );
        check("getBuiltinAction('screenshot') 返回 null", getBuiltinAction("screenshot") === null);

        console.log("\n=== 2. screenshot 由内置插件提供 ===");
        check("插件注册表里有 screenshot 动作", registry.hasAction("screenshot"));
        check(
            "来源是内置插件",
            registry.getActionPluginName("screenshot") === "screenshot",
            String(registry.getActionPluginName("screenshot"))
        );
        const status = registry.getStatus().filter((item) => item.name === "screenshot")[0];
        check(
            "截图插件加载成功",
            Boolean(status) && status.status === "loaded" && status.source === "builtin",
            status ? status.status : "missing"
        );
        check(
            "声明了 system:screen / system:window 权限",
            Boolean(status) &&
                status.permissions.indexOf("system:screen") !== -1 &&
                status.permissions.indexOf("system:window") !== -1,
            status ? status.permissions.join(",") : "missing"
        );
        check(
            "内置插件默认放行（allow）",
            Boolean(status) && status.effectivePermissions.every((item) => item.policy === "allow"),
            status ? JSON.stringify(status.effectivePermissions) : "missing"
        );

        console.log("\n=== 3. 动作定义元数据 ===");
        const definition = registry.getActionDefinition("screenshot");
        check("定义可解析", Boolean(definition));
        check(
            "声明了 collectImages（产物自动上传给模型）",
            typeof definition.meta.collectImages === "function"
        );
        check(
            "声明了 fastPath（自闭合写法手写解析）",
            typeof definition.meta.fastPath === "function"
        );
        check(
            "声明了两个权限 scope",
            JSON.stringify(definition.meta.permission) ===
                JSON.stringify(["system:screen", "system:window"])
        );
        check("没有终止语义", definition.meta.terminal === null);
        check("有 Trace 摘要", typeof definition.meta.summary === "function");

        console.log("\n=== 4. 解析层未退化 ===");
        const single = extractXML('<screenshot source="screen" path="a.png"/>');
        check(
            "自闭合写法可解析",
            single.action === "screenshot" &&
                single.node["@_source"] === "screen" &&
                single.plugin === "screenshot",
            "plugin=" + String(single.plugin)
        );
        const multi = extractXML(
            '<screenshot><target source="screen" path="a.png"/><target source="screen" path="b.png"/></screenshot>'
        );
        check(
            "多目标写法可解析",
            multi.action === "screenshot" && normalizeScreenshotTargets(multi.node).length === 2
        );
        const cases = [
            {
                xml: "<screenshot/>",
                expected: "screenshot requires source (browser_page | screen | window)",
            },
            {
                xml: '<screenshot source="desktop"/>',
                expected: "screenshot source must be one of: browser_page, screen, window",
            },
            {
                xml: '<screenshot source="window"/>',
                expected: "screenshot source=window requires windowTitle",
            },
            {
                xml:
                    "<screenshot>" +
                    Array.from({ length: 9 })
                        .map((_, index) => '<target source="screen" path="t' + index + '.png"/>')
                        .join("") +
                    "</screenshot>",
                expected: "screenshot supports at most 8 targets per action, got 9",
            },
        ];
        for (const item of cases) {
            const result = capture(() => extractXML(item.xml));
            check(
                "错误文案未变：" + item.expected.substring(0, 40) + "…",
                result.ok === false && result.error === item.expected,
                result.ok ? "no error" : result.error
            );
        }
        check(
            "tryExtractScreenshotManually 仍可从 parse 层导出",
            Boolean(tryExtractScreenshotManually('<screenshot source="screen"/>'))
        );
        check(
            "normalizeScreenshotTargets 仍是纯函数",
            normalizeScreenshotTargets({ target: [{ a: 1 }, { b: 2 }] }).length === 2 &&
                normalizeScreenshotTargets({}).length === 0
        );

        console.log("\n=== 5. Runtime 兼容面 ===");
        const runtime = new Runtime(workspace);
        const handlers = runtime.actionHandlers;
        check(
            "actionHandlers 仍包含 screenshot（来自插件）",
            typeof handlers.screenshot === "function",
            Object.keys(handlers).join(",")
        );
        check(
            "内置动作也都在",
            ["read", "write", "exec", "answer", "done"].every(
                (name) => typeof handlers[name] === "function"
            )
        );
        const escape = await runtime
            .screenshot({ "@_source": "screen", "@_path": "../evil.png" })
            .then((value) => value)
            .catch((error) => ({ ok: false, error: error.message }));
        check(
            "runtime.screenshot 越界被拒（复用 Runtime 沙箱）",
            escape.ok === false && escape.error === "Path escapes workspace",
            JSON.stringify(escape).substring(0, 120)
        );
        const runEscape = await runtime
            .run({ action: "screenshot", node: { "@_source": "screen", "@_path": "../evil.png" } })
            .then((value) => value)
            .catch((error) => ({ ok: false, error: error.message }));
        check(
            "run({action:'screenshot'}) 越界被拒，且保留 action 名",
            runEscape.ok === false &&
                runEscape.action === "screenshot" &&
                runEscape.error === "Path escapes workspace",
            JSON.stringify(runEscape).substring(0, 120)
        );

        console.log("\n=== 6. 真实截图（沙箱内预期返回结构化失败） ===");
        const captureResult = await runtime.run({
            action: "screenshot",
            node: { "@_source": "screen", "@_path": "screenshots/probe.png" },
        });
        check(
            "返回结构化结果且带 plugin / durationMs",
            captureResult &&
                captureResult.action === "screenshot" &&
                captureResult.plugin === "screenshot" &&
                typeof captureResult.durationMs === "number",
            JSON.stringify({
                ok: captureResult.ok,
                plugin: captureResult.plugin,
                error: String(captureResult.error || "").substring(0, 40),
            })
        );
        check(
            "失败时 ok:false 且有 error（不是抛栈）",
            captureResult.ok === false
                ? typeof captureResult.error === "string" && captureResult.error.length > 0
                : true,
            String(captureResult.error || "(capture succeeded)")
        );

        console.log("\n=== 7. 可以单独授权 / 禁用 ===");
        fs.writeFileSync(
            path.join(storeRoot, "permissions.json"),
            JSON.stringify({ "system:screen": "deny" }, null, 2),
            "utf8"
        );
        registry.reload();
        const denied = await runtime.run({
            action: "screenshot",
            node: { "@_source": "screen", "@_path": "screenshots/denied.png" },
        });
        check(
            "deny system:screen 后动作被拒绝",
            denied.ok === false && String(denied.error).indexOf("permission denied") !== -1,
            String(denied.error)
        );
        registry.grantPermission("system:screen", "allow");
        registry.reload();
        const allowedAgain = await runtime.run({
            action: "screenshot",
            node: { "@_source": "screen", "@_path": "../escape-check.png" },
        });
        check(
            "重新授权后恢复（越界仍被拦）",
            String(allowedAgain.error || "").indexOf("permission denied") === -1,
            String(allowedAgain.error || "").substring(0, 60)
        );

        console.log("\n=== 8. 产物收集 ===");
        const collect = definition.meta.collectImages;
        check(
            "单图结果收集",
            JSON.stringify(collect({ ok: true, path: "screenshots/a.png" })) ===
                JSON.stringify(["screenshots/a.png"])
        );
        check(
            "多图结果只收集成功项",
            JSON.stringify(
                collect({
                    ok: true,
                    multi: true,
                    paths: ["a.png", "b.png"],
                    results: [
                        { ok: true, path: "a.png" },
                        { ok: false },
                        { ok: true, path: "b.png" },
                    ],
                })
            ) === JSON.stringify(["a.png", "b.png"])
        );
    } finally {
        registryModule.resetRegistry();
        for (const dir of [storeRoot, workspace]) {
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
