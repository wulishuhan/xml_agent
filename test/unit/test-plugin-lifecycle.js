/**
插件生命周期与隔离单测

这里钉住的是四条曾经真的坏掉、且坏得很安静的契约：

1. 坏插件必须看得见：清单缺失 / JSON 非法 / 缺 index.js 的插件原来只进 errors 数组，
   /api/plugins 里根本查不到，用户没有任何修复入口；
2. 密钥按权限下发：setup 期原本无条件拿到 secrets.json 全量内容，
   一个没声明 secrets:read 的插件也能读走所有凭据；
3. 热重载要真的换代码：原来只删 index.js 的 require 缓存，
   改了被 require 的 lib/helper.js 重载后仍是旧逻辑；
4. 卸载要能收摊：原来没有 teardown，setup 里注册的定时器每重载一次泄漏一份。

运行：node test/unit/test-plugin-lifecycle.js
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRegistry } = require("../../plugins/registry");

let pass = 0;
let total = 0;

async function check(name, fn) {
    total += 1;
    try {
        await fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-life-"));
    const builtinDir = path.join(root, "builtin");
    const userDir = path.join(root, "plugins");
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    return { root, builtinDir, userDir };
}

function writePlugin(dir, name, manifest, source, extraFiles) {
    const pluginDir = path.join(dir, name);
    fs.mkdirSync(pluginDir, { recursive: true });
    if (manifest !== null) {
        const text = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2);
        fs.writeFileSync(path.join(pluginDir, "plugin.json"), text, "utf8");
    }
    if (source !== null) {
        fs.writeFileSync(path.join(pluginDir, "index.js"), source, "utf8");
    }
    for (const [rel, text] of extraFiles || []) {
        const target = path.join(pluginDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, "utf8");
    }
    return pluginDir;
}

function manifest(name, overrides) {
    return Object.assign({ name, version: "1.0.0", apiVersion: 1 }, overrides || {});
}

function makeRegistry(store, options) {
    const registry = createRegistry(
        Object.assign(
            {
                storeRoot: store.root,
                builtinDir: store.builtinDir,
                logger: silentLogger,
            },
            options || {}
        )
    );
    registry.load();
    return registry;
}

function statusOf(registry, name) {
    return registry.getStatus().filter((item) => item.name === name)[0] || null;
}

async function main() {
    // ------------------------------------------------------------
    // 1. 坏插件可见性
    // ------------------------------------------------------------
    await check("缺 plugin.json 的插件以 error 状态出现，而不是消失", () => {
        const store = makeStore();
        writePlugin(store.userDir, "broken", null, "module.exports={setup(){}};");
        const registry = makeRegistry(store);

        const status = statusOf(registry, "broken");
        assert.ok(status, "坏插件必须出现在 getStatus() 里");
        assert.strictEqual(status.status, "error");
        assert.ok(status.error.indexOf("plugin.json") !== -1, "错误原因要说明缺清单");
        assert.strictEqual(registry.getPlugin("broken").broken, true);
    });

    await check("plugin.json 是坏 JSON 时同样可见", () => {
        const store = makeStore();
        writePlugin(store.userDir, "bad-json", "{ this is not json", "module.exports={};");
        const registry = makeRegistry(store);

        const status = statusOf(registry, "bad-json");
        assert.ok(status);
        assert.strictEqual(status.status, "error");
        assert.ok(status.error.indexOf("JSON") !== -1);
    });

    await check("清单正常但缺 index.js 时同样可见", () => {
        const store = makeStore();
        writePlugin(store.userDir, "no-entry", manifest("no-entry"), null);
        const registry = makeRegistry(store);

        const status = statusOf(registry, "no-entry");
        assert.ok(status);
        assert.strictEqual(status.status, "error");
        assert.ok(status.error.indexOf("index.js") !== -1);
    });

    await check("坏插件的配置查询不抛错（前端能安全渲染）", () => {
        const store = makeStore();
        writePlugin(store.userDir, "broken", null, "module.exports={};");
        const registry = makeRegistry(store);

        const status = statusOf(registry, "broken");
        assert.deepStrictEqual(status.config, {});
        assert.deepStrictEqual(status.permissions, []);
        assert.deepStrictEqual(status.configSchema, {});
        assert.strictEqual(registry.hasAction("broken"), false);
    });

    // ------------------------------------------------------------
    // 2. 密钥按权限下发
    // ------------------------------------------------------------
    await check("未声明 secrets:read 的插件在 setup 期读不到密钥", () => {
        const store = makeStore();
        fs.writeFileSync(
            path.join(store.root, "secrets.json"),
            JSON.stringify({ API_KEY: "super-secret" }),
            "utf8"
        );
        writePlugin(
            store.userDir,
            "peek",
            manifest("peek", { permissions: [] }),
            "module.exports={setup(ctx){ global.__peek1 = ctx.secrets.get('API_KEY'); }};"
        );
        makeRegistry(store);

        assert.strictEqual(global.__peek1, null);
        delete global.__peek1;
    });

    await check("清单声明 + 策略放行（内置插件）时能读到密钥", () => {
        const store = makeStore();
        fs.writeFileSync(
            path.join(store.root, "secrets.json"),
            JSON.stringify({ API_KEY: "super-secret" }),
            "utf8"
        );
        writePlugin(
            store.builtinDir,
            "peek-builtin",
            manifest("peek-builtin", { permissions: ["secrets:read"] }),
            "module.exports={setup(ctx){ global.__peek2 = ctx.secrets.get('API_KEY'); }};"
        );
        makeRegistry(store);

        assert.strictEqual(global.__peek2, "super-secret");
        delete global.__peek2;
    });

    await check("用户插件声明了 secrets:read 但策略是 ask 时仍读不到", () => {
        const store = makeStore();
        fs.writeFileSync(
            path.join(store.root, "secrets.json"),
            JSON.stringify({ API_KEY: "super-secret" }),
            "utf8"
        );
        writePlugin(
            store.userDir,
            "peek-user",
            manifest("peek-user", { permissions: ["secrets:read"] }),
            "module.exports={setup(ctx){ global.__peek3 = ctx.secrets.get('API_KEY'); }};"
        );
        const registry = makeRegistry(store);

        assert.strictEqual(global.__peek3, null, "ask 在 v1 语义下等于未授权");
        assert.strictEqual(registry.getPolicy("secrets:read"), "ask");
        delete global.__peek3;
    });

    await check("授权后重载即可读到密钥", () => {
        const store = makeStore();
        fs.writeFileSync(
            path.join(store.root, "secrets.json"),
            JSON.stringify({ API_KEY: "super-secret" }),
            "utf8"
        );
        writePlugin(
            store.userDir,
            "peek-user",
            manifest("peek-user", { permissions: ["secrets:read"] }),
            "module.exports={setup(ctx){ global.__peek4 = ctx.secrets.get('API_KEY'); }};"
        );
        const registry = makeRegistry(store);
        assert.strictEqual(global.__peek4, null);

        registry.grantPermission("secrets:read", "allow");
        registry.reload();
        assert.strictEqual(global.__peek4, "super-secret");
        delete global.__peek4;
    });

    await check("run 期密钥同样按动作声明门控", async () => {
        const store = makeStore();
        fs.writeFileSync(
            path.join(store.root, "secrets.json"),
            JSON.stringify({ API_KEY: "super-secret" }),
            "utf8"
        );
        writePlugin(
            store.userDir,
            "runner",
            manifest("runner", { permissions: ["secrets:read"] }),
            [
                "module.exports={setup(ctx){",
                "  ctx.actions.register({",
                "    name: 'peek-no-scope',",
                "    meta: { prompt: { usage: '<peek-no-scope/>' } },",
                "    run: (node, c) => ({ ok: true, value: c.secrets.get('API_KEY') }),",
                "  });",
                "  ctx.actions.register({",
                "    name: 'peek-with-scope',",
                "    meta: { prompt: { usage: '<peek-with-scope/>' }, permission: ['secrets:read'] },",
                "    run: (node, c) => ({ ok: true, value: c.secrets.get('API_KEY') }),",
                "  });",
                "}};",
            ].join("\n")
        );
        const registry = makeRegistry(store);
        registry.grantPermission("secrets:read", "allow");
        registry.reload();

        const without = await registry.invokeAction("peek-no-scope", {}, {});
        const withScope = await registry.invokeAction("peek-with-scope", {}, {});
        assert.strictEqual(without.ok, true);
        assert.strictEqual(without.value, null, "动作没声明 secrets:read 就不该拿到值");
        assert.strictEqual(withScope.value, "super-secret");
    });

    await check("动作结果带 mutating 标记", async () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "marks",
            manifest("marks"),
            [
                "module.exports={setup(ctx){",
                "  ctx.actions.register({ name: 'ro', meta: { prompt: { usage: '<ro/>' } },",
                "    run: () => ({ ok: true }) });",
                "  ctx.actions.register({ name: 'rw', meta: { prompt: { usage: '<rw/>' }, mutating: true },",
                "    run: () => ({ ok: true }) });",
                "}};",
            ].join("\n")
        );
        const registry = makeRegistry(store);

        assert.strictEqual((await registry.invokeAction("ro", {}, {})).mutating, false);
        assert.strictEqual((await registry.invokeAction("rw", {}, {})).mutating, true);
    });

    // ------------------------------------------------------------
    // 3. 热重载
    // ------------------------------------------------------------
    await check("reload 会重新执行被 require 的子模块", () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "hot",
            manifest("hot"),
            'const lib=require("./lib"); module.exports={setup(){ global.__hot = lib.value; }};',
            [["lib.js", 'module.exports={value:"v1"};']]
        );
        const registry = makeRegistry(store);
        assert.strictEqual(global.__hot, "v1");

        fs.writeFileSync(
            path.join(store.userDir, "hot", "lib.js"),
            'module.exports={value:"v2"};',
            "utf8"
        );
        registry.reload();
        assert.strictEqual(global.__hot, "v2", "子模块必须跟着重载");
        delete global.__hot;
    });

    await check("setup 里注册的清理函数按逆序执行", () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "cleanup",
            manifest("cleanup"),
            [
                "module.exports={setup(ctx){",
                "  global.__order = global.__order || [];",
                "  ctx.onDispose(() => global.__order.push('first'));",
                "  ctx.onDispose(() => global.__order.push('second'));",
                "}};",
            ].join("\n")
        );
        const registry = makeRegistry(store);
        assert.deepStrictEqual(global.__order, []);

        registry.reload();
        assert.deepStrictEqual(global.__order, ["second", "first"]);
        delete global.__order;
    });

    await check("module.exports.dispose 也会被调用", () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "module-dispose",
            manifest("module-dispose"),
            "module.exports={setup(){}, dispose(){ global.__moduleDisposed = true; }};"
        );
        const registry = makeRegistry(store);
        registry.reload();

        assert.strictEqual(global.__moduleDisposed, true);
        delete global.__moduleDisposed;
    });

    await check("注册冲突导致加载失败时，setup 申请的资源也会释放", () => {
        const store = makeStore();
        const actionSource = functionSource("dup");
        writePlugin(store.userDir, "alpha", manifest("alpha"), actionSource);
        writePlugin(
            store.userDir,
            "beta",
            manifest("beta"),
            [
                "module.exports={setup(ctx){",
                "  ctx.onDispose(() => { global.__betaDisposed = true; });",
                "  ctx.actions.register({",
                "    name: 'dup',",
                "    meta: { prompt: { usage: '<dup/>' } },",
                "    run: () => ({ ok: true }),",
                "  });",
                "}};",
            ].join("\n")
        );
        const registry = makeRegistry(store);

        const beta = statusOf(registry, "beta");
        assert.strictEqual(beta.status, "error");
        assert.ok(beta.error.indexOf("dup") !== -1);
        assert.strictEqual(global.__betaDisposed, true, "冲突插件必须当场收摊");
        delete global.__betaDisposed;
    });

    await check("清理函数抛错不影响 reload", () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "bad-dispose",
            manifest("bad-dispose"),
            "module.exports={setup(ctx){ ctx.onDispose(() => { throw new Error('boom'); }); }};"
        );
        const registry = makeRegistry(store);
        registry.reload();

        assert.strictEqual(statusOf(registry, "bad-dispose").status, "loaded");
    });

    await check("unload 后动作表清空，清理函数已执行", () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "act",
            manifest("act"),
            [
                "module.exports={setup(ctx){",
                "  ctx.onDispose(() => { global.__actUnloaded = true; });",
                "  ctx.actions.register({",
                "    name: 'act-do',",
                "    meta: { prompt: { usage: '<act-do/>' } },",
                "    run: () => ({ ok: true }),",
                "  });",
                "}};",
            ].join("\n")
        );
        const registry = makeRegistry(store);
        assert.strictEqual(registry.hasAction("act-do"), true);

        registry.unload();
        assert.strictEqual(global.__actUnloaded, true);
        assert.strictEqual(registry.hasAction("act-do"), false);
        // 卸载后不能"下次查询又自动扫回来"
        assert.strictEqual(registry.getPlugin("act"), null);
        delete global.__actUnloaded;
    });

    // ------------------------------------------------------------
    // 4. 读盘缓存
    // ------------------------------------------------------------
    await check("外部修改配置文件后能立刻读到（缓存按 mtime 失效）", () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "cfg",
            manifest("cfg", {
                configSchema: { allowHosts: { type: "array", default: [] } },
            }),
            "module.exports={setup(){}};"
        );
        const registry = makeRegistry(store);
        assert.deepStrictEqual(registry.getConfig("cfg").allowHosts, []);

        fs.writeFileSync(
            path.join(store.root, "plugins-config.json"),
            JSON.stringify({ cfg: { allowHosts: ["example.com"] } }),
            "utf8"
        );
        assert.deepStrictEqual(registry.getConfig("cfg").allowHosts, ["example.com"]);
    });

    await check("外部修改权限文件后策略立刻生效", () => {
        const store = makeStore();
        writePlugin(store.userDir, "pol", manifest("pol", { permissions: ["network:http"] }), "");
        const registry = makeRegistry(store);
        assert.strictEqual(registry.getPolicy("network:http", registry.getPlugin("pol")), "ask");

        fs.writeFileSync(
            path.join(store.root, "permissions.json"),
            JSON.stringify({ "network:http": "allow" }),
            "utf8"
        );
        assert.strictEqual(registry.getPolicy("network:http", registry.getPlugin("pol")), "allow");
    });

    // ------------------------------------------------------------
    // 5. provider 冲突与符号链接
    // ------------------------------------------------------------
    await check("provider 与内置 id 重名时加载失败，而不是被静默丢弃", () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "clash",
            manifest("clash", { kind: "provider" }),
            [
                "module.exports={setup(ctx){",
                "  ctx.providers.register('chatgpt', () => ({ start(){}, send(){}, close(){} }), {});",
                "}};",
            ].join("\n")
        );
        const registry = makeRegistry(store);

        const status = statusOf(registry, "clash");
        assert.strictEqual(status.status, "error");
        assert.ok(status.error.indexOf("内置 provider") !== -1, status.error);
        assert.strictEqual(registry.providers.has("chatgpt"), false);
    });

    await check("两个插件抢同一 provider id 时后者失败", () => {
        const store = makeStore();
        const source = (id) =>
            [
                "module.exports={setup(ctx){",
                "  ctx.providers.register('" +
                    id +
                    "', () => ({ start(){}, send(){}, close(){} }), {});",
                "}};",
            ].join("\n");
        writePlugin(store.userDir, "aa-first", manifest("aa-first"), source("shared-llm"));
        writePlugin(store.userDir, "zz-second", manifest("zz-second"), source("shared-llm"));
        const registry = makeRegistry(store);

        assert.strictEqual(statusOf(registry, "aa-first").status, "loaded");
        assert.strictEqual(statusOf(registry, "zz-second").status, "error");
        assert.ok(statusOf(registry, "zz-second").error.indexOf("shared-llm") !== -1);
    });

    await check("符号链接的插件目录也会被加载（开发时不用复制）", () => {
        const store = makeStore();
        const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-real-"));
        fs.writeFileSync(
            path.join(realDir, "plugin.json"),
            JSON.stringify(manifest("linked")),
            "utf8"
        );
        fs.writeFileSync(
            path.join(realDir, "index.js"),
            "module.exports={setup(ctx){ctx.actions.register({name:'linked-do',meta:{prompt:{usage:'<linked-do/>'}},run:()=>({ok:true})});}};",
            "utf8"
        );
        try {
            fs.symlinkSync(
                realDir,
                path.join(store.userDir, "linked"),
                process.platform === "win32" ? "junction" : "dir"
            );
        } catch (error) {
            // Windows 非开发者模式可能没有创建链接的权限，此时跳过
            console.log("  (skip: 无法创建符号链接 " + error.code + ")");
            return;
        }
        const registry = makeRegistry(store);

        assert.strictEqual(statusOf(registry, "linked").status, "loaded");
        assert.strictEqual(registry.hasAction("linked-do"), true);
    });

    // ------------------------------------------------------------
    // 6. 插件 HTTP 接口超时
    // ------------------------------------------------------------
    await check("插件接口永不 resolve 时返回 504，而不是挂住请求", async () => {
        const store = makeStore();
        writePlugin(
            store.userDir,
            "slow",
            manifest("slow"),
            [
                "module.exports={setup(ctx){",
                "  ctx.api.get('/never', () => new Promise(() => {}));",
                "  ctx.api.get('/quick', () => ({ ok: true }));",
                "}};",
            ].join("\n")
        );
        const registry = makeRegistry(store, { apiTimeoutMs: 50 });

        const quick = await registry.callPluginApi("slow", "GET", "/quick");
        assert.strictEqual(quick.status, 200);
        assert.strictEqual(quick.body.ok, true);

        const slow = await registry.callPluginApi("slow", "GET", "/never");
        assert.strictEqual(slow.status, 504);
        assert.strictEqual(slow.body.code, "PLUGIN_API_TIMEOUT");
    });

    // ------------------------------------------------------------
    // 7. 密钥管理
    // ------------------------------------------------------------
    await check("密钥接口只回键名与长度，不回值", () => {
        const store = makeStore();
        const registry = makeRegistry(store);

        const list = registry.setSecret("OPENAI_KEY", "sk-123456");
        assert.deepStrictEqual(list, [{ key: "OPENAI_KEY", length: 9 }]);
        assert.strictEqual(JSON.stringify(list).indexOf("sk-123456"), -1);

        const removed = registry.deleteSecret("OPENAI_KEY");
        assert.strictEqual(removed.removed, true);
        assert.deepStrictEqual(removed.secrets, []);
    });

    await check("非法密钥名与空值被拒绝", () => {
        const store = makeStore();
        const registry = makeRegistry(store);

        assert.throws(() => registry.setSecret("../evil", "x"), /密钥名非法/);
        assert.throws(() => registry.setSecret("__proto__", "x"), /密钥名非法/);
        assert.throws(() => registry.setSecret("OK_KEY", ""), /不能为空/);
    });

    await check("删除不存在的密钥返回 removed:false", () => {
        const store = makeStore();
        const registry = makeRegistry(store);
        assert.strictEqual(registry.deleteSecret("NOPE").removed, false);
    });

    console.log("\n" + pass + "/" + total + " passed");
    if (pass !== total) {
        process.exitCode = 1;
    }
}

/** 注册一个动作名为 actionName 的最小插件源码 */
function functionSource(actionName) {
    return [
        "module.exports={setup(ctx){",
        "  ctx.actions.register({",
        "    name: '" + actionName + "',",
        "    meta: { prompt: { usage: '<" + actionName + "/>' } },",
        "    run: () => ({ ok: true }),",
        "  });",
        "}};",
    ].join("\n");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
