const { EventEmitter } = require("events");
const { AgentSession } = require("./agent-session");

class SessionManager extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map();
    }

    create({ workspace, provider = "chatgpt", task }) {
        const session = new AgentSession({
            workspace,
            provider,
            task,
        });

        this.sessions.set(session.id, session);

        session.on("output", (output) => {
            this.emit("session.output", session, output);
        });

        session.on("agent.event", (event) => {
            this.emit("session.event", session, event);
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
