/**
Qwen 启动遮罩处理单测

真机事故回顾：崩溃自愈后新建的页面会盖一层 `#splash-screen` 全屏遮罩，
`locator.click` 被判定 "intercepts pointer events" 并重试满 30s，
连续 3 次 provider error 后整个 run 直接失败（实测 1/2 成功率）。

这里用纯对象替身钉住契约，不启动浏览器：
1. 遮罩探测对"查不到 / 抛错 / 页面已关"一律返回 false（不能反过来堵死流程）；
2. 遮罩消失前不点击，超时只告警不抛错；
3. 点击被遮挡时就地等待重试一次，而不是把错误抛给 agent 层；
4. 只有遮挡错误才重试，其它错误照常抛。

运行：node test/unit/test-qwen-splash.js
*/

const assert = require("assert");

const { QwenProvider } = require("../../providers/qwen");
const { BrowserAgent } = require("../../providers/browser-agent");

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

function makeProvider(pageOverrides) {
    const provider = new QwenProvider({ autoStart: false });

    provider.sleep = async () => {};
    provider.page = Object.assign(
        {
            isClosed: () => false,
            evaluate: async () => false,
        },
        pageOverrides || {}
    );

    return provider;
}

function interceptionError() {
    return new Error('locator.click: <div id="splash-screen"> intercepts pointer events');
}

async function main() {
    await check("遮罩不存在时等待立即返回 true", async () => {
        const provider = makeProvider();
        assert.strictEqual(await provider.waitForSplashGone(500), true);
    });

    await check("遮罩一直在时按超时返回 false（不抛错）", async () => {
        const provider = makeProvider({ evaluate: async () => true });
        const startedAt = Date.now();
        const result = await provider.waitForSplashGone(120);

        assert.strictEqual(result, false);
        assert.ok(Date.now() - startedAt >= 100, "should actually wait");
    });

    await check("页面已关闭时探测返回 false", async () => {
        const provider = makeProvider({ isClosed: () => true });
        assert.strictEqual(await provider.isSplashVisible(), false);
    });

    await check("页面探测抛错时按无遮罩处理", async () => {
        const provider = makeProvider({
            evaluate: async () => {
                throw new Error("execution context destroyed");
            },
        });
        assert.strictEqual(await provider.isSplashVisible(), false);
    });

    await check("deliverMessage 先等遮罩，再点击回车", async () => {
        const order = [];
        const provider = makeProvider();

        provider.waitForSplashGone = async () => {
            order.push("splash");
            return true;
        };
        provider.findVisibleInput = async () => ({
            click: async () => order.push("click"),
            press: async () => order.push("press"),
        });
        provider.waitForInputClear = async () => true;

        await provider.deliverMessage();

        assert.deepStrictEqual(order, ["splash", "click", "press"]);
    });

    await check("点击被遮挡时等遮罩消失后重试一次", async () => {
        let clicks = 0;
        let splashWaits = 0;
        const provider = makeProvider();

        provider.waitForSplashGone = async () => {
            splashWaits += 1;
            return true;
        };
        provider.findVisibleInput = async () => ({
            click: async () => {
                clicks += 1;

                if (clicks === 1) {
                    throw interceptionError();
                }
            },
            press: async () => {},
        });
        provider.waitForInputClear = async () => true;

        await provider.deliverMessage();

        assert.strictEqual(clicks, 2, "should retry the click once");
        assert.strictEqual(splashWaits, 2, "should wait for splash again before retry");
    });

    await check("非遮挡类错误照常抛出，不做掩盖", async () => {
        const provider = makeProvider();

        provider.waitForSplashGone = async () => true;
        provider.findVisibleInput = async () => ({
            click: async () => {
                throw new Error("element is not visible");
            },
            press: async () => {},
        });

        await assert.rejects(() => provider.deliverMessage(), /failed to send message/);
    });

    await check("insertMessage 写入前先等遮罩", async () => {
        const provider = makeProvider();
        const order = [];
        const parentInsert = BrowserAgent.prototype.insertMessage;

        provider.waitForSplashGone = async () => {
            order.push("splash");
            return true;
        };
        BrowserAgent.prototype.insertMessage = async function () {
            order.push("insert");
        };

        try {
            await provider.insertMessage("hello");
        } finally {
            BrowserAgent.prototype.insertMessage = parentInsert;
        }

        assert.deepStrictEqual(order, ["splash", "insert"]);
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
