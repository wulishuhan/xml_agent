/**
空回复守门单测（providers/browser-chat.js 的 waitForNewResponseKey）

真实踩过的坑：GLM 某一轮没有产出任何内容，页面上只挂了一个"正在思考"占位。
旧逻辑要求"新回复非空"才算成立，于是一直空转到 responseTimeout（默认 10 分钟）。
这里把新的契约钉住：
1. 空占位持续超过 responseContentGrace 就报 EMPTY_RESPONSE，而不是等满总超时；
2. 占位被换成新的一条时重新计时，不误杀正常的长思考；
3. EMPTY_RESPONSE 不能被 provider 的降级分支吞掉。

运行：node test/unit/test-empty-response.js
*/

const assert = require("assert");

const { GlmProvider } = require("../../providers/glm");
const { DeepSeekProvider } = require("../../providers/deepseek");
const { EMPTY_RESPONSE_CODE } = require("../../providers/browser-chat");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

/** 造一个不启动浏览器、只保留等待逻辑的 provider 替身。 */
function makeProvider(ProviderClass, overrides = {}) {
    const provider = new ProviderClass({
        autoStart: false,
        responseTimeout: 3000,
        responseContentGrace: 80,
        responsePollInterval: 10,
    });

    provider.isPageAlive = () => true;
    provider.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    provider.detectReusedResponseKey = async () => null;
    provider.getAssistantMessageKeys = async () => ["glm:0:old", "glm:1:placeholder"];
    provider.getResponseByKey = async () => "";

    Object.assign(provider, overrides);
    return provider;
}

async function main() {
    // ------------------------------------------------------------
    // 1. 一直空：在 grace 内失败，不等满 responseTimeout
    // ------------------------------------------------------------
    {
        const provider = makeProvider(GlmProvider);
        const startedAt = Date.now();
        let error = null;

        try {
            await provider.waitForNewResponseKey(["glm:0:old"]);
        } catch (e) {
            error = e;
        }

        const elapsed = Date.now() - startedAt;

        check("空占位会报错", !!error, error && error.message);
        check("错误码为 EMPTY_RESPONSE", !!error && error.code === EMPTY_RESPONSE_CODE);
        check("没有等满总超时", elapsed < 1500, elapsed + "ms (timeout=3000ms)");
        check("错误信息说明是可读内容缺失", !!error && /readable content/.test(error.message));
    }

    // ------------------------------------------------------------
    // 2. 空占位之后正常出内容：应当拿到这条回复
    // ------------------------------------------------------------
    {
        let calls = 0;
        const provider = makeProvider(GlmProvider, {
            getResponseByKey: async (key) => (++calls > 3 ? "<answer>ok</answer>" : ""),
        });

        const key = await provider.waitForNewResponseKey(["glm:0:old"]);

        check("空占位后仍能拿到回复", key === "glm:1:placeholder", key);
        check("取回复失败次数合理", calls >= 4, "calls=" + calls);
    }

    // ------------------------------------------------------------
    // 3. 占位被换掉要重新计时（正常长思考不能被误杀）
    // ------------------------------------------------------------
    {
        const timeline = [];
        const provider = makeProvider(GlmProvider, {
            getAssistantMessageKeys: async () => {
                timeline.push(Date.now());
                // 前 8 次是占位 A，之后换成占位 B，再之后才出内容。
                // 总耗时明显超过 grace(80ms)，但单个占位的存活时间都不超过它。
                const elapsed = Date.now() - timeline[0];
                if (elapsed < 160) {
                    return ["glm:0:old", elapsed < 80 ? "glm:1:a" : "glm:1:b"];
                }
                return ["glm:0:old", "glm:1:c"];
            },
            getResponseByKey: async (key) => (key === "glm:1:c" ? "<answer>done</answer>" : ""),
        });

        let error = null;
        let key = null;

        try {
            key = await provider.waitForNewResponseKey(["glm:0:old"]);
        } catch (e) {
            error = e;
        }

        check("占位换新后重新计时", !error && key === "glm:1:c", error ? error.message : key);
    }

    // ------------------------------------------------------------
    // 4. 思考还在进行（活动签名在变）时不能判为空回复
    // ------------------------------------------------------------
    {
        let signature = 0;
        let calls = 0;
        const provider = makeProvider(GlmProvider, {
            // 签名每轮都变 = 思考内容还在增长
            getPendingSignature: async () => String(++signature),
            getResponseByKey: async () => (++calls > 12 ? "<answer>ok</answer>" : ""),
        });

        let error = null;
        let key = null;

        try {
            key = await provider.waitForNewResponseKey(["glm:0:old"]);
        } catch (e) {
            error = e;
        }

        check(
            "思考仍在进行时不判空回复",
            !error && key === "glm:1:placeholder",
            error ? error.message : key
        );
        check("等待轮次超过 grace 仍成功", signature > 8, "signature=" + signature);
    }

    // ------------------------------------------------------------
    // 5. 错误类型判定
    // ------------------------------------------------------------
    {
        const provider = makeProvider(GlmProvider);
        const emptyError = new Error("empty");
        emptyError.code = EMPTY_RESPONSE_CODE;

        check("识别空回复错误", provider.isEmptyResponseError(emptyError) === true);
        check("普通错误不算空回复", provider.isEmptyResponseError(new Error("boom")) === false);
        check("空值不算空回复", provider.isEmptyResponseError(null) === false);
    }

    // ------------------------------------------------------------
    // 6. provider 的 collectResponse 不能降级吞掉空回复
    // ------------------------------------------------------------
    {
        const cases = [
            { name: "GLM", Provider: GlmProvider },
            { name: "DeepSeek", Provider: DeepSeekProvider },
        ];

        for (const item of cases) {
            const provider = makeProvider(item.Provider, {
                waitForNewResponseKey: async () => {
                    const e = new Error("empty");
                    e.code = EMPTY_RESPONSE_CODE;
                    throw e;
                },
                waitForResponseStart: async () => {
                    throw new Error("不应降级到 waitForResponseStart");
                },
            });

            let error = null;
            try {
                await provider.collectResponse({ keys: [], count: 0, text: "" });
            } catch (e) {
                error = e;
            }

            check(
                item.name + " 空回复不被降级吞掉",
                !!error && error.code === EMPTY_RESPONSE_CODE,
                error ? error.message : "未抛错"
            );
        }
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exit(1);
    }
}

main().catch((e) => {
    console.error("FAILED: " + e.message);
    process.exit(1);
});
