const { EventEmitter } = require("events");
const { AgentSession } = require("./agent-session");
const sessionStore = require("./session-store");

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
    }

    /**

从磁盘恢复已保存的会话。

应在进程启动时调用一次；恢复的会话不会处于 running 状态。
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

立即把会话写入磁盘。
*/
    persist(session) {
        if (!session) {
            return;
        }

        try {
            sessionStore.saveSession(session);
        } catch (error) {
            console.error("[WebUI] Failed to persist session " + session.id + ":", error.message);
        }
    }

    /**

节流写盘：短时间内多次调用只写一次。
*/
    schedulePersist(session) {
        if (!session) {
            return;
        }

        if (this.saveTimers.has(session.id)) {
            return;
        }

        const timer = setTimeout(() => {
            this.saveTimers.delete(session.id);
            this.persist(session);
        }, SAVE_THROTTLE_MS);

        if (typeof timer.unref === "function") {
            timer.unref();
        }

        this.saveTimers.set(session.id, timer);
    }

    attachListeners(session) {
        session.on("output", (output) => {
            this.schedulePersist(session);
            this.emit("session.output", session, output);
        });

        session.on("agent.event", (event) => {
            this.emit("session.event", session, event);
        });

        session.on("conversation", (info) => {
            this.persist(session);
            this.emit("session.conversation", session, info);
        });

        session.on("finished", (info) => {
            this.persist(session);
            this.emit("session.finished", session, info);
        });

        session.on("session.error", (error) => {
            this.persist(session);
            this.emit("session.error", session, error);
        });
    }

    create({ workspace, provider = "chatgpt", task, conversationId = null }) {
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

按 provider + conversationId 查找已有 session。

用于"同一 provider 的同一会话 ID 复用同一个 session"。
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

module.exports = {
    SessionManager,
};
