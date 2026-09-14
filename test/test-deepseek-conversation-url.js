const assert = require("assert");
const path = require("path");

const { DeepSeekProvider } = require(path.join(__dirname, "..", "providers", "deepseek"));

function testGetConversationIdFromUrl() {
    const p = new DeepSeekProvider({ autoStart: false });

    assert.strictEqual(
        p.getConversationIdFromUrl(
            "https://chat.deepseek.com/a/chat/s/9efa4714-38db-4038-a971-226570f7155d"
        ),
        "9efa4714-38db-4038-a971-226570f7155d",
        "should extract UUID from /a/chat/s/<id>"
    );

    assert.strictEqual(
        p.getConversationIdFromUrl(
            "https://chat.deepseek.com/a/chat/s/9efa4714-38db-4038-a971-226570f7155d/"
        ),
        "9efa4714-38db-4038-a971-226570f7155d",
        "should extract UUID with trailing slash"
    );

    assert.strictEqual(
        p.getConversationIdFromUrl("https://chat.deepseek.com/"),
        null,
        "new conversation URL should return null"
    );

    assert.strictEqual(
        p.getConversationIdFromUrl("https://chat.deepseek.com/a/chat/"),
        null,
        "list page should return null"
    );
}

function testBuildTargetUrl() {
    const p1 = new DeepSeekProvider({
        autoStart: false,
        targetUrl: "https://chat.deepseek.com",
    });
    assert.strictEqual(
        p1.buildTargetUrl(),
        "https://chat.deepseek.com",
        "no conversationId -> new session entry"
    );

    const p2 = new DeepSeekProvider({
        autoStart: false,
        targetUrl: "https://chat.deepseek.com",
        conversationId: "abc-123",
    });
    assert.strictEqual(
        p2.buildTargetUrl(),
        "https://chat.deepseek.com/a/chat/s/abc-123",
        "with conversationId -> existing session URL"
    );

    const p3 = new DeepSeekProvider({
        autoStart: false,
        targetUrl: "https://chat.deepseek.com/",
        conversationId: "abc-123",
    });
    assert.strictEqual(
        p3.buildTargetUrl(),
        "https://chat.deepseek.com/a/chat/s/abc-123",
        "trailing slash should be normalized"
    );
}

function testReuseFlag() {
    const p = new DeepSeekProvider({
        autoStart: false,
        conversationId: "cid-1",
        reuseExistingPage: true,
    });
    assert.strictEqual(
        p.reuseExistingPage,
        false,
        "specifying conversationId must disable reuse to avoid stealing other session's page"
    );

    const p2 = new DeepSeekProvider({ autoStart: false, reuseExistingPage: false });
    assert.strictEqual(
        p2.reuseExistingPage,
        false,
        "explicit reuseExistingPage=false should be respected"
    );
}

try {
    testGetConversationIdFromUrl();
    testBuildTargetUrl();
    testReuseFlag();
    console.log("DeepSeek conversation URL test passed");
} catch (error) {
    console.error("DeepSeek conversation URL test failed:", error.message);
    process.exitCode = 1;
}
