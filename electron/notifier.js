/**
Windows 桌面通知工具。


桌面版在任务完成（status === "completed"）后调用该模块给用户发送系统通知。

优先使用 Electron 的 Notification API；在纯 Node 环境（例如单元测试）下

会回退到一个可注入的发送函数，便于测试而不会真的弹出通知。
*/
const MESSAGES = {
    completed: "任务完成了",
    error: "任务执行出错",
};

/**
归一化通知标题/正文，避免空标题或超长文本导致 Toast 显示异常。
*/
function buildNotificationPayload(input) {
    const data = input && typeof input === "object" ? input : {};
    const title =
        typeof data.title === "string" && data.title.trim() ? data.title.trim() : "XML Agent";
    const body =
        typeof data.body === "string" && data.body.trim() ? data.body.trim() : "任务完成了";
    return { title, body };
}

/**
判断是否需要发送通知。

只在任务真正完成（completed）时发送；出错或用户主动停止时默认不打扰。
*/
function shouldNotify(status) {
    return String(status || "").toLowerCase() === "completed";
}

/**
根据 session 信息生成通知内容。
*/
function buildTaskNotification(sessionInfo) {
    const info = sessionInfo && typeof sessionInfo === "object" ? sessionInfo : {};
    const task = typeof info.task === "string" ? info.task.trim() : "";
    const provider = info.provider || "provider";
    const shortTask = task.length > 60 ? task.slice(0, 60) + "..." : task;
    return {
        title: "XML Agent · 任务完成",
        body: shortTask
            ? shortTask + " (" + provider + ")"
            : MESSAGES.completed + " (" + provider + ")",
    };
}

/**
发送系统通知。


@param {object} options

@param {Function} [options.send] 自定义发送函数，接收 { title, body }，返回布尔。

传入后不会使用 Electron Notification（用于测试或 Node 环境）。

@param {object} [options.payload] { title, body }

@returns {boolean} 是否已成功投递
*/
function notify(options = {}) {
    const payload = buildNotificationPayload(options.payload);
    if (typeof options.send === "function") {
        try {
            return options.send(payload) !== false;
        } catch (error) {
            console.warn("[Notifier] Custom send failed:", error.message);
            return false;
        }
    }
    let Notification = null;
    try {
        // eslint-disable-next-line global-require
        Notification = require("electron").Notification;
    } catch (error) {
        Notification = null;
    }
    if (!Notification) {
        console.warn("[Notifier] Electron Notification is unavailable, skip notification.");
        return false;
    }
    try {
        if (typeof Notification.isSupported === "function" && !Notification.isSupported()) {
            console.warn("[Notifier] System notifications are not supported.");
            return false;
        }
        const notification = new Notification(payload);
        notification.show();
        return true;
    } catch (error) {
        console.warn("[Notifier] Failed to show notification:", error.message);
        return false;
    }
}

module.exports = {
    MESSAGES,
    buildNotificationPayload,
    buildTaskNotification,
    shouldNotify,
    notify,
};
