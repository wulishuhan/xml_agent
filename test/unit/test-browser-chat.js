/**
Provider 基类与共享工具单测（providers/browser-chat.js、action-tag.js、dom/fiber.js）

这一层把四个平台的重复骨架收敛成基类 + 钩子，回归风险集中在这里，
所以用纯对象替身把契约钉住，全程不启动浏览器：

1. 地址/会话 id 全部由 profile 推导，四个平台的差异只是常量；
2. send() 的时序固定为 快照 → 写入 → 提交 → 校验 → 取回复；
3. 页面丢失时先尝试恢复，恢复不了才抛错；
4. fiber 扫描函数必须能脱离模块作用域运行（会被序列化送进页面）。

运行：node test/unit/test-browser-chat.js
*/

const assert = require("assert");

const { ChatGPTProvider } = require("../../providers/chatgpt");
const { QwenProvider } = require("../../providers/qwen");
const { DeepSeekProvider } = require("../../providers/deepseek");
const { GlmProvider } = require("../../providers/glm");
const { containsActionTag } = require("../../providers/action-tag");
const { collectFiberCandidates, collectChildFiberCandidate } = require("../../providers/dom/fiber");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function make(ProviderClass, extra = {}) {
    return new ProviderClass(Object.assign({ autoStart: false }, extra));
}

const PROVIDERS = [
    {
        name: "ChatGPT",
        Provider: ChatGPTProvider,
        url: "https://chatgpt.com/c/68ab-12cd",
        cid: "68ab-12cd",
        base: "https://chatgpt.com",
        target: "https://chatgpt.com/c/abc-1",
        other: "https://chat.qwen.ai/c/x",
    },
    {
        name: "Qwen",
        Provider: QwenProvider,
        url: "https://chat.qwen.ai/c/71f3-aa",
        cid: "71f3-aa",
        base: "https://chat.qwen.ai",
        target: "https://chat.qwen.ai/c/abc-1",
        other: "https://chatgpt.com/c/x",
    },
    {
        name: "DeepSeek",
        Provider: DeepSeekProvider,
        url: "https://chat.deepseek.com/a/chat/s/9efa4714-38db",
        cid: "9efa4714-38db",
        base: "https://chat.deepseek.com",
        target: "https://chat.deepseek.com/a/chat/s/abc-1",
        other: "https://chatgpt.com/c/x",
    },
    {
        name: "GLM",
        Provider: GlmProvider,
        url: "https://chat.z.ai/s/zz-99",
        cid: "zz-99",
        base: "https://zchat.z.ai",
        target: "https://zchat.z.ai/s/abc-1",
        other: "https://chatgpt.com/c/x",
        // GLM 的会话 URL 同时存在 /c/ 与 /s/ 两种写法
        altUrl: "https://chat.z.ai/c/yy-11",
        altCid: "yy-11",
    },
];

async function main() {
    // ------------------------------------------------------------
    // 1. profile 驱动的地址推导
    // ------------------------------------------------------------
    for (const item of PROVIDERS) {
        const provider = make(item.Provider);

        check(
            item.name + " 从会话 URL 解析 id",
            provider.getConversationIdFromUrl(item.url) === item.cid,
            provider.getConversationIdFromUrl(item.url)
        );

        check(
            item.name + " 非会话 URL 返回 null",
            provider.getConversationIdFromUrl(item.base) === null &&
                provider.getConversationIdFromUrl("") === null &&
                provider.getConversationIdFromUrl(null) === null
        );

        check(
            item.name + " 无会话 id 时返回站点根地址",
            provider.buildTargetUrl() === item.base,
            provider.buildTargetUrl()
        );

        const withCid = make(item.Provider, {
            targetUrl: item.base + "/",
            conversationId: "abc-1",
        });

        check(
            item.name + " 拼会话地址并去掉多余斜杠",
            withCid.buildTargetUrl() === item.target,
            withCid.buildTargetUrl()
        );

        const matched = await make(item.Provider)
            .matchPage({ url: () => item.url })
            .catch(() => false);
        const mismatched = await make(item.Provider)
            .matchPage({ url: () => item.other })
            .catch(() => true);

        check(item.name + " matchPage 认自己的域名", matched === true);
        check(item.name + " matchPage 排除其他平台", mismatched === false);
    }

    const glmAlt = make(GlmProvider);
    check(
        "GLM 同时接受 /c/ 与会话 id 的正则",
        glmAlt.getConversationIdFromUrl("https://chat.z.ai/c/yy-11") === "yy-11"
    );

    // ------------------------------------------------------------
    // 2. meta 与实例使用同一份正则（防止两套规则漂移）
    // ------------------------------------------------------------
    for (const item of PROVIDERS) {
        const module = require("../../providers/" + item.name.toLowerCase());
        const meta = module.meta;
        const provider = make(item.Provider);
        check(
            item.name + " meta 正则与实例一致",
            String(meta.conversationIdPattern) === String(provider.conversationIdPattern),
            String(meta.conversationIdPattern)
        );
    }

    // ------------------------------------------------------------
    // 3. send() 的时序
    // ------------------------------------------------------------
    {
        const provider = make(ChatGPTProvider);
        const order = [];

        provider.isPageAlive = () => true;
        provider.refreshConversationId = () => order.push("refresh");
        provider.captureResponseSnapshot = async () => {
            order.push("snapshot");
            return { count: 0, text: "" };
        };
        provider.insertMessage = async () => order.push("insert");
        provider.deliverMessage = async () => order.push("deliver");
        provider.afterDelivered = async () => order.push("after");
        provider.collectResponse = async () => {
            order.push("collect");
            return "answer";
        };

        const response = await provider.send("hi");

        check("send 返回 collectResponse 的结果", response === "answer", response);
        check(
            "send 时序固定：快照→写入→提交→校验→刷新→取回复→刷新",
            order.join(",") === "snapshot,insert,deliver,after,refresh,collect,refresh",
            order.join(",")
        );
    }

    // ------------------------------------------------------------
    // 4. send() 的前置校验与空回复
    // ------------------------------------------------------------
    {
        const provider = make(ChatGPTProvider);
        let threw = null;
        try {
            await provider.send("   ");
        } catch (error) {
            threw = error;
        }
        check(
            "空消息在发车前被拦下",
            threw && threw.message === "ChatGPT message cannot be empty",
            threw && threw.message
        );
    }

    {
        const provider = make(QwenProvider);
        provider.isPageAlive = () => true;
        provider.refreshConversationId = () => {};
        provider.captureResponseSnapshot = async () => ({ count: 0, text: "" });
        provider.insertMessage = async () => {};
        provider.deliverMessage = async () => {};
        provider.afterDelivered = async () => {};
        provider.collectResponse = async () => "   ";

        let threw = null;
        try {
            await provider.send("hi");
        } catch (error) {
            threw = error;
        }
        check(
            "空回复按平台名报错",
            threw && threw.message === "Qwen returned an empty response",
            threw && threw.message
        );
    }

    // ------------------------------------------------------------
    // 5. 页面丢失时的恢复策略
    // ------------------------------------------------------------
    {
        const provider = make(ChatGPTProvider);
        provider.isPageAlive = () => false;
        provider.ensurePageAlive = async () => false;

        let threw = null;
        try {
            await provider.ensureReady();
        } catch (error) {
            threw = error;
        }
        check(
            "恢复失败才抛错",
            threw && threw.message === "ChatGPT page is not available",
            threw && threw.message
        );
    }

    {
        const provider = make(ChatGPTProvider);
        let calls = 0;
        provider.isPageAlive = () => calls++ > 0;
        provider.ensurePageAlive = async () => true;

        let threw = null;
        try {
            await provider.ensureReady();
        } catch (error) {
            threw = error;
        }
        check("恢复成功不抛错", threw === null);
    }

    // ------------------------------------------------------------
    // 6. waitForResponseStart 的三种结局
    // ------------------------------------------------------------
    {
        const provider = make(ChatGPTProvider, { responseTimeout: 200, responsePollInterval: 5 });
        provider.isPageAlive = () => true;

        // 助手消息条数增加
        let round = 0;
        provider.getResponseState = async () => {
            round += 1;
            return { count: round > 2 ? 2 : 1, text: "same" };
        };
        const increased = await provider.waitForResponseStart(1, "same").catch(() => false);
        check("条数增加即判定响应开始", increased === true);

        // 文本从空变为非空
        const provider2 = make(ChatGPTProvider, { responseTimeout: 200, responsePollInterval: 5 });
        provider2.isPageAlive = () => true;
        let round2 = 0;
        provider2.getResponseState = async () => {
            round2 += 1;
            return { count: 1, text: round2 > 1 ? "新内容" : "" };
        };
        const started = await provider2.waitForResponseStart(1, "").catch(() => false);
        check("文本由空转非空即判定响应开始", started === true);

        // 一直没动静 → 超时报错
        const provider3 = make(ChatGPTProvider, { responseTimeout: 40, responsePollInterval: 5 });
        provider3.isPageAlive = () => true;
        provider3.getResponseState = async () => ({ count: 1, text: "same" });
        let timeoutError = null;
        try {
            await provider3.waitForResponseStart(1, "same");
        } catch (error) {
            timeoutError = error;
        }
        check(
            "无新响应时超时报错",
            timeoutError && timeoutError.message === "ChatGPT did not start a response within 40ms",
            timeoutError && timeoutError.message
        );
    }

    // ------------------------------------------------------------
    // 7. Action 标签识别（screenshot 必须算 Action）
    // ------------------------------------------------------------
    check("containsActionTag 识别 screenshot", containsActionTag('<screenshot source="window"/>'));
    check("containsActionTag 识别 answer", containsActionTag("<answer>x</answer>"));
    check(
        "containsActionTag 不误判普通文本",
        containsActionTag("这是一个普通回答") === false && containsActionTag(null) === false
    );

    // ------------------------------------------------------------
    // 8. fiber 扫描函数可脱离模块作用域运行
    // ------------------------------------------------------------
    {
        // Playwright 会把函数 toString 后送进页面执行，所以这里用 new Function 还原，
        // 若函数引用了模块作用域变量，这一步就会失败。
        const revived = new Function("return (" + collectFiberCandidates.toString() + ")")();

        const element = {};
        element.__reactProps$abc123 = {
            memoizedValue: { children: "普通文本".repeat(30) },
        };

        const candidates = revived(element);
        check(
            "三向 BFS 能从 props 里捞到候选文本",
            Array.isArray(candidates) && candidates.length > 0,
            Array.isArray(candidates) ? String(candidates.length) : typeof candidates
        );
        check(
            "候选带 hasAction 标记",
            Array.isArray(candidates) && typeof candidates[0].hasAction === "boolean",
            JSON.stringify(candidates[0] && candidates[0].hasAction)
        );
    }

    {
        const revived = new Function("return (" + collectChildFiberCandidate.toString() + ")")();

        const element = {};
        element.__reactFiber$abc123 = {
            memoizedProps: { content: "<answer>" + "a".repeat(150) + "</answer>" },
            child: null,
        };

        const result = revived(element);
        check(
            "child-only 扫描返回 top/candidates 结构",
            result && result.top && Array.isArray(result.candidates),
            result ? JSON.stringify(result.totalCandidates) : "null"
        );
        check(
            "child-only 扫描识别 Action 文本",
            result && result.top && result.top.isAction === true,
            result && result.top ? String(result.top.isAction) : "null"
        );
    }

    // ------------------------------------------------------------
    // 9. 平台特有方法仍然在位（钩子没把差异吃掉）
    // ------------------------------------------------------------
    {
        const deepseek = make(DeepSeekProvider);
        check(
            "DeepSeek 保留上传校验链路",
            typeof deepseek.countImageThumbs === "function" &&
                typeof deepseek.clearPendingAttachments === "function" &&
                typeof deepseek.uploadImages === "function"
        );

        const glm = make(GlmProvider);
        check("GLM 保留元素复用检测", typeof glm.detectReusedResponseKey === "function");

        const qwen = make(QwenProvider);
        check(
            "Qwen 保留生成状态判定",
            typeof qwen.getGenerationState === "function" &&
                typeof qwen.waitForGenerationComplete === "function"
        );

        check(
            "四个平台都实现了契约方法",
            [ChatGPTProvider, QwenProvider, DeepSeekProvider, GlmProvider].every((Provider) => {
                const instance = make(Provider);
                return ["start", "send", "close"].every(
                    (name) => typeof instance[name] === "function"
                );
            })
        );
    }

    console.log("\nTotal: " + pass + "/" + total);
    if (pass !== total) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("测试脚本自身出错：" + error.stack);
    process.exit(1);
});
