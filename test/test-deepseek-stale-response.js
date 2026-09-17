const { createProvider } = require("../providers");
const config = require("../config/agent-config");
(async () => {
    const provider = createProvider("deepseek", {
        autoStart: false,
        cdpUrl: config.browser.cdpUrl,
        targetUrl: config.browser.targetUrls.deepseek,
        reuseExistingPage: true,
    });
    await provider.start();
    try {
        const before = await provider.getResponseState();
        console.log("BEFORE", JSON.stringify(before));
        const prompt =
            "请只回复一个 answer action，内容必须是：STALE_RESPONSE_DIAG_TEST。不要输出任何其他内容。";

        const result = await provider.send(prompt);
        const after = await provider.getResponseState();

        const info = await provider.page
            .locator(".ds-assistant-message-main-content")
            .evaluateAll((elements) =>
                elements.map((element, index) => ({
                    index,
                    key:
                        element
                            .closest("[data-virtual-list-item-key]")
                            ?.getAttribute("data-virtual-list-item-key") || null,
                    text: (element.innerText || "").slice(0, 220),
                }))
            );

        console.log("RESULT", JSON.stringify(result));
        console.log("AFTER", JSON.stringify(after));
        console.log("INFO", JSON.stringify(info, null, 2));

        if (!result.includes("STALE_RESPONSE_DIAG_TEST")) {
            throw new Error(
                "stale response detected: provider returned a response without the new marker"
            );
        }

        console.log("STALE_RESPONSE_TEST_PASS");
    } finally {
        await provider.close();
    }
})().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
