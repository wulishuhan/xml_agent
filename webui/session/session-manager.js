const { EventEmitter } = require("events");
const { AgentSession } = require("./agent-session");
const sessionStore = require("./session-store");
const agentConfig = require("../../config/agent-config");
/**


会话持久化的节流时间（毫秒）。



会话运行过程中会产生大量 output，逐条写盘代价太高，


因此用定时器合并写入。
*/
const SAVE_THROTTLE_MS = 500;

class SessionManager extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map();
        this.saveTimers = new Map();
        this.sessionListeners = new Map();
        this.maxSessions = agentConfig.session.maxSessions;
        this.maxDiskBytes = agentConfig.session.maxDiskBytes;
        this.warnThreshold = agentConfig.session.warnThreshold;
    }
    /**
     * 从磁盘恢复已保存的会话。
     *
     * 应在进程启动时调用一次；恢复的会话不会处于 running 状态。
     */
    restore() {
        const records = sessionStore.listSavedSessions();

        for (const record of records) {
            const info = record.info;

            if (!info || !info.id) {
                continue;
            }

            try {
                const session = new AgentSession({
                    workspace: info.workspace,
                    provider: info.provider,
                    task: info.task,
                    conversationId: info.conversationId,
                });

                session.restore({
                    ...info,
                    output: record.output || [],
                });

                this.attachListeners(session);
                this.sessions.set(session.id, session);
            } catch (error) {
                // 单个会话恢复失败不影响其它会话
                console.error("[WebUI] Failed to restore session:", error.message);
            }
        }

        return this.sessions.size;
    }

    /**
     * 立即把会话写入磁盘。
     */
    persist(session) {
        if (!session || !this.sessions.has(session.id)) {
            return;
        }

        try {
            sessionStore.saveSession(session);
        } catch (error) {
            console.error("[WebUI] Failed to persist session " + session.id + ":", error.message);
        }
    }

    /**
     * 节流写盘：短时间内多次调用只写一次。
     */
    schedulePersist(session) {
        if (!session || !this.sessions.has(session.id)) {
            return;
        }

        if (this.saveTimers.has(session.id)) {
            return;
        }

        const timer = setTimeout(() => {
            this.saveTimers.delete(session.id);

            // 会话可能已经在定时器触发前被删除。
            // 删除后的 session 绝不能再次写回磁盘。
            if (this.sessions.has(session.id)) {
                this.persist(session);
            }
        }, SAVE_THROTTLE_MS);

        if (typeof timer.unref === "function") {
            timer.unref();
        }

        this.saveTimers.set(session.id, timer);
    }

    attachListeners(session) {
        const listeners = {
            output: (output) => {
                if (!this.sessions.has(session.id)) {
                    return;
                }

                this.schedulePersist(session);
                this.emit("session.output", session, output);
            },

            agentEvent: (event) => {
                if (!this.sessions.has(session.id)) {
                    return;
                }

                this.emit("session.event", session, event);
            },

            conversation: (info) => {
                if (!this.sessions.has(session.id)) {
                    return;
                }

                this.persist(session);
                this.emit("session.conversation", session, info);
            },

            finished: (info) => {
                if (!this.sessions.has(session.id)) {
                    return;
                }

                this.persist(session);
                this.emit("session.finished", session, info);
            },

            sessionError: (error) => {
                if (!this.sessions.has(session.id)) {
                    return;
                }

                this.persist(session);
                this.emit("session.error", session, error);
            },
        };

        session.on("output", listeners.output);
        session.on("agent.event", listeners.agentEvent);
        session.on("conversation", listeners.conversation);
        session.on("finished", listeners.finished);
        session.on("session.error", listeners.sessionError);

        this.sessionListeners.set(session.id, {
            session,
            listeners,
        });
    }

    detachListeners(session) {
        if (!session) {
            return;
        }

        const registration = this.sessionListeners.get(session.id);

        if (!registration) {
            return;
        }

        const { listeners } = registration;

        session.removeListener("output", listeners.output);
        session.removeListener("agent.event", listeners.agentEvent);
        session.removeListener("conversation", listeners.conversation);
        session.removeListener("finished", listeners.finished);
        session.removeListener("session.error", listeners.sessionError);

        this.sessionListeners.delete(session.id);
    }

    /**
     * 检查是否还能创建新会话。
     *
     * 规则：
     *
     * 会话数量达到 maxSessions 时拒绝创建（需先删除旧会话）。
     *
     * 磁盘占用达到 maxDiskBytes 时拒绝创建（需先清理历史）。
     *
     * 返回 { ok, code, message, stats }。
     */
    checkCapacity() {
        const stats = this.getStorageStats();

        if (this.sessions.size >= this.maxSessions) {
            return {
                ok: false,
                code: "MAX_SESSIONS",
                message:
                    "会话数量已达上限（" +
                    this.sessions.size +
                    "/" +
                    this.maxSessions +
                    "）。请删除部分旧会话后再创建新会话。",
                stats,
            };
        }

        if (stats.bytes >= this.maxDiskBytes) {
            return {
                ok: false,
                code: "MAX_DISK",
                message:
                    "会话存储磁盘占用已达上限（" +
                    formatBytes(stats.bytes) +
                    " / " +
                    formatBytes(this.maxDiskBytes) +
                    "）。请删除部分旧会话后再创建新会话。",
                stats,
            };
        }

        return { ok: true, stats };
    }

    /**
     * 获取会话存储的统计信息，包含上限与告警状态，供前端展示。
     */
    getStorageStats() {
        let stats;

        try {
            stats = sessionStore.getStoreStats();
        } catch (error) {
            stats = { root: sessionStore.STORE_ROOT, count: 0, bytes: 0, largest: null };
        }

        const sessionRatio = this.maxSessions > 0 ? this.sessions.size / this.maxSessions : 0;
        const diskRatio = this.maxDiskBytes > 0 ? stats.bytes / this.maxDiskBytes : 0;
        const ratio = Math.max(sessionRatio, diskRatio);

        return {
            root: stats.root,
            sessions: this.sessions.size,
            maxSessions: this.maxSessions,
            bytes: stats.bytes,
            maxDiskBytes: this.maxDiskBytes,
            ratio,
            warn: ratio >= this.warnThreshold,
            overLimit: ratio >= 1,
        };
    }

    /**
     * 清理遗留的 .tmp 临时文件，返回清理的字节数。
     */
    cleanOrphanTmpFiles() {
        try {
            return sessionStore.cleanOrphanTmpFiles();
        } catch (error) {
            console.error("[WebUI] Failed to clean orphan tmp files:", error.message);
            return 0;
        }
    }

    create({ workspace, provider = "chatgpt", task, conversationId = null }) {
        const capacity = this.checkCapacity();

        if (!capacity.ok) {
            const error = new Error(capacity.message);
            error.code = capacity.code;
            error.stats = capacity.stats;
            throw error;
        }

        const session = new AgentSession({
            workspace,
            provider,
            task,
            conversationId,
        });

        this.sessions.set(session.id, session);
        this.attachListeners(session);

        // 创建后立即落盘，保证即使进程随后崩溃也能恢复会话元信息
        this.persist(session);

        this.emit("session.created", session);

        return session;
    }

    get(id) {
        return this.sessions.get(id) || null;
    }

    /**
     * 按 provider + conversationId 查找已有 session。
     *
     * 用于"同一 provider 的同一会话 ID 复用同一个 session"。
     */
    findByConversation(provider, conversationId) {
        if (!provider || !conversationId) {
            return null;
        }

        for (const session of this.sessions.values()) {
            if (session.provider === provider && session.conversationId === conversationId) {
                return session;
            }
        }

        return null;
    }

    list() {
        return Array.from(this.sessions.values());
    }

    remove(id) {
        const session = this.get(id);

        if (!session) {
            return false;
        }

        if (session.isRunning()) {
            throw new Error("Cannot delete a running session");
        }

        const timer = this.saveTimers.get(session.id);

        if (timer) {
            clearTimeout(timer);
            this.saveTimers.delete(session.id);
        }

        // 先解除所有监听器，防止删除后残留的异步事件再次触发 persist。
        this.detachListeners(session);

        this.sessions.delete(id);

        try {
            sessionStore.deleteSession(session.id);
        } catch (error) {
            console.error(
                "[WebUI] Failed to delete persisted session " + session.id + ":",
                error.message
            );
        }

        this.emit("session.removed", session);

        return true;
    }

    async stop(id) {
        const session = this.get(id);

        if (!session) {
            throw new Error("Session not found");
        }

        return session.stop();
    }

    async stopAll() {
        const runningSessions = this.list().filter((session) => session.isRunning());

        await Promise.all(
            runningSessions.map(async (session) => {
                try {
                    await session.stop();
                } catch (error) {
                    this.emit("session.error", session, error);
                }
            })
        );

        // 关闭前把所有会话的最新状态写盘
        for (const session of this.list()) {
            this.persist(session);
        }

        return runningSessions.length;
    }
}
function formatBytes(bytes) {
    if (!bytes || bytes < 0) {
        return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;

    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }

    return (index === 0 ? value : value.toFixed(1)) + " " + units[index];
}
module.exports = {
    SessionManager,
    formatBytes,
};
