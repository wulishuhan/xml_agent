/**

测试 conversationId 相关的能力：

DeepSeek / ChatGPT / Qwen 各自能正确从 URL 提取 conversationId

buildTargetUrl 能根据 conversationId 拼接出正确的目标 URL

这里只测试纯逻辑，不真正启动浏览器。
*/

const assert = require("assert");
const path = require("path");

const { DeepSeekProvider } = require(path.join(__dirname, "..", "providers", "deepseek.js"));
const { ChatGPTProvider } = require(path.join(__dirname, "..", "providers", "chatgpt.js"));
const { QwenProvider } = require(path.join(__dirname, "..", "providers", "qwen.js"));

function makeProvider(ProviderClass, options) {
    // 构造 Provider 时指定 autoStart=false 且 cdpUrl 指向一个不存在的端口，
    // 这样构造过程不会真的连上浏览器。
    return new ProviderClass({
        autoStart: false,
        cdpUrl: "http://127.0.0.1:1",
        ...options,
    });
}

function main() {
    // DeepSeek
    const ds = makeProvider(DeepSeekProvider, {
        targetUrl: "https://chat.deepseek.com",
    });

    assert.strictEqual(
        ds.getConversationIdFromUrl(
            "https://chat.deepseek.com/a/chat/s/9efa4714-38db-4038-a971-226570f7155d"
        ),
        "9efa4714-38db-4038-a971-226570f7155d",
        "DeepSeek conversationId extraction"
    );

    assert.strictEqual(
        ds.getConversationIdFromUrl("https://chat.deepseek.com/a/chat/s/"),
        null,
        "DeepSeek should return null for root chat url"
    );

    assert.strictEqual(
        ds.getConversationIdFromUrl("https://chat.deepseek.com/"),
        null,
        "DeepSeek should return null for home url"
    );

    // DeepSeek buildTargetUrl
    assert.strictEqual(
        ds.buildTargetUrl(),
        "https://chat.deepseek.com",
        "DeepSeek new conversation url"
    );

    const dsWithConv = makeProvider(DeepSeekProvider, {
        targetUrl: "https://chat.deepseek.com",
        conversationId: "9efa4714-38db-4038-a971-226570f7155d",
    });

    assert.strictEqual(
        dsWithConv.buildTargetUrl(),
        "https://chat.deepseek.com/a/chat/s/9efa4714-38db-4038-a971-226570f7155d",
        "DeepSeek existing conversation url"
    );

    // 指定 conversationId 时强制新建页面
    assert.strictEqual(
        dsWithConv.reuseExistingPage,
        false,
        "DeepSeek should not reuse page when conversationId is set"
    );

    // ChatGPT
    const gpt = makeProvider(ChatGPTProvider, {
        targetUrl: "https://chatgpt.com",
    });

    assert.strictEqual(
        gpt.getConversationIdFromUrl("https://chatgpt.com/c/6712abcd-1234-5678-9abc-def012345678"),
        "6712abcd-1234-5678-9abc-def012345678",
        "ChatGPT conversationId extraction"
    );

    assert.strictEqual(
        gpt.getConversationIdFromUrl("https://chatgpt.com/"),
        null,
        "ChatGPT should return null for home url"
    );

    assert.strictEqual(gpt.buildTargetUrl(), "https://chatgpt.com", "ChatGPT new conversation url");

    const gptWithConv = makeProvider(ChatGPTProvider, {
        targetUrl: "https://chatgpt.com",
        conversationId: "6712abcd-1234-5678-9abc-def012345678",
    });

    assert.strictEqual(
        gptWithConv.buildTargetUrl(),
        "https://chatgpt.com/c/6712abcd-1234-5678-9abc-def012345678",
        "ChatGPT existing conversation url"
    );

    // Qwen
    const qwen = makeProvider(QwenProvider, {
        targetUrl: "https://chat.qwen.ai",
    });

    assert.strictEqual(
        qwen.getConversationIdFromUrl("https://chat.qwen.ai/c/abcd1234-efgh-5678"),
        "abcd1234-efgh-5678",
        "Qwen conversationId extraction"
    );

    assert.strictEqual(
        qwen.getConversationIdFromUrl("https://chat.qwen.ai/"),
        null,
        "Qwen should return null for home url"
    );

    assert.strictEqual(qwen.buildTargetUrl(), "https://chat.qwen.ai", "Qwen new conversation url");

    const qwenWithConv = makeProvider(QwenProvider, {
        targetUrl: "https://chat.qwen.ai",
        conversationId: "abcd1234-efgh-5678",
    });

    assert.strictEqual(
        qwenWithConv.buildTargetUrl(),
        "https://chat.qwen.ai/c/abcd1234-efgh-5678",
        "Qwen existing conversation url"
    );

    console.log("Electron conversation id test passed:");
    console.log(" - DeepSeek URL parse + buildTargetUrl ok");
    console.log(" - ChatGPT URL parse + buildTargetUrl ok");
    console.log(" - Qwen URL parse + buildTargetUrl ok");
}

try {
    main();
} catch (error) {
    console.error("Electron conversation id test failed:", error.message);
    process.exitCode = 1;
}
