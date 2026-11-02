/**
会话存储统计接口（从 server.js 拆出）

GET  /api/storage        会话数量 / 磁盘占用 / 上限与告警状态
POST /api/storage/clean  清理异常退出遗留的 .tmp 临时文件
*/

function registerStorageRoutes(app, deps = {}) {
    const getSessionManager = () => deps.sessionManager;

    // 会话存储占用统计：供前端显示数量/磁盘占用并提示用户清理。
    app.get("/api/storage", (req, res) => {
        res.json(getSessionManager().getStorageStats());
    });

    // 手动清理遗留的 .tmp 临时文件。
    app.post("/api/storage/clean", (req, res) => {
        const cleanedBytes = getSessionManager().cleanOrphanTmpFiles();
        return res.json({
            message: "Cleaned orphan temp files",
            cleanedBytes,
            stats: getSessionManager().getStorageStats(),
        });
    });
}

module.exports = {
    registerStorageRoutes,
};
