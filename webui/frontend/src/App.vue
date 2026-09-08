<template>
    <div class="app-shell">
        <SessionSidebar
            :sessions="sessions"
            :active-id="activeSessionId"
            @select="selectSession"
            @new-session="createNewSession"
        />
        <main class="workspace-view">
            <header class="workspace-header">
                <div class="workspace-heading">
                    <div class="workspace-icon">⌘</div>
                    <div>
                        <div class="workspace-title">
                            {{ activeSession ? sessionTitle(activeSession) : "New Agent Session" }}
                        </div>
                        <div class="workspace-path" :title="workspace">
                            {{ workspace || "Please set a workspace to begin" }}
                        </div>
                    </div>
                </div>
                <div class="workspace-actions">
                    <select v-model="provider" :disabled="running">
                        <option value="chatgpt">ChatGPT</option>
                        <option value="qwen">Qwen</option>
                        <option value="deepseek">DeepSeek</option>
                    </select>
                    <span class="status-badge" :class="'status-' + sessionStatus">
                        {{ statusText }}
                    </span>
                </div>
            </header>
            <section class="workspace-body">
                <div v-if="activeSession" class="session-context">
                    <div class="context-item">
                        <span class="context-label">Workspace</span>
                        <code>{{ activeSession.workspace }}</code>
                    </div>
                    <div class="context-item">
                        <span class="context-label">Provider</span>
                        <span>{{ activeSession.provider }}</span>
                    </div>
                    <div class="context-item">
                        <span class="context-label">Session</span>
                        <code>{{ shortId(activeSession.id) }}</code>
                    </div>
                </div>

                <AgentConsole :output="output" :session="activeSession" @clear="clearConsole" />

                <div v-if="errorMessage" class="error-banner">
                    <strong>Agent error</strong> <span>{{ errorMessage }}</span>
                </div>
                <div v-if="!activeSession" class="welcome">
                    <div class="welcome-mark">&lt;/&gt;</div>
                    <h1>Build with your Agent</h1>
                    <p>
                        Create a session, choose a workspace, and let the Agent inspect, modify, and
                        test your project.
                    </p>
                </div>
                <div class="composer-shell">
                    <div
                        class="workspace-input-row"
                        :class="{ 'workspace-input-row--required': !workspace.trim() }"
                    >
                        <label class="workspace-input">
                            <span class="workspace-input-label">Workspace</span>

                            <input
                                ref="workspaceInput"
                                v-model="workspace"
                                :disabled="running"
                                type="text"
                                placeholder="Enter an absolute path, for example D:/projects/my-app"
                                @keydown.enter="focusTask"
                            />
                        </label>

                        <span v-if="!workspace.trim()" class="workspace-required-hint">
                            Required · this path is different on each computer
                        </span>
                    </div>

                    <TaskComposer
                        v-model:task="task"
                        :provider="provider"
                        :running="running"
                        @run="runAgent"
                        @stop="stopAgent"
                    />
                </div>
            </section>
        </main>
    </div>
</template>
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import AgentConsole from "./components/AgentConsole.vue";
import SessionSidebar from "./components/SessionSidebar.vue";
import TaskComposer from "./components/TaskComposer.vue";
import {
    deleteSession,
    getSession,
    getSessionOutput,
    getSessions,
    runAgent as apiRunAgent,
    stopSession,
} from "./services/agent-api.js";

const sessions = ref([]);
const activeSessionId = ref(null);
const activeSession = ref(null);
const output = ref([]);
const errorMessage = ref("");
const eventSource = ref(null);
const workspace = ref("");
const provider = ref("chatgpt");
const task = ref("");
const workspaceInput = ref(null);

const sessionStatus = computed(() => {
    return activeSession.value?.status || "created";
});

const running = computed(() => {
    return activeSession.value?.running === true;
});

const statusText = computed(() => {
    const labels = {
        created: "Ready",
        running: "Running",
        completed: "Completed",
        stopped: "Stopped",
        error: "Error",
    };

    return labels[sessionStatus.value] || sessionStatus.value;
});

async function loadSessions() {
    try {
        const result = await getSessions();
        sessions.value = result.sessions || [];

        if (activeSessionId.value) {
            const existing = sessions.value.find((session) => session.id === activeSessionId.value);

            if (existing) {
                await selectSession(existing.id);
                return;
            }
        }

        if (sessions.value.length) {
            await selectSession(sessions.value[0].id);
        }
    } catch (error) {
        errorMessage.value = error.message;
    }
}

async function selectSession(sessionId) {
    if (!sessionId) {
        return;
    }

    activeSessionId.value = sessionId;
    errorMessage.value = "";
    closeEventSource();

    try {
        const [sessionResult, outputResult] = await Promise.all([
            getSession(sessionId),
            getSessionOutput(sessionId),
        ]);

        activeSession.value = sessionResult;
        output.value = outputResult.output || [];
        workspace.value = sessionResult.workspace || "";
        provider.value = sessionResult.provider || provider.value;
        task.value = sessionResult.task || "";

        subscribeToSession(sessionId);
    } catch (error) {
        errorMessage.value = error.message;
    }
}

function subscribeToSession(sessionId) {
    closeEventSource();
    const source = new EventSource("/api/sessions/" + sessionId + "/events");

    source.addEventListener("output", (event) => {
        try {
            const record = JSON.parse(event.data);

            if (
                !output.value.some((item) => {
                    return (
                        item.timestamp === record.timestamp &&
                        item.type === record.type &&
                        item.content === record.content
                    );
                })
            ) {
                output.value.push(record);
            }
        } catch (error) {
            errorMessage.value = error.message;
        }
    });

    source.addEventListener("finished", (event) => {
        try {
            activeSession.value = JSON.parse(event.data);
            updateSessionList(activeSession.value);
        } catch (error) {
            errorMessage.value = error.message;
        }
    });

    source.addEventListener("error", (event) => {
        if (event.data) {
            try {
                const result = JSON.parse(event.data);
                errorMessage.value = result.message || "Agent error";
            } catch {
                errorMessage.value = "Agent event stream error";
            }
        }
    });

    eventSource.value = source;
}

async function runAgent() {
    if (running.value) {
        return;
    }

    if (!workspace.value.trim()) {
        errorMessage.value = "Please enter a workspace path before running the agent.";
        await nextTick();
        workspaceInput.value?.focus();
        return;
    }

    if (!task.value.trim()) {
        errorMessage.value = "Please describe the task before running the agent.";
        return;
    }

    errorMessage.value = "";

    try {
        const result = await apiRunAgent({
            workspace: workspace.value.trim(),
            provider: provider.value,
            task: task.value.trim(),
        });

        activeSessionId.value = result.sessionId;
        await loadSessions();
        await selectSession(result.sessionId);
    } catch (error) {
        errorMessage.value = error.message;
    }
}

async function stopAgent() {
    if (!activeSessionId.value || !running.value) {
        return;
    }

    try {
        await stopSession(activeSessionId.value);
        await selectSession(activeSessionId.value);
        await loadSessions();
    } catch (error) {
        errorMessage.value = error.message;
    }
}

function createNewSession() {
    closeEventSource();
    activeSessionId.value = null;
    activeSession.value = null;
    output.value = [];
    errorMessage.value = "";
    task.value = "";
    workspace.value = "";
}

function clearConsole() {
    output.value = [];
}

function updateSessionList(session) {
    const index = sessions.value.findIndex((item) => item.id === session.id);

    if (index === -1) {
        sessions.value.unshift(session);
        return;
    }

    sessions.value[index] = session;
}

function closeEventSource() {
    if (!eventSource.value) {
        return;
    }

    eventSource.value.close();
    eventSource.value = null;
}

function sessionTitle(session) {
    const value = (session.task || "").trim();

    if (!value) {
        return "Untitled session";
    }

    return value.length > 72 ? value.slice(0, 72) + "…" : value;
}

function shortId(id) {
    return id ? id.slice(0, 8) : "-";
}

function focusTask() {
    if (running.value) {
        return;
    }

    const textarea = document.querySelector(".composer textarea");
    textarea?.focus();
}

onMounted(loadSessions);
onUnmounted(closeEventSource);
</script>
