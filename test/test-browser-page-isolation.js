/**

Browser Page 隔离验证测试

使用 DeepSeek Provider 验证：

两个 Provider 可以连接同一个 CDP Browser。

reuseExistingPage=false 时，每个 Provider 创建不同的 Page。

不依赖 DeepSeek 页面加载和输入框，避免网络/登录状态导致测试超时。
*/

const { chromium } = require("playwright");
const agentConfig = require("../config/agent-config");
const { createProvider } = require("../providers");

async function runTest() {
    const cdpUrl = agentConfig.browser.cdpUrl;
    let browser = null;
    let provider1 = null;
    let provider2 = null;

    try {
        console.log("============================================================");
        console.log("DeepSeek Browser Page Isolation Test");
        console.log("============================================================");
        console.log("");
        console.log("CDP URL:", cdpUrl);

        browser = await chromium.connectOverCDP(cdpUrl);

        provider1 = createProvider("deepseek", {
            cdpUrl,
            autoStart: false,
            targetUrl: "",
            reuseExistingPage: false,
        });

        provider2 = createProvider("deepseek", {
            cdpUrl,
            autoStart: false,
            targetUrl: "",
            reuseExistingPage: false,
        });

        // 直接复用已经连接的 Browser，测试目标聚焦于 ensurePage()。
        provider1.browser = browser;
        provider2.browser = browser;

        console.log("");
        console.log("Creating page for provider 1...");
        await provider1.ensurePage();

        console.log("Provider 1 page created:", !!provider1.page);
        console.log("Provider 1 page URL:", provider1.page.url());

        console.log("");
        console.log("Creating page for provider 2...");
        await provider2.ensurePage();

        console.log("Provider 2 page created:", !!provider2.page);
        console.log("Provider 2 page URL:", provider2.page.url());
        console.log("");

        if (!provider1.page || provider1.page.isClosed()) {
            throw new Error("Provider 1 page is not alive");
        }

        if (!provider2.page || provider2.page.isClosed()) {
            throw new Error("Provider 2 page is not alive");
        }

        if (provider1.page === provider2.page) {
            throw new Error("Provider 1 and Provider 2 are using the same Page");
        }

        if (provider1.context !== provider2.context) {
            throw new Error("Providers are unexpectedly using different BrowserContexts");
        }

        const pages = provider1.context.pages();

        if (pages.length < 2) {
            throw new Error(
                "Expected at least 2 pages in the shared BrowserContext, got " + pages.length
            );
        }

        console.log("Provider 1 Page === Provider 2 Page:", provider1.page === provider2.page);
        console.log("Shared BrowserContext:", provider1.context === provider2.context);
        console.log("Shared BrowserContext page count:", pages.length);
        console.log("");
        console.log("Browser Page isolation test passed.");
    } finally {
        if (provider2) {
            provider2.page = null;
            provider2.context = null;
            provider2.browser = null;
        }

        if (provider1) {
            provider1.page = null;
            provider1.context = null;
            provider1.browser = null;
        }

        if (browser) {
            await browser.close();
        }
    }
}

if (require.main === module) {
    runTest()
        .then(function () {
            process.exit(0);
        })
        .catch(function (error) {
            console.error("Browser Page isolation test failed:", error.message);
            process.exit(1);
        });
}

module.exports = {
    runTest,
};
