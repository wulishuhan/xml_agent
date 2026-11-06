/**
CDP 连接单测（地址规范化 + 失败重试）

真机事故：崩溃自愈时 `connectOverCDP` 报
`Unexpected status 404 when connecting to http://127.0.0.1:9223/json/version/`
—— 配置里的尾斜杠被拼成了 `/json/version/`，DevTools 端点对尾斜杠直接 404。
而自愈路径只尝试一次，一次 404 就让"自动恢复"变成"直接判死"。

这里钉住：
1. 尾斜杠在构造时就被去掉（不留到 Playwright 那里炸）；
2. 连接失败会重试，且重试用的是同一个（已规范化的）地址；
3. 重试耗尽后抛最后一个错误，不吞。

运行：node test/unit/test-cdp-connect.js
*/

const assert = require("assert");
const playwright = require("playwright");

const { BrowserAgent, normalizeCdpUrl } = require("../../providers/browser-agent");

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

function withConnectStub(stub, fn) {
    const original = playwright.chromium.connectOverCDP;
    playwright.chromium.connectOverCDP = stub;

    // 必须等 fn 真正跑完再还原：直接 return 会在 promise settle 前就执行 finally，
    // 于是只有第一次调用用的是替身，后面的重试会打到真实网络上。
    return (async () => {
        try {
            return await fn();
        } finally {
            playwright.chromium.connectOverCDP = original;
        }
    })();
}

async function main() {
    await check("去掉尾部斜杠", async () => {
        assert.strictEqual(normalizeCdpUrl("http://127.0.0.1:9223/"), "http://127.0.0.1:9223");
        assert.strictEqual(normalizeCdpUrl("http://127.0.0.1:9223///"), "http://127.0.0.1:9223");
        assert.strictEqual(normalizeCdpUrl("  http://127.0.0.1:9223  "), "http://127.0.0.1:9223");
        assert.strictEqual(normalizeCdpUrl("http://127.0.0.1:9223"), "http://127.0.0.1:9223");
        assert.strictEqual(normalizeCdpUrl(""), "");
        assert.strictEqual(normalizeCdpUrl(undefined), "");
    });

    await check("构造时规范化 cdpUrl", async () => {
        const agent = new BrowserAgent({ autoStart: false, cdpUrl: "http://127.0.0.1:9223/" });

        assert.strictEqual(agent.cdpUrl, "http://127.0.0.1:9223");
    });

    await check("连接失败会重试，第二次成功", async () => {
        const urls = [];

        await withConnectStub(
            async (url) => {
                urls.push(url);

                if (urls.length === 1) {
                    throw new Error("Unexpected status 404");
                }

                return { ok: true };
            },
            async () => {
                const agent = new BrowserAgent({
                    autoStart: false,
                    cdpUrl: "http://127.0.0.1:9223/",
                });
                agent.sleep = async () => {};

                const browser = await agent.connectCdp(3);

                assert.deepStrictEqual(browser, { ok: true });
                assert.strictEqual(urls.length, 2, "should retry once");
                assert.deepStrictEqual(urls, ["http://127.0.0.1:9223", "http://127.0.0.1:9223"]);
            }
        );
    });

    await check("重试耗尽后抛出最后一个错误", async () => {
        let calls = 0;

        await withConnectStub(
            async () => {
                calls += 1;
                throw new Error("still down");
            },
            async () => {
                const agent = new BrowserAgent({ autoStart: false });
                agent.sleep = async () => {};

                await assert.rejects(() => agent.connectCdp(3), /still down/);
                assert.strictEqual(calls, 3);
            }
        );
    });

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
