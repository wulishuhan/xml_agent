/**
Gemini 遮挡弹窗与"假发送"的回归测试

真机现象（2026-11-06）：Gemini 弹出 "解锁最适合你的 Gemini / 关联 Google 应用"
引导层，CDK backdrop 盖住发送按钮。`clickSendButton` 的点击被 Playwright 判为
"intercepts pointer events" 并超时，异常被吞掉后回车也没生效；
`afterDelivered` 只打一行 warn 就去等回复 —— 回复永远不会来，
整个 run 一直挂到 30 分钟的运行超时。

这里钉住三件事：
1. 有 CDK 遮罩时先关掉它（优先"不关联"，不进入授权流程）；
2. 发送后输入框没清空 → 重试提交，仍失败则抛错（让 agent 按 provider error 重试）；
3. 提交顺序是"关弹窗 → 点发送 → 回车兜底"。

运行：node test/unit/test-gemini-overlay.js
*/

const assert = require("assert");

const { GeminiProvider } = require("../../providers/gemini");

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

/** 极简 locator：只实现本用例用到的 count / isVisible / click。 */
function fakeLocator(state, selector, index) {
    return {
        first() {
            return fakeLocator(state, selector, 0);
        },
        nth(i) {
            return fakeLocator(state, selector, i);
        },
        async count() {
            return state.count(selector);
        },
        async isVisible() {
            return true;
        },
        async click(options) {
            state.clicked.push({ selector, index, timeout: options && options.timeout });
            state.onClick(selector);
        },
        async focus() {},
        async evaluate() {
            return "false";
        },
    };
}

function makeProvider(state) {
    const provider = new GeminiProvider({ autoStart: false });
    provider.page = {
        isClosed: () => false,
        locator: (selector) => fakeLocator(state, selector, 0),
        keyboard: {
            async press(key) {
                state.keys.push(key);
            },
        },
    };
    return provider;
}

(async () => {
    await check("没有遮罩时不点任何东西", async () => {
        const state = {
            clicked: [],
            keys: [],
            count: () => 0,
            onClick() {},
        };
        const provider = makeProvider(state);
        const result = await provider.dismissBlockingOverlay();
        assert.strictEqual(result, false);
        assert.deepStrictEqual(state.clicked, []);
    });

    await check("有遮罩时优先点「不关联」并确认遮罩消失", async () => {
        let backdropVisible = true;
        const state = {
            clicked: [],
            keys: [],
            count: (selector) =>
                selector === ".cdk-overlay-backdrop-showing" ? (backdropVisible ? 1 : 0) : 1,
            onClick(selector) {
                if (selector.indexOf("不关联") !== -1) {
                    backdropVisible = false;
                }
            },
        };
        const provider = makeProvider(state);
        const result = await provider.dismissBlockingOverlay();
        assert.strictEqual(result, true);
        assert.strictEqual(state.clicked.length, 1, "只点一次就够了");
        assert.ok(state.clicked[0].selector.indexOf("不关联") !== -1, "应优先点「不关联」");
    });

    await check("认不出跳过按钮时退回 Esc", async () => {
        const state = {
            clicked: [],
            keys: [],
            count: (selector) => (selector === ".cdk-overlay-backdrop-showing" ? 1 : 0),
            onClick() {},
        };
        const provider = makeProvider(state);
        const result = await provider.dismissBlockingOverlay();
        assert.strictEqual(result, false, "遮罩还在，应如实返回 false");
        assert.deepStrictEqual(state.keys, ["Escape"]);
    });

    await check("发送后输入框清空就不再重试", async () => {
        const provider = makeProvider({ clicked: [], keys: [], count: () => 0, onClick() {} });
        let sends = 0;
        provider.clickSendButton = async () => {
            sends += 1;
            return true;
        };
        provider.waitForInputClear = async () => true;
        await provider.afterDelivered();
        assert.strictEqual(sends, 0);
    });

    await check("输入框没清空时重试提交，仍失败则抛错", async () => {
        const provider = makeProvider({ clicked: [], keys: [], count: () => 0, onClick() {} });
        let sends = 0;
        let dismissals = 0;
        provider.clickSendButton = async () => {
            sends += 1;
            return true;
        };
        provider.waitForInputClear = async () => false;
        provider.dismissBlockingOverlay = async () => {
            dismissals += 1;
            return true;
        };
        await assert.rejects(() => provider.afterDelivered(), /still contains text/);
        assert.strictEqual(sends, 2, "除首轮外应再重试 2 次");
        assert.strictEqual(dismissals, 2, "每次重试前都先清弹窗");
    });

    await check("重试过程中清空则视为发送成功", async () => {
        const provider = makeProvider({ clicked: [], keys: [], count: () => 0, onClick() {} });
        let sends = 0;
        provider.clickSendButton = async () => {
            sends += 1;
            return true;
        };
        let reads = 0;
        provider.waitForInputClear = async () => {
            reads += 1;
            return reads >= 2;
        };
        provider.dismissBlockingOverlay = async () => true;
        await provider.afterDelivered();
        assert.strictEqual(sends, 1);
    });

    await check("提交顺序：先关弹窗再点发送", async () => {
        const order = [];
        const provider = makeProvider({ clicked: [], keys: [], count: () => 0, onClick() {} });
        provider.dismissBlockingOverlay = async () => {
            order.push("dismiss");
            return true;
        };
        provider.clickSendButton = async () => {
            order.push("send");
            return true;
        };
        await provider.deliverMessage();
        assert.deepStrictEqual(order, ["dismiss", "send"]);
    });

    await check("发送按钮点不到时聚焦输入框再回车", async () => {
        const order = [];
        const provider = makeProvider({ clicked: [], keys: [], count: () => 0, onClick() {} });
        provider.dismissBlockingOverlay = async () => true;
        provider.clickSendButton = async () => false;
        provider.focusComposer = async () => {
            order.push("focus");
            return true;
        };
        provider.page.keyboard.press = async (key) => {
            order.push("press:" + key);
        };
        await provider.deliverMessage();
        assert.deepStrictEqual(order, ["focus", "press:Enter"]);
    });

    console.log("");
    console.log("Total: " + total + " | PASS: " + pass + " | FAIL: " + (total - pass));
    process.exit(pass === total ? 0 : 1);
})();
