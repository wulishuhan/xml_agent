<template>
    <div class="app">
        <header class="header">
            <div>
                <h1>XML Agent</h1>

                <p>Node.js Agent Harness</p>
            </div>
        </header>

        <main class="container">
            <AgentForm :running="running" @run="runAgent" @stop="stopAgent" @clear="clearConsole" />

            <AgentStatus
                :status="sessionStatus"
                :provider="session?.provider"
                :pid="session?.pid"
                :output-length="output.length"
            />

            <SessionInfo :session="session" />

            <AgentConsole :output="output" @clear="clearConsole" />
        </main>

        <footer>
            XML Agent Web UI
            <span>•</span>
            Node.js + Express + Vue 3
        </footer>
    </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from "vue";

import AgentForm from "./components/AgentForm.vue";
import AgentStatus from "./components/AgentStatus.vue";
import AgentConsole from "./components/AgentConsole.vue";
import SessionInfo from "./components/SessionInfo.vue";

import {
    runAgent as apiRunAgent,
    getSession,
    getSessionOutput,
    stopSession,
} from "./services/agent-api.js";

const session = ref(null);

const output = ref([]);

const pollTimer = ref(null);

const sessionStatus = computed(() => {
    return session.value?.status || "created";
});

const running = computed(() => {
    return session.value?.running === true;
});

async function runAgent(config) {
    if (running.value) {
        return;
    }

    clearConsole();

    session.value = null;

    try {
        const result = await apiRunAgent(config);

        const sessionId = result.sessionId;

        await refreshSession(sessionId);

        startPolling(sessionId);
    } catch (error) {
        output.value.push({
            type: "error",
            content: error.message,
        });
    }
}

async function refreshSession(sessionId) {
    try {
        const result = await getSession(sessionId);

        session.value = result;
    } catch (error) {
        output.value.push({
            type: "error",
            content: error.message,
        });
    }
}

async function refreshOutput(sessionId) {
    try {
        const result = await getSessionOutput(sessionId);

        output.value = result.output || [];

        if (!result.running) {
            await refreshSession(sessionId);

            stopPolling();
        }
    } catch (error) {
        output.value.push({
            type: "error",
            content: error.message,
        });

        stopPolling();
    }
}

function startPolling(sessionId) {
    stopPolling();

    refreshOutput(sessionId);

    pollTimer.value = setInterval(() => {
        refreshOutput(sessionId);
    }, 500);
}

function stopPolling() {
    if (pollTimer.value) {
        clearInterval(pollTimer.value);

        pollTimer.value = null;
    }
}

async function stopAgent() {
    if (!session.value?.id) {
        return;
    }

    try {
        await stopSession(session.value.id);

        await refreshSession(session.value.id);

        await refreshOutput(session.value.id);
    } catch (error) {
        output.value.push({
            type: "error",
            content: error.message,
        });
    }
}

function clearConsole() {
    output.value = [];
}

onUnmounted(() => {
    stopPolling();
});
</script>
