const assert = require("assert");
const path = require("path");

const { normalizeConversationId } = require(path.join(__dirname, "..", "webui", "server"));

// DeepSeek: 纯 id
assert.strictEqual(
    normalizeConversationId("deepseek", "9efa4714-38db-4038-a971-226570f7155d"),
    "9efa4714-38db-4038-a971-226570f7155d",
    "deepseek: pure id"
);

// DeepSeek: 完整 URL
assert.strictEqual(
    normalizeConversationId(
        "deepseek",
        "https://chat.deepseek.com/a/chat/s/9efa4714-38db-4038-a971-226570f7155d"
    ),
    "9efa4714-38db-4038-a971-226570f7155d",
    "deepseek: full URL"
);

// DeepSeek: 新会话入口 URL -> null（表示新会话）
assert.strictEqual(
    normalizeConversationId("deepseek", "https://chat.deepseek.com"),
    null,
    "deepseek: new conversation URL -> null"
);

assert.strictEqual(
    normalizeConversationId("deepseek", "https://chat.deepseek.com/a/chat/"),
    null,
    "deepseek: list URL -> null"
);

// ChatGPT
assert.strictEqual(
    normalizeConversationId("chatgpt", "https://chatgpt.com/c/6712abcd-1234"),
    "6712abcd-1234",
    "chatgpt: full URL"
);

assert.strictEqual(
    normalizeConversationId("chatgpt", "6712abcd-1234"),
    "6712abcd-1234",
    "chatgpt: pure id"
);

// Qwen
assert.strictEqual(
    normalizeConversationId("qwen", "https://chat.qwen.ai/c/abcd-1234"),
    "abcd-1234",
    "qwen: full URL"
);

// 空输入 -> null
assert.strictEqual(normalizeConversationId("deepseek", ""), null, "empty string -> null");
assert.strictEqual(normalizeConversationId("deepseek", " "), null, "whitespace -> null");
assert.strictEqual(normalizeConversationId("deepseek", null), null, "null -> null");
assert.strictEqual(normalizeConversationId("deepseek", undefined), null, "undefined -> null");

console.log("normalizeConversationId test passed");
