const { EventEmitter } = require("events");
const { AgentSession } = require("./agent-session");

class SessionManager extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map();
    }

    create({ workspace, provider = "chatgpt", task, conversationId = null }) {
        const session = new AgentSession({
            workspace,
            provider,
            task,
            conversationId,
        });

        this.sessions.set(session.id, session);

        session.on("output", (output) => {
            this.emit("session.output", session, output);
        });

        session.on("agent.event", (event) => {
            this.emit("session.event", session, event);
        });

        session.on("conversation", (info) => {
            this.emit("session.conversation", session, info);
        });

        session.on("finished", (info) => {
            this.emit("session.finished", session, info);
        });

        session.on("session.error", (error) => {
            this.emit("session.error", session, error);
        });

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

        this.sessions.delete(id);
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

        return runningSessions.length;
    }
}

module.exports = {
    SessionManager,
};
