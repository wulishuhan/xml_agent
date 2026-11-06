/**
探针结论的回归测试（对抗性测试发现的 6 个缺陷）

1. 工作区沙箱可被 junction / 符号链接绕过（path.resolve 只看字符串前缀）；
2. Windows 保留设备名与 NTFS 数据流写法被当成普通文件名
   —— 写 CON 报告成功但文件不存在，读 a.txt:stream 抛 EINVAL；
3. exec 输出超 maxBuffer 时 stdoutTruncated 仍是 false，且只留头部，
   失败摘要（在尾部）全丢；
4. 命令里任意位置出现 " --background" 就被当后台任务，并且这段文本会被从命令里删掉；
5. write 的快速解析不去解码属性实体，与 read / 通用解析路径不一致
   （写进去 a&amp;b.txt，按 a&amp;b.txt 读不到）；
6. read 把二进制当文本塞进提示词；插件超时定时器 unref 后形同虚设；
   emitHook 对抛错的 handler 不计数；
7. configSchema 只有类型没有上下限，keepDays:-5 能通过校验；
   坏 JSON 请求体会回一页带堆栈和绝对路径的 HTML。

运行：node test/unit/test-hardening.js
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { createRuntime } = require("../../runtime");
const { getBuiltinAction } = require("../../actions");
const { extractXML } = require("../../parse/xml-parse");
const { createRegistry } = require("../../plugins/registry");
const sdk = require("../../plugins/sdk");

let pass = 0;
let total = 0;
const skipped = [];

async function check(name, fn) {
    total += 1;
    try {
        await fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        if (error && error.skip) {
            skipped.push(name);
            console.log("SKIP - " + name + "  [" + error.message + "]");
            return;
        }
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

function skip(message) {
    const error = new Error(message);
    error.skip = true;
    return error;
}

function makeWorkspace(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const IS_WINDOWS = process.platform === "win32";

// ------------------------------------------------------------
// A. 工作区沙箱
// ------------------------------------------------------------

async function testSandbox() {
    const workspace = makeWorkspace("hard-sandbox-");
    const runtime = createRuntime(workspace);

    await check("普通相对路径仍解析到工作区内", () => {
        const full = runtime.resolvePath("src/a.js");
        assert.strictEqual(full, path.join(workspace, "src", "a.js"));
    });

    await check("上级跳转仍被拒绝", () => {
        assert.throws(() => runtime.resolvePath("../out.txt"), /Path escapes workspace/);
    });

    await check("junction/符号链接逃逸被拒绝", () => {
        const outside = makeWorkspace("hard-outside-");
        fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
        const link = path.join(workspace, "link");
        try {
            fs.symlinkSync(outside, link, "junction");
        } catch (error) {
            throw skip("当前环境不允许创建 junction：" + error.code);
        }
        assert.throws(() => runtime.resolvePath("link/secret.txt"), /Path escapes workspace/);
        assert.throws(() => runtime.resolvePath("link/new-file.txt"), /Path escapes workspace/);
    });

    await check("指向工作区内部的 junction 仍可用", () => {
        const inside = path.join(workspace, "real");
        fs.mkdirSync(inside, { recursive: true });
        const link = path.join(workspace, "inner-link");
        try {
            fs.symlinkSync(inside, link, "junction");
        } catch (error) {
            throw skip("当前环境不允许创建 junction：" + error.code);
        }
        assert.strictEqual(runtime.resolvePath("inner-link/a.txt"), path.join(link, "a.txt"));
    });

    await check("Windows 保留设备名被拒绝", () => {
        if (!IS_WINDOWS) {
            throw skip("仅 Windows");
        }
        for (const name of ["CON", "NUL", "aux.txt", "com1"]) {
            assert.throws(
                () => runtime.resolvePath(name),
                /reserved device name/,
                name + " 应该被拒绝"
            );
        }
    });

    await check("NTFS 数据流写法被拒绝", () => {
        if (!IS_WINDOWS) {
            throw skip("仅 Windows");
        }
        assert.throws(() => runtime.resolvePath("a.txt:stream"), /data stream/);
    });
}

// ------------------------------------------------------------
// B. exec
// ------------------------------------------------------------

async function testExec() {
    const workspace = makeWorkspace("hard-exec-");
    const runtime = createRuntime(workspace);
    const ctx = runtime.createBuiltinContext();

    fs.writeFileSync(
        path.join(workspace, "emit.js"),
        'process.stdout.write("HEAD\\n" + "1".repeat(2000000) + "\\nTAIL-MARKER");\n'
    );

    await check("超大输出：保留首尾并如实标记 truncated", async () => {
        const result = await getBuiltinAction("exec").run({ "@_command": "node emit.js" }, ctx);
        assert.strictEqual(result.ok, true, "命令本身是成功的");
        assert.strictEqual(result.outputTruncated, true, "必须标记为已截断");
        assert.ok(result.output.startsWith("HEAD"), "头部要保留");
        assert.ok(result.output.indexOf("TAIL-MARKER") !== -1, "尾部要保留");
        assert.ok(
            Buffer.byteLength(result.output, "utf8") <= 1048576,
            "回给模型的输出不能超过 maxExecOutputSize"
        );
        assert.ok(result.output.indexOf("output truncated") !== -1, "截断处要有标记");
    });

    fs.writeFileSync(path.join(workspace, "say.js"), 'console.log(" --background");\n');
    await check("命令里含 --background 字符串不会被误判为后台", async () => {
        const result = await getBuiltinAction("exec").run({ "@_command": "node say.js" }, ctx);
        assert.strictEqual(result.ok, true);
        assert.notStrictEqual(result.background, true);
        assert.ok(result.output.indexOf("--background") !== -1, "命令输出应原样保留");
    });

    fs.writeFileSync(path.join(workspace, "wait.js"), "setTimeout(function () {}, 20000);\n");
    await check("结尾的 --background 仍然进入后台", async () => {
        const result = await getBuiltinAction("exec").run(
            { "@_command": "node wait.js --background" },
            ctx
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.background, true);
        assert.strictEqual(typeof result.pid, "number");
        await runtime.killAllProcesses("test");
    });
}

// ------------------------------------------------------------
// C. write / read
// ------------------------------------------------------------

async function testWriteRead() {
    const workspace = makeWorkspace("hard-write-");
    const runtime = createRuntime(workspace);
    const ctx = runtime.createBuiltinContext();

    await check("快速解析路径解码属性实体（写与读一致）", () => {
        const parsed = extractXML('<write path="a&amp;b.txt"><![CDATA[hi]]></write>');
        const result = getBuiltinAction("write").run(parsed.node, ctx);
        assert.strictEqual(result.path, "a&b.txt");
        assert.ok(fs.existsSync(path.join(workspace, "a&b.txt")));

        const readNode = extractXML('<read path="a&amp;b.txt"/>');
        const readResult = getBuiltinAction("read").run(readNode.node, ctx);
        assert.strictEqual(readResult.ok, true, "刚写进去的文件必须读得到");
        assert.strictEqual(readResult.content, "hi");
    });

    await check("写目标是已存在目录时给出可读错误", () => {
        fs.mkdirSync(path.join(workspace, "adir"), { recursive: true });
        const result = getBuiltinAction("write").run({ "@_path": "adir", "#text": "x" }, ctx);
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /directory/i);
        assert.ok(result.error.indexOf(".tmp.") === -1, "错误信息不应泄漏临时文件名");
    });

    await check("write 保留文件末尾换行", () => {
        const parsed = extractXML('<write path="keep.js"><![CDATA[\nline1\n]]></write>');
        getBuiltinAction("write").run(parsed.node, ctx);
        const text = fs.readFileSync(path.join(workspace, "keep.js"), "utf8");
        assert.strictEqual(text, "line1\n");
    });

    await check("read 拒绝二进制文件并标记 binary", () => {
        fs.writeFileSync(path.join(workspace, "img.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
        const result = getBuiltinAction("read").run({ "@_path": "img.png" }, ctx);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.binary, true);
        assert.strictEqual(result.content, undefined, "不能把二进制内容带出去");
    });

    await check("read 仍能正常读文本", () => {
        fs.writeFileSync(path.join(workspace, "ok.txt"), "hello 世界\n");
        const result = getBuiltinAction("read").run({ "@_path": "ok.txt" }, ctx);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.content, "hello 世界\n");
    });
}

// ------------------------------------------------------------
// D. 插件运行时
// ------------------------------------------------------------

function writePlugin(root, name, manifest, source) {
    const dir = path.join(root, "plugins", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, "plugin.json"),
        JSON.stringify(Object.assign({ name, version: "1.0.0", apiVersion: 1 }, manifest))
    );
    fs.writeFileSync(path.join(dir, "index.js"), source);
}

async function testPluginRuntime() {
    // 超时看门狗：在一个"没有其它活跃句柄"的子进程里验证。
    // 修复前 runWithTimeout 把定时器 unref 了，子进程会直接 exit 0 且没有任何输出。
    await check("没有其它活跃句柄时，插件超时仍会触发", () => {
        const dir = makeWorkspace("hard-timeout-");
        const script = path.join(dir, "timeout-probe.js");
        const shared = path.join(__dirname, "..", "..", "plugins", "registry", "shared");
        fs.writeFileSync(
            script,
            [
                "const { runWithTimeout } = require(" + JSON.stringify(shared) + ");",
                "const controller = new AbortController();",
                "runWithTimeout(() => new Promise(() => {}), 120, controller).then(",
                '    () => console.log("UNEXPECTED-RESOLVE"),',
                '    (error) => console.log("TIMEOUT-" + error.code)',
                ");",
                "",
            ].join("\n")
        );
        const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5000 });
        assert.strictEqual(result.status, 0, "子进程应正常退出");
        assert.ok(
            result.stdout.indexOf("TIMEOUT-PLUGIN_TIMEOUT") !== -1,
            "超时必须触发，实际输出：" + JSON.stringify(result.stdout)
        );
    });

    await check("钩子抛错也计入 emitHook 返回值", () => {
        const root = makeWorkspace("hard-hook-");
        writePlugin(
            root,
            "hooker",
            { permissions: [] },
            [
                "module.exports = { setup(ctx) {",
                '    ctx.hooks.on("afterRun", () => { throw new Error("hook-boom"); });',
                "} };",
            ].join("\n")
        );
        const registry = createRegistry({
            storeRoot: root,
            builtinDir: path.join(root, "none"),
            logger: { debug() {}, info() {}, warn() {}, error() {} },
        });
        registry.load();
        assert.strictEqual(registry.emitHook("afterRun", {}), 1, "handler 抛错也要计入");
    });

    await check("插件动作挂住时返回 timedOut 而不是一直等待", async () => {
        const root = makeWorkspace("hard-action-");
        writePlugin(
            root,
            "slow",
            { permissions: ["workspace:read"] },
            [
                "module.exports = { setup(ctx) {",
                "    ctx.actions.register({",
                '        name: "slow-act",',
                "        run: () => new Promise(() => {}),",
                '        meta: { timeoutMs: 120, permission: ["workspace:read"], prompt: { usage: "<slow-act/>" } },',
                "    });",
                "} };",
            ].join("\n")
        );
        const registry = createRegistry({
            storeRoot: root,
            builtinDir: path.join(root, "none"),
            logger: { debug() {}, info() {}, warn() {}, error() {} },
        });
        registry.load();
        registry.grantPermission("workspace:read", "allow");
        // 保活句柄：模拟真实进程里还有别的 I/O 挂起
        const keepAlive = setInterval(() => {}, 1000);
        try {
            const result = await registry.invokeAction("slow-act", {}, { workspace: root });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.timedOut, true);
        } finally {
            clearInterval(keepAlive);
        }
    });
}

// ------------------------------------------------------------
// E. 配置范围与 HTTP 错误响应
// ------------------------------------------------------------

async function testConfigRange() {
    await check("configSchema 的 min/max 会生效", () => {
        const manifest = {
            configSchema: sdk.normalizeConfigSchema({
                keepDays: { type: "integer", default: 14, min: 0, max: 3650 },
            }),
        };
        assert.strictEqual(manifest.configSchema.keepDays.min, 0);
        assert.strictEqual(sdk.normalizeConfig(manifest, { keepDays: 7 }).ok, true);
        assert.strictEqual(sdk.normalizeConfig(manifest, { keepDays: 0 }).ok, true);
        assert.strictEqual(sdk.normalizeConfig(manifest, { keepDays: -5 }).ok, false);
        assert.strictEqual(sdk.normalizeConfig(manifest, { keepDays: 99999 }).ok, false);
    });

    await check("审计插件的 keepDays 声明了下限", () => {
        const manifest = JSON.parse(
            fs.readFileSync(
                path.join(__dirname, "..", "..", "plugins", "builtin", "audit-log", "plugin.json"),
                "utf8"
            )
        );
        const schema = sdk.normalizeConfigSchema(manifest.configSchema);
        assert.strictEqual(schema.keepDays.min, 0);
    });
}

async function testHttpErrors() {
    // 必须先设 storeRoot 再 require server（模块加载时就会建注册表）
    const storeRoot = makeWorkspace("hard-http-");
    process.env.XML_AGENT_STORE_ROOT = storeRoot;
    // eslint-disable-next-line global-require
    const { app } = require("../../webui/server");
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const call = async (method, urlPath, rawBody, contentType) => {
        const options = { method };
        if (rawBody !== undefined) {
            options.headers = { "Content-Type": contentType || "application/json" };
            options.body = rawBody;
        }
        const response = await fetch(base + urlPath, options);
        const text = await response.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (error) {
            json = null;
        }
        return { status: response.status, text, json };
    };

    try {
        await check("坏 JSON 请求体返回 JSON 而不是 HTML 堆栈", async () => {
            const result = await call("POST", "/api/permissions/grant", "{oops");
            assert.strictEqual(result.status, 400);
            assert.ok(result.json, "响应必须是 JSON，实际：" + result.text.slice(0, 80));
            assert.strictEqual(result.json.code, "BODY_PARSE_FAILED");
            assert.ok(result.text.indexOf("node_modules") === -1, "不能泄漏服务端路径");
        });

        await check("超范围配置被接口拒绝", async () => {
            const result = await call(
                "POST",
                "/api/plugins/audit-log/config",
                JSON.stringify({ config: { keepDays: -5 } })
            );
            assert.strictEqual(result.status, 400);
            assert.strictEqual(result.json.code, "CONFIG_INVALID");
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

(async () => {
    await testSandbox();
    await testExec();
    await testWriteRead();
    await testPluginRuntime();
    await testConfigRange();
    await testHttpErrors();

    console.log("");
    console.log(
        "Total: " +
            total +
            " | PASS: " +
            pass +
            " | SKIP: " +
            skipped.length +
            " | FAIL: " +
            (total - pass - skipped.length)
    );
    process.exit(pass + skipped.length === total ? 0 : 1);
})();
