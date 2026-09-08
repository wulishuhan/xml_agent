/**

ChatGPT 调试测试 - 检查页面状态
*/
const agentConfig = require("../config/agent-config.js");
const { createProvider } = require("../providers");

const TEST_CDP_PORT = 9225;
const TEST_CDP_URL = "http://127.0.0.1:" + TEST_CDP_PORT;

console.log("============================================================");
console.log("ChatGPT Debug Test");
console.log("============================================================");
console.log("");

async function runDebug() {
    let provider = null;
    try {
        provider = createProvider("chatgpt", {
            cdpUrl: TEST_CDP_URL,
            autoStart: true,
            startTimeout: 30000,
            chromePath: agentConfig.browser.chromePath,
        });

        await provider.start();
        console.log("✅ Provider started");

        // 等待页面加载
        await provider.sleep(5000);

        // 检查页面URL
        const url = await provider.page.url();
        console.log("Current URL: " + url);

        // 检查是否存在登录障碍
        const pageContent = await provider.page.content();
        const hasLogin =
            pageContent.includes("Log in") ||
            pageContent.includes("Sign in") ||
            pageContent.includes("login");
        console.log("Has login screen: " + hasLogin);

        // 检查是否有输入框
        const input = await provider.getInput();
        console.log("Input found: " + (input ? "Yes" : "No"));

        // 检查是否有输入框的其他备选
        const textarea = provider.page.locator("textarea");
        const textareaCount = await textarea.count();
        console.log("Textarea count: " + textareaCount);

        const contentEditable = provider.page.locator("[contenteditable='true']");
        const contentEditableCount = await contentEditable.count();
        console.log("Contenteditable count: " + contentEditableCount);

        const roleTextbox = provider.page.locator("div[role='textbox']");
        const roleTextboxCount = await roleTextbox.count();
        console.log("Div[role='textbox'] count: " + roleTextboxCount);

        // 尝试手动填充
        if (input) {
            console.log("Attempting to fill input...");
            await input.click();
            await input.fill("Test message");
            const value = await provider.getInputValue(input);
            console.log("Input value after fill: " + (value || "(empty)"));
        }

        console.log("\n=== Summary ===");
        if (hasLogin) {
            console.log("❌ ChatGPT requires login - please log in manually in the browser");
        } else if (input) {
            console.log("✅ Input found and fill worked");
        } else {
            console.log("❌ No input found - page structure may have changed");
        }
    } catch (error) {
        console.error("Debug error:", error.message);
    } finally {
        if (provider) {
            try {
                await provider.close();
                console.log("✅ Provider closed");
            } catch (e) {}
        }
    }
}

runDebug();
