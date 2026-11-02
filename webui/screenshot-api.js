/**
 * 截图 HTTP 接口

本文件只做一件事：把 HTTP 请求体翻译成能力层入参，并把结果翻译成状态码。
参数校验、路径沙箱、结果归一化全部在 capture/take-screenshot.js 里，
以便 plugins/builtin/screenshot 能直接复用同一份实现而不必依赖 webui。

历史上的导出面（takeScreenshot / resolveOutputPath / isPathInside / ...）继续
re-export，既有测试与调用方无需改动。
*/

const capture = require("../capture/take-screenshot");

function registerScreenshotRoutes(app) {
    app.post("/api/screenshot", async (req, res) => {
        try {
            const body = req.body || {};
            const result = await capture.takeScreenshot({
                workspace: body.workspace,
                path: body.path,
                source: body.source,
                url: body.url,
                selector: body.selector,
                clip: body.clip,
                fullPage: body.fullPage,
                windowTitle: body.windowTitle,
                cdpUrl: body.cdpUrl,
                timeout: body.timeout,
            });
            if (!result.ok) {
                return res.status(500).json(result);
            }
            return res.json(result);
        } catch (error) {
            // 参数类错误返回 400，便于前端区分"请求写错了"和"执行失败了"。
            return res.status(400).json({
                ok: false,
                error: error.message,
            });
        }
    });
}

module.exports = {
    registerScreenshotRoutes,
    takeScreenshot: capture.takeScreenshot,
    resolveOutputPath: capture.resolveOutputPath,
    isPathInside: capture.isPathInside,
    normalizeClip: capture.normalizeClip,
    normalizeTimeout: capture.normalizeTimeout,
    toBoolean: capture.toBoolean,
};
