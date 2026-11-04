/**
Provider 契约与注册表测试

覆盖：
1. 内置 provider 元数据（id / 显示名 / 默认地址 / 会话 id 正则）
2. 访问地址解析（配置覆盖 > provider 默认）
3. 契约校验（缺少 start/send/close 的 provider 必须被拒绝）
4. 会话 id 规范化（含此前 server 端漏掉的 GLM /s/<id>）
5. 插件 provider 接入（ctx.providers.register → list / create / 会话 id 解析）
6. 不再漂移：config 的 targetUrls 不能重新写死 provider 地址

运行：node test/test-provider-registry.js
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const providers = require("../providers");
const registry = providers.registry;
const schema = require("../config/schema");
const pluginRegistryModule = require("../plugins/registry");

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
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-provider-store-"));
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-provider-user-"));
    const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

    try {
        console.log("=== 1. 内置 provider 元数据 ===");
        const list = providers.listProviders();
        const ids = list.map((item) => item.id);
        check(
            "五个内置 provider 都已注册（顺序即前端下拉顺序）",
            JSON.stringify(ids) ===
                JSON.stringify(["chatgpt", "qwen", "deepseek", "glm", "gemini"]),
            ids.join(",")
        );
        check(
            "全部标记为 builtin 且支持图片",
            list.every((item) => item.source === "builtin" && item.supportsImages === true)
        );
        check(
            "每个 provider 都有默认访问地址",
            list.every(
                (item) => typeof item.defaultTargetUrl === "string" && item.defaultTargetUrl
            ),
            list.map((item) => item.id + "=" + item.defaultTargetUrl).join(" , ")
        );
        check(
            "每个 provider 都有会话 id 正则",
            list.every((item) => typeof item.conversationIdPattern === "string")
        );
        check(
            "GLM 默认地址为 zchat.z.ai（1.0.7 的调整保住了）",
            providers.getProviderMeta("glm").defaultTargetUrl === "https://zchat.z.ai"
        );
        check(
            "列表可直接 JSON 化（正则已转成字符串）",
            (() => {
                try {
                    JSON.parse(JSON.stringify(list));
                    return true;
                } catch (error) {
                    return false;
                }
            })()
        );
        check("未知 provider 返回 null", providers.getProviderMeta("no-such-provider") === null);

        console.log("\n=== 2. 访问地址解析 ===");
        check(
            "默认地址来自 provider 元数据",
            providers.resolveTargetUrl("deepseek") === "https://chat.deepseek.com",
            providers.resolveTargetUrl("deepseek")
        );
        check(
            "配置覆盖优先",
            providers.resolveTargetUrl("deepseek", { deepseek: "https://custom.example" }) ===
                "https://custom.example"
        );
        check(
            "空白覆盖被忽略",
            providers.resolveTargetUrl("deepseek", { deepseek: "   " }) ===
                "https://chat.deepseek.com"
        );
        check("未知 provider 的地址为空串", providers.resolveTargetUrl("nope") === "");

        console.log("\n=== 3. 契约校验 ===");
        const deepseekInstance = providers.createProvider("deepseek", {});
        check(
            "内置 provider 可创建且符合契约",
            typeof deepseekInstance.start === "function" &&
                typeof deepseekInstance.send === "function" &&
                typeof deepseekInstance.close === "function"
        );
        check(
            "缺少必需方法的实例被拒绝",
            (() => {
                const result = capture(() =>
                    registry.assertProviderInstance({ start() {}, send() {} }, "broken")
                );
                return !result.ok && result.error.indexOf("close") !== -1;
            })()
        );
        check(
            "类缺少必需方法时在注册期就报错",
            (() => {
                function BadProvider() {}
                BadProvider.prototype.start = function () {};
                const result = capture(() => registry.assertProviderFactory(BadProvider, "bad"));
                return !result.ok && result.error.indexOf("send") !== -1;
            })()
        );
        check(
            "定义缺少 create 工厂时报错",
            (() => {
                const result = capture(() => registry.normalizeDefinition({ id: "x" }));
                return !result.ok && result.error.indexOf("create") !== -1;
            })()
        );
        check(
            "未知 id 创建时报 Unknown provider",
            (() => {
                const result = capture(() => providers.createProvider("nope"));
                return !result.ok && result.error === "Unknown provider: nope";
            })()
        );

        console.log("\n=== 4. 会话 id 规范化 ===");
        const cases = [
            [
                "deepseek",
                "9efa4714-38db-4038-a971-226570f7155d",
                "9efa4714-38db-4038-a971-226570f7155d",
            ],
            [
                "deepseek",
                "https://chat.deepseek.com/a/chat/s/9efa4714-38db-4038-a971-226570f7155d",
                "9efa4714-38db-4038-a971-226570f7155d",
            ],
            ["deepseek", "https://chat.deepseek.com", null],
            ["deepseek", "https://chat.deepseek.com/a/chat/", null],
            ["chatgpt", "https://chatgpt.com/c/6712abcd-1234", "6712abcd-1234"],
            ["chatgpt", "6712abcd-1234", "6712abcd-1234"],
            ["qwen", "https://chat.qwen.ai/c/abcd-1234", "abcd-1234"],
            // 下面这条是本次修复：provider 自己支持 /s/<id>，但 server 端此前只认 /c/<id>
            ["glm", "https://zchat.z.ai/s/abc-123", "abc-123"],
            ["glm", "https://zchat.z.ai/c/abc-123", "abc-123"],
            // 未声明正则的 provider 回落默认 /c/<id>（保持 1.0.x 行为）
            ["some-unknown", "https://x.example/c/xyz-9", "xyz-9"],
            ["deepseek", "", null],
            ["deepseek", "   ", null],
            ["deepseek", null, null],
            ["deepseek", undefined, null],
        ];
        let mismatched = 0;
        for (const [providerId, raw, expected] of cases) {
            const actual = providers.normalizeConversationId(providerId, raw);
            const ok = actual === expected;
            if (!ok) {
                mismatched += 1;
            }
            check(
                "conversationId（" + providerId + "，" + JSON.stringify(raw) + "）",
                ok,
                "got=" + JSON.stringify(actual)
            );
        }
        check("会话 id 用例全部一致", mismatched === 0, String(mismatched) + " mismatch");

        console.log("\n=== 5. 插件 provider ===");
        writePlugin(
            userDir,
            "fake-provider",
            { kind: "provider", permissions: [], description: "测试用 provider" },
            `
module.exports = {
    setup(ctx) {
        ctx.providers.register(
            "fake-llm",
            () => ({
                start: async () => {},
                send: async (prompt) => "echo:" + prompt,
                close: async () => {},
                uploadImages: async () => ({ ok: true, count: 0 }),
                currentConversationId: null,
            }),
            {
                label: "Fake LLM",
                targetUrl: "https://fake.example",
                conversationIdPattern: "/x/([0-9]+)",
                supportsImages: true,
            }
        );
        ctx.providers.register("broken-llm", () => ({ start: async () => {} }), {
            label: "Broken LLM",
        });
    },
};
`
        );
        const pluginRegistry = pluginRegistryModule.createRegistry({
            storeRoot,
            dirs: [userDir],
            logger: silentLogger,
        });
        pluginRegistry.load();
        pluginRegistryModule.setRegistryForTests(pluginRegistry);

        const listWithPlugins = providers.listProviders();
        const fake = listWithPlugins.filter((item) => item.id === "fake-llm")[0];
        check(
            "插件 provider 出现在列表里",
            Boolean(fake) && fake.source === "plugin" && fake.plugin === "fake-provider",
            JSON.stringify(fake)
        );
        check(
            "插件 provider 的元数据被采纳",
            Boolean(fake) &&
                fake.label === "Fake LLM" &&
                fake.defaultTargetUrl === "https://fake.example",
            fake ? fake.defaultTargetUrl : "missing"
        );
        check(
            "插件 provider 可创建",
            (() => {
                const instance = providers.createProvider("fake-llm", {});
                return typeof instance.send === "function";
            })()
        );
        check(
            "插件 provider 的会话 id 正则生效",
            providers.normalizeConversationId("fake-llm", "https://fake.example/x/42") === "42"
        );
        check(
            "缺少必需方法的插件 provider 被拒绝",
            (() => {
                const result = capture(() => providers.createProvider("broken-llm", {}));
                return !result.ok && result.error.indexOf("send") !== -1;
            })()
        );

        console.log("\n=== 6. 不再漂移 ===");
        check(
            "config 的 browser.targetUrls 不再写死 provider 地址",
            Object.keys(schema.buildDefaults().browser.targetUrls).length === 0,
            JSON.stringify(schema.buildDefaults().browser.targetUrls)
        );
        check(
            "provider 地址只来自 provider 元数据",
            providers.resolveTargetUrl("chatgpt") === "https://chatgpt.com" &&
                providers.resolveTargetUrl("qwen") === "https://chat.qwen.ai"
        );
    } finally {
        pluginRegistryModule.resetRegistry();
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
