/**
 * 拟人化节流单测（provider 层，不起浏览器）
 *
 * 用假的 page/input + 注入随机源，覆盖：
 * 1. humanize=false 时不逐段输入；
 * 2. 超长消息不逐段输入；
 * 3. 逐段输入 + Shift+Enter 换行，最终内容与原文一致；
 * 4. 校验不一致时返回 false（调用方回退 fill）；
 * 5. insertMessage 在逐段失败后仍走 fill 链；
 * 6. 稳定窗口抖动落在 ±jitter 区间、jitter=0 时精确、下限 500ms。
 *
 * 运行：node test/unit/test-humanize.js
 */

const { BrowserAgent } = require("../../providers/browser-agent");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

/**
 * 构造一个带假 page/input 的 BrowserAgent。
 * state.value 是输入框当前内容，由 page.keyboard 写入、input.innerText 读出。
 */
function makeAgent(options = {}) {
    const state = { value: "", fillCalls: [] };
    const input = {
        focus: async () => {},
        click: async () => {},
        press: async () => {},
        fill: async (text) => {
            state.fillCalls.push(text);
            state.value = text;
        },
        evaluate: async (fn) => (typeof fn === "function" ? fn({ tagName: "DIV" }) : "div"),
        innerText: async () => state.value,
        inputValue: async () => state.value,
        textContent: async () => state.value,
        isVisible: async () => true,
        isDisabled: async () => false,
    };
    const typed = [];
    const pressed = [];
    const page = {
        keyboard: {
            insertText: async (text) => {
                typed.push(text);
                state.value += text;
            },
            press: async (key) => {
                pressed.push(key);
                if (key === "Shift+Enter") {
                    state.value += "\n";
                }
            },
            type: async (text) => {
                state.value += text;
            },
        },
        evaluate: async () => null,
        isClosed: () => false, // Playwright 的 isClosed() 是同步的
        locator: () => ({ count: async () => 1, first: () => input, nth: () => input }),
    };
    const agent = new BrowserAgent(
        Object.assign(
            {
                autoStart: false,
                humanize: true,
                humanizeMaxChars: 800,
                stableTimeJitter: 0.35,
                random: () => 0.5,
            },
            options
        )
    );
    agent.page = page;
    return { agent, input, page, state, typed, pressed };
}

async function main() {
    // ------------------------------------------------------------
    // 1. 逐段输入 + 换行
    // ------------------------------------------------------------
    {
        const { agent, input, page, state, typed, pressed } = makeAgent();
        const ok = await agent.typeMessageHumanized(input, "hello\nworld");
        check("逐段输入成功", ok === true);
        check("内容与原文一致", state.value === "hello\nworld", JSON.stringify(state.value));
        check("换行走 Shift+Enter", pressed.join(",") === "Shift+Enter", pressed.join(","));
        check(
            "非空片段确实逐段写入",
            typed.length >= 2 && typed.join("") === "helloworld",
            typed.join("|")
        );
    }

    // ------------------------------------------------------------
    // 2. humanize=false 直接返回 false
    // ------------------------------------------------------------
    {
        const ctxOff = makeAgent({ humanize: false });
        const ok = await ctxOff.agent.typeMessageHumanized(ctxOff.input, "hello");
        check("humanize=false 不逐段输入", ok === false);
        check(
            "humanize=false 未写入任何字符",
            ctxOff.state.value === "",
            JSON.stringify(ctxOff.state.value)
        );
    }

    // ------------------------------------------------------------
    // 3. 超长消息不逐段输入
    // ------------------------------------------------------------
    {
        const long = "x".repeat(50);
        const { agent, input, state } = makeAgent({ humanizeMaxChars: 10 });
        const ok = await agent.typeMessageHumanized(input, long);
        check("超长消息跳过逐段输入", ok === false);
        check("超长消息未写入", state.value === "");
    }

    // ------------------------------------------------------------
    // 4. 校验不一致返回 false
    // ------------------------------------------------------------
    {
        const ctx = makeAgent();
        ctx.input.innerText = async () => "wrong value";
        const ok = await ctx.agent.typeMessageHumanized(ctx.input, "hello");
        check("校验不一致返回 false", ok === false);
    }

    // ------------------------------------------------------------
    // 5. insertMessage 逐段失败后回退 fill
    // ------------------------------------------------------------
    {
        const ctx = makeAgent();
        // 让逐段校验失败（读出内容与原文不同）
        ctx.input.innerText = async () => "mismatch";
        ctx.agent._cachedInput = ctx.input;
        const ok = await ctx.agent.insertMessage("hello");
        check("insertMessage 逐段失败仍成功", ok === true);
        check(
            "insertMessage 回退到 fill",
            ctx.state.fillCalls.length === 1,
            String(ctx.state.fillCalls.length)
        );
    }

    // ------------------------------------------------------------
    // 6. 稳定窗口抖动
    // ------------------------------------------------------------
    {
        const ctx = makeAgent({ stableTimeJitter: 0.35, random: Math.random });
        const values = [];
        for (let i = 0; i < 300; i += 1) {
            values.push(ctx.agent.randomStableTime(4000));
        }
        const min = Math.min.apply(null, values);
        const max = Math.max.apply(null, values);
        check("抖动落在 ±35% 区间", min >= 2600 && max <= 5400, "min=" + min + " max=" + max);
        check("抖动确实有变化", new Set(values).size > 1, "distinct=" + new Set(values).size);

        const exact = makeAgent({ stableTimeJitter: 0 });
        check("jitter=0 时精确等于基础值", exact.agent.randomStableTime(4000) === 4000);

        const small = makeAgent({ stableTimeJitter: 0.9, random: () => 0 });
        check(
            "下限不低于 500ms",
            small.agent.randomStableTime(300) >= 500,
            String(small.agent.randomStableTime(300))
        );
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("FAILED: " + error.stack);
    process.exitCode = 1;
});
