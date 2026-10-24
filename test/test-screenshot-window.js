const path = require("path");
const fs = require("fs");
const { listWindows } = require("../capture/screenshot");
const { takeScreenshot } = require("../webui/screenshot-api");
async function run() {
    const workspace = path.resolve(__dirname, "..", "test-output-screenshot");
    fs.mkdirSync(workspace, { recursive: true });
    const titles = await listWindows();
    console.log("VISIBLE_WINDOWS_COUNT:" + titles.length);
    console.log("VISIBLE_WINDOWS:" + JSON.stringify(titles));
    if (!titles.length) {
        console.log("SKIP: no visible windows");
        return;
    }
    const target = titles.find((t) => /visual studio code/i.test(t)) || titles[0];
    console.log("TARGET_WINDOW:" + target);
    const result = await takeScreenshot({
        workspace: workspace,
        source: "window",
        windowTitle: target,
        path: "screenshots/live-window.png",
    });
    console.log("RESULT_JSON:" + JSON.stringify(result));
    if (!result.ok) {
        process.exit(1);
    }
}
run().catch((error) => {
    console.error("WINDOW TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
