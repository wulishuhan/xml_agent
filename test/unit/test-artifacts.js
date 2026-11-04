/**
产物回传通道单测（agent/artifacts.js）

用假 provider 与假动作定义验证三条契约，全程不启动浏览器：
1. collect 只认动作声明的 meta.collectImages，收集函数出错不抛出；
2. upload 的失败一律降级为结果字段与事件，不中断主流程；
3. uploadPreset 能区分"文件不存在"与"provider 不支持上传"。

运行：node test/unit/test-artifacts.js
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createArtifactsChannel } = require("../../agent/artifacts");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function makeProvider(options = {}) {
    if (options.unsupported) {
        return {};
    }
    return {
        uploaded: [],
        shouldThrow: options.shouldThrow === true,
        async uploadImages(paths) {
            if (this.shouldThrow) {
                throw new Error("upload exploded");
            }
            this.uploaded.push(paths);
            return { ok: true, count: paths.length };
        },
    };
}

function makeChannel(overrides = {}) {
    const events = [];
    const provider = overrides.provider !== undefined ? overrides.provider : makeProvider();
    const channel = createArtifactsChannel({
        resolveActionDefinition:
            overrides.resolveActionDefinition !== undefined
                ? overrides.resolveActionDefinition
                : () => null,
        getProvider: () => provider,
        // 与 Agent.toAbsolutePath 同语义：绝对路径原样返回，相对路径挂到 workspace 下。
        toAbsolutePath: (target) =>
            path.isAbsolute(target) ? target : path.join("/workspace", target),
        emit: (type, data) => events.push(Object.assign({ type: type }, data)),
        getStep: () => 7,
    });
    return { channel, events, provider };
}

async function run() {
    // ---- collect ----
    {
        const { channel } = makeChannel();
        check("无动作定义时收集为空", channel.collect({ action: "unknown" }).length === 0);
        check("非对象入参不抛错", channel.collect(null).length === 0);
    }

    {
        const { channel } = makeChannel({
            resolveActionDefinition: () => ({ meta: {} }),
        });
        check(
            "动作未声明 collectImages 时收集为空",
            channel.collect({ action: "read", path: "a.txt" }).length === 0
        );
    }

    {
        const { channel } = makeChannel({
            resolveActionDefinition: () => ({
                meta: {
                    collectImages: () => {
                        throw new Error("collector broken");
                    },
                },
            }),
        });
        check("收集函数抛错时降级为空数组", channel.collect({ action: "broken" }).length === 0);
    }

    {
        const { channel } = makeChannel({
            resolveActionDefinition: () => ({
                meta: {
                    collectImages: (result) => [result.path, "ignored"],
                },
            }),
        });
        const paths = channel.collect({ action: "screenshot", path: "screenshots/a.png" });
        check(
            "按声明收集产物路径",
            JSON.stringify(paths) === JSON.stringify(["screenshots/a.png", "ignored"]),
            JSON.stringify(paths)
        );
    }

    // ---- upload ----
    {
        const { channel, provider, events } = makeChannel({
            resolveActionDefinition: () => ({ meta: { collectImages: (r) => [r.path] } }),
        });
        const result = await channel.upload({ ok: true, action: "screenshot", path: "a.png" });
        check("上传成功后标记 uploaded", result.uploaded === true);
        check("记录上传数量", result.uploadCount === 1, String(result.uploadCount));
        check(
            "保留相对路径供 trace 使用",
            JSON.stringify(result.uploadedPaths) === JSON.stringify(["a.png"])
        );
        check(
            "provider 收到绝对路径",
            provider.uploaded[0] && provider.uploaded[0][0] === path.join("/workspace", "a.png"),
            String(provider.uploaded[0])
        );
        const uploadedEvent = events.filter((e) => e.type === "screenshot.uploaded")[0];
        check("发出 screenshot.uploaded 事件", Boolean(uploadedEvent));
        check(
            "事件带步骤号",
            uploadedEvent && uploadedEvent.step === 7,
            String(uploadedEvent.step)
        );
    }

    {
        const { channel, provider } = makeChannel();
        const result = await channel.upload({ ok: true, action: "read", path: "a.txt" });
        check("无产物声明时 uploaded=false", result.uploaded === false);
        check("无产物时不调用 provider", provider.uploaded.length === 0);
    }

    {
        const { channel } = makeChannel({ provider: makeProvider({ unsupported: true }) });
        const result = await channel.upload({
            ok: true,
            action: "screenshot",
            path: "a.png",
            uploaded: undefined,
        });
        check("provider 不支持上传时 uploaded=false", result.uploaded === false);
    }

    {
        const { channel } = makeChannel({
            resolveActionDefinition: () => ({ meta: { collectImages: (r) => [r.path] } }),
            provider: makeProvider({ shouldThrow: true }),
        });
        const result = await channel.upload({ ok: true, action: "screenshot", path: "a.png" });
        check("provider 抛错时不向上抛", true);
        check("失败标记 uploaded=false", result.uploaded === false);
        check(
            "失败原因写入 uploadError",
            result.uploadError === "upload exploded",
            result.uploadError
        );
    }

    {
        const { channel, events } = makeChannel({
            resolveActionDefinition: () => ({ meta: { collectImages: () => ["a.png"] } }),
            provider: makeProvider({ shouldThrow: true }),
        });
        await channel.upload({ ok: true, action: "screenshot" });
        const errorEvent = events.filter((e) => e.type === "screenshot.upload_error")[0];
        check("上传失败发 screenshot.upload_error", Boolean(errorEvent));
        check("事件带失败原因", errorEvent && errorEvent.error === "upload exploded");
    }

    {
        const { channel, provider } = makeChannel({
            resolveActionDefinition: () => ({ meta: { collectImages: () => ["a.png"] } }),
        });
        const failed = { ok: false, action: "screenshot", error: "runtime failed" };
        const result = await channel.upload(failed);
        check("动作本身失败时跳过上传", result.uploaded === undefined);
        check("动作失败时未调用 provider", provider.uploaded.length === 0);
    }

    // ---- uploadPreset ----
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-artifacts-"));
    try {
        const existing = path.join(workspace, "exists.png");
        fs.writeFileSync(existing, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        {
            const { channel, events } = makeChannel();
            await channel.uploadPreset([]);
            check("没有预置图片时不发事件", events.length === 0);
        }

        {
            const { channel, events } = makeChannel({
                provider: makeProvider({ unsupported: true }),
            });
            await channel.uploadPreset([existing]);
            const skipped = events.filter((e) => e.type === "images.upload_skipped")[0];
            check("provider 不支持时发 upload_skipped", Boolean(skipped));
        }

        {
            const { channel, events, provider } = makeChannel();
            await channel.uploadPreset([existing, path.join(workspace, "missing.png")]);
            const missing = events.filter((e) => e.type === "images.missing")[0];
            check("缺失文件单独发 images.missing", missing && missing.count === 1);
            check("只上传存在的文件", provider.uploaded[0] && provider.uploaded[0].length === 1);
            const uploaded = events.filter((e) => e.type === "images.uploaded")[0];
            check("存在的文件发 images.uploaded", uploaded && uploaded.count === 1);
        }

        {
            const { channel, events } = makeChannel({
                provider: makeProvider({ shouldThrow: true }),
            });
            await channel.uploadPreset([existing]);
            const failed = events.filter((e) => e.type === "images.upload_error")[0];
            check("上传抛错时发 images.upload_error", failed && failed.error === "upload exploded");
        }
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }

    console.log("\nTotal: " + pass + "/" + total);
    if (pass !== total) {
        process.exitCode = 1;
    }
}

run().catch((error) => {
    console.error("TEST CRASHED:", error);
    process.exitCode = 1;
});
