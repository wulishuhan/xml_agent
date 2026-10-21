/**
桌面版任务完成通知封装。


仅当运行在 Electron 桌面版（window.xmlAgentDesktop.notifications 存在）时

才会真正调用主进程发送 Windows 系统通知；Web 版静默跳过。


只在任务真正完成（status === "completed"）时通知，避免用户主动停止或出错时打扰。
*/
function getDesktopBridge() {
    if (typeof window === "undefined") {
        return null;
    }
    const desktop = window.xmlAgentDesktop;
    if (!desktop || desktop.isElectron !== true) {
        return null;
    }
    if (!desktop.notifications) {
        return null;
    }
    return desktop;
}

/**
判断任务状态是否应触发完成通知。
*/
export function isTaskCompleted(status) {
    return String(status || "").toLowerCase() === "completed";
}

/**
任务完成时发送桌面通知。


@param {object} sessionInfo 会话信息（含 status/task/provider 等）

@returns {Promise<boolean>} 是否已成功投递（Web 版或非完成状态返回 false）
*/
export async function notifyTaskCompleted(sessionInfo) {
    const info = sessionInfo && typeof sessionInfo === "object" ? sessionInfo : {};
    if (!isTaskCompleted(info.status)) {
        return false;
    }
    const desktop = getDesktopBridge();
    if (!desktop) {
        return false;
    }
    try {
        const result = await desktop.notifications.taskDone(info);
        return !!(result && result.ok);
    } catch (error) {
        console.warn("[desktop-notify] Failed to send task-done notification:", error.message);
        return false;
    }
}
