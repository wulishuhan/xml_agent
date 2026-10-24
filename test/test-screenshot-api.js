const path = require("path");
const fs = require("fs");
const http = require("http");
function postJson(port, pathName, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
            {
                host: "127.0.0.1",
                port: port,
                path: pathName,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => {
                    data += chunk.toString();
                });
                res.on("end", () => {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(data);
                    } catch (error) {
                        parsed = { raw: data };
                    }
                    resolve({ status: res.statusCode, body: parsed });
                });
            }
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}
async function run() {
    const { startServer, shutdown } = require("../webui/server");
    const workspace = path.resolve(__dirname, "..", "test-output-screenshot");
    fs.mkdirSync(workspace, { recursive: true });
    const port = 4599;
    startServer({ port: port });
    // 等 listen 完成
    await new Promise((resolve) => setTimeout(resolve, 800));
    const response = await postJson(port, "/api/screenshot", {
        workspace: workspace,
        source: "screen",
        path: "screenshots/api-screen.png",
    });
    console.log("API_STATUS:" + response.status);
    console.log("API_BODY:" + JSON.stringify(response.body));
    // 越界路径应被拒绝
    const escape = await postJson(port, "/api/screenshot", {
        workspace: workspace,
        source: "screen",
        path: "../evil.png",
    });
    console.log("ESCAPE_STATUS:" + escape.status);
    console.log("ESCAPE_BODY:" + JSON.stringify(escape.body));
    await shutdown();
    if (response.status !== 200 || response.body.ok !== true) {
        throw new Error("API screenshot should succeed");
    }
    if (escape.status !== 400) {
        throw new Error("escaping path should be rejected with 400");
    }
    console.log("SCREENSHOT API TEST PASSED");
    process.exit(0);
}
run().catch((error) => {
    console.error("API TEST FAILED:", error && error.stack ? error.stack : error);
    process.exit(1);
});
