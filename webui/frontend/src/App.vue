<template>
    <div class="app-shell">
        <SessionSidebar
            :sessions="sessions"
            :active-id="activeSessionId"
            :storage="storage"
            @select="selectSession"
            @new-session="createNewSession"
            @delete="deleteSessionById"
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
                    <button
                        type="button"
                        class="btn theme-toggle"
                        :title="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
                        :aria-label="
                            theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
                        "
                        @click="toggleTheme"
                    >
                        <span class="theme-toggle-icon">{{ theme === "dark" ? "☾" : "☀" }}</span>
                        <span class="theme-toggle-label">{{
                            theme === "dark" ? "Dark" : "Light"
                        }}</span>
                    </button>
                    <button
                        v-if="isElectron"
                        type="button"
                        class="btn"
                        title="Desktop settings"
                        @click="showSettings = true"
                    >
                        Settings
                    </button>
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
                    <div v-if="activeConversationId" class="context-item">
                        <span class="context-label">Conversation</span>
                        <code :title="activeConversationId">{{
                            shortId(activeConversationId)
                        }}</code>
                    </div>
                    <div v-if="isElectron" class="context-item">
                        <span class="context-label">Port</span> <code>{{ electronPort }}</code>
                    </div>
                </div>
                <div ref="splitArea" class="split-area" :class="{ resizing }">
                    <div class="console-region" :style="consoleStyle">
                        <AgentConsole
                            :output="output"
                            :session="activeSession"
                            @clear="clearConsole"
                        />
                        <div v-if="errorMessage" class="error-banner">
                            <strong>Agent error</strong> <span>{{ errorMessage }}</span>
                        </div>
                    </div>
                    <div
                        class="split-handle"
                        role="separator"
                        aria-orientation="horizontal"
                        title="Drag to resize output / input. Double-click to reset."
                        @pointerdown="startResize"
                        @dblclick="resetRatio"
                    >
                        <span class="split-handle-grip"></span>
                        <span class="split-handle-pct"
                            >{{ ratioPercent }}% / {{ 100 - ratioPercent }}%</span
                        >
                    </div>
                    <div class="composer-shell" :style="composerStyle">
                        <div
                            class="workspace-input-row"
                            :class="{ 'workspace-input-row--required': !workspace.trim() }"
                        >
                            <div class="workspace-input">
                                <span class="workspace-input-label">Workspace</span>
                                <input
                                    ref="workspaceInput"
                                    v-model="workspace"
                                    :disabled="running"
                                    type="text"
                                    placeholder="Enter an absolute path, for example D:/projects/my-app"
                                    @keydown.enter="focusTask"
                                />
                                <button
                                    type="button"
                                    class="btn workspace-browse-button"
                                    :disabled="running"
                                    @click="openWorkspacePicker"
                                >
                                    Browse
                                </button>
                            </div>
                            <span v-if="!workspace.trim()" class="workspace-required-hint">
                                Required - this path is different on each computer
                            </span>
                        </div>

                        <TaskComposer
                            v-model:task="task"
                            v-model:conversationId="conversationId"
                            :provider="provider"
                            :running="running"
                            @run="runAgent"
                            @stop="stopAgent"
                        />
                    </div>
                </div>
            </section>
        </main>

        <WorkspacePicker
            v-if="showWorkspacePicker"
            @select="selectWorkspace"
            @close="closeWorkspacePicker"
        />

        <DesktopSettings
            v-if="showSettings"
            @close="showSettings = false"
            @saved="onSettingsSaved"
        />
    </div>
</template>
<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref } from "vue";
    import AgentConsole from "./components/AgentConsole.vue";
    import SessionSidebar from "./components/SessionSidebar.vue";
    import TaskComposer from "./components/TaskComposer.vue";
    import WorkspacePicker from "./components/WorkspacePicker.vue";
    import DesktopSettings from "./components/DesktopSettings.vue";
    import {
        deleteSession,
        extractConversationId,
        getEventSourceUrl,
        getSession,
        getSessionOutput,
        getSessions,
        getStorage,
        runAgent as apiRunAgent,
        stopSession,
    } from "./services/agent-api.js";
    import { applyTheme, persistTheme, resolveInitialTheme } from "./services/theme.js";

    const sessions = ref([]);
    const activeSessionId = ref(null);
    const activeSession = ref(null);
    const output = ref([]);
    const errorMessage = ref("");
    const eventSource = ref(null);
    const workspace = ref("");
    const provider = ref("chatgpt");
    const task = ref("");
    const storage = ref(null);

    // 主题：dark（默认） / light
    const theme = ref(resolveInitialTheme());

    function toggleTheme() {
        theme.value = theme.value === "dark" ? "light" : "dark";
        applyTheme(theme.value);
        persistTheme(theme.value);
    }

    // 用户在 TaskComposer 里输入的“继续已有会话”内容：
    // 既可以是完整的会话 URL，也可以直接是 conversation id。
    const conversationId = ref("");
    const workspaceInput = ref(null);
    const showWorkspacePicker = ref(false);
    const showSettings = ref(false);

    // ------------------------------------------------------------------
    // 输出区 / 输入区 可调节分割
    // ratio 表示输出区（Agent Activity）占据的高度比例，范围 [MIN_RATIO, MAX_RATIO]。
    // 拖动中间的分割条即可动态调节，双击恢复默认，比例会持久化到 localStorage。
    // ------------------------------------------------------------------
    const SPLIT_STORAGE_KEY = "xml-agent:split-ratio";
    const MIN_RATIO = 0.2;
    const MAX_RATIO = 0.85;
    const DEFAULT_RATIO = 0.68;

    const splitArea = ref(null);
    const ratio = ref(DEFAULT_RATIO);
    const resizing = ref(false);

    const ratioPercent = computed(() => Math.round(ratio.value * 100));
    const consoleStyle = computed(() => ({ flex: ratio.value + " 1 0" }));
    const composerStyle = computed(() => ({ flex: 1 - ratio.value + " 1 0" }));

    function clampRatio(value) {
        if (value < MIN_RATIO) {
            return MIN_RATIO;
        }
        if (value > MAX_RATIO) {
            return MAX_RATIO;
        }
        return value;
    }

    function loadRatio() {
        try {
            const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
            if (raw) {
                const parsed = parseFloat(raw);
                if (!isNaN(parsed)) {
                    ratio.value = clampRatio(parsed);
                }
            }
        } catch (error) {
            // localStorage 不可用时忽略，使用默认比例
        }
    }

    function persistRatio() {
        try {
            window.localStorage.setItem(SPLIT_STORAGE_KEY, String(ratio.value));
        } catch (error) {
            // 忽略持久化失败
        }
    }

    function applyPointerRatio(clientY) {
        const el = splitArea.value;
        if (!el) {
            return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0) {
            return;
        }
        const next = (clientY - rect.top) / rect.height;
        ratio.value = clampRatio(next);
    }

    function onPointerMove(event) {
        applyPointerRatio(event.clientY);
    }

    function stopResize() {
        if (!resizing.value) {
            return;
        }
        resizing.value = false;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        persistRatio();
    }

    function startResize(event) {
        if (event.button !== undefined && event.button !== 0) {
            return;
        }
        event.preventDefault();
        resizing.value = true;
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", stopResize);
        window.addEventListener("pointercancel", stopResize);
    }

    function resetRatio() {
        ratio.value = DEFAULT_RATIO;
        persistRatio();
    }

    const isElectron = computed(() => {
        return (
            typeof window !== "undefined" &&
            window.xmlAgentDesktop &&
            window.xmlAgentDesktop.isElectron === true
        );
    });

    const electronPort = computed(() => {
        if (!isElectron.value) {
            return "";
        }
        return String(window.xmlAgentDesktop.port || "");
    });

    const activeConversationId = computed(() => {
        return activeSession.value?.conversationId || "";
    });

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
            interrupted: "Interrupted",
            error: "Error",
        };
        return labels[sessionStatus.value] || sessionStatus.value;
    });

    async function refreshStorage() {
        try {
            storage.value = await getStorage();
        } catch (error) {
            // 存储统计失败不影响主流程，保持上一次的值即可
        }
    }

    async function loadSessions() {
        try {
            const result = await getSessions();
            sessions.value = result.sessions || [];
            if (result.storage) {
                storage.value = result.storage;
            }
            if (activeSessionId.value) {
                const existing = sessions.value.find(
                    (session) => session.id === activeSessionId.value
                );
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
            // 选中已有 session 时，把该 session 的 conversationId 回填到输入框，
            // 便于用户查看或复用；用户也可以手动改掉它去开新的会话。
            conversationId.value = sessionResult.conversationId || "";
            subscribeToSession(sessionId);
        } catch (error) {
            errorMessage.value = error.message;
        }
    }

    function subscribeToSession(sessionId) {
        closeEventSource();
        const source = new EventSource(getEventSourceUrl(sessionId));
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
        source.addEventListener("conversation", (event) => {
            try {
                const info = JSON.parse(event.data);
                if (info && info.conversationId) {
                    if (activeSession.value) {
                        activeSession.value = Object.assign({}, activeSession.value, {
                            conversationId: info.conversationId,
                        });
                        updateSessionList(activeSession.value);
                    }
                    // 同步到输入框，让用户看到当前会话 id
                    conversationId.value = info.conversationId;
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
            // 会话结束后其输出体积可能变化，刷新一次存储占用
            refreshStorage();
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

    /**
把用户在 conversationId 输入框中填写的内容转换为纯粹的 conversation id。
允许用户粘贴完整的会话 URL，或者直接一个 id。
*/
    function normalizeConversationId() {
        const raw = (conversationId.value || "").trim();
        if (!raw) {
            return "";
        }
        const parsed = extractConversationId(provider.value, raw);
        if (parsed) {
            return parsed;
        }
        return raw;
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
            const payload = {
                workspace: workspace.value.trim(),
                provider: provider.value,
                task: task.value.trim(),
            };
            const cid = normalizeConversationId();
            if (cid) {
                payload.conversationId = cid;
            }
            const result = await apiRunAgent(payload);
            activeSessionId.value = result.sessionId;
            await loadSessions();
            await selectSession(result.sessionId);
        } catch (error) {
            errorMessage.value = error.message;
            // 容量超限时立即刷新存储统计，让侧边栏的告警保持最新
            if (error.code === "MAX_SESSIONS" || error.code === "MAX_DISK") {
                refreshStorage();
            }
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

    /**
删除会话（由侧边栏确认后触发）。
删除后：如果是当前激活会话，切到列表中的下一条或进入新会话界面。
*/
    async function deleteSessionById(sessionId) {
        if (!sessionId) {
            return;
        }

        errorMessage.value = "";

        try {
            const result = await deleteSession(sessionId);
            if (result.storage) {
                storage.value = result.storage;
            }
        } catch (error) {
            errorMessage.value = error.message;
            return;
        }

        const wasActive = activeSessionId.value === sessionId;

        sessions.value = sessions.value.filter((session) => session.id !== sessionId);

        if (!wasActive) {
            return;
        }

        closeEventSource();
        activeSessionId.value = null;
        activeSession.value = null;
        output.value = [];

        if (sessions.value.length) {
            await selectSession(sessions.value[0].id);
            return;
        }

        createNewSession();
    }

    function createNewSession() {
        closeEventSource();
        activeSessionId.value = null;
        activeSession.value = null;
        output.value = [];
        errorMessage.value = "";
        task.value = "";
        workspace.value = "";
        conversationId.value = "";
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
        return value.length > 72 ? value.slice(0, 72) + "..." : value;
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

    function openWorkspacePicker() {
        if (running.value) {
            return;
        }
        showWorkspacePicker.value = true;
    }

    function closeWorkspacePicker() {
        showWorkspacePicker.value = false;
    }

    function selectWorkspace(selectedPath) {
        if (!selectedPath) {
            return;
        }
        workspace.value = selectedPath;
        showWorkspacePicker.value = false;
        errorMessage.value = "";
    }

    function onSettingsSaved() {
        // 提示用户新配置已生效。后续新启动的 Agent 会话会使用新的 Chrome 路径。
        errorMessage.value = "";
    }

    onMounted(() => {
        applyTheme(theme.value);
        loadRatio();
        loadSessions();
        refreshStorage();
    });
    onUnmounted(closeEventSource);
    onBeforeUnmount(stopResize);
</script>

<style scoped>
    .workspace-browse-button {
        flex: 0 0 auto;
        white-space: nowrap;
    }
    .workspace-input {
        width: 100%;
    }
    .workspace-input input {
        width: 100%;
    }
    .theme-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .theme-toggle-icon {
        font-size: 13px;
        line-height: 1;
    } /* 输出区 / 输入区 可调节分割布局 */
    .split-area {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        overflow: hidden;
    }
    .console-region {
        display: flex;
        min-height: 120px;
        flex-direction: column;
        overflow: hidden;
    }
    .composer-shell {
        min-height: 140px;
        overflow-y: auto;
    }
    .split-handle {
        position: relative;
        display: flex;
        height: 12px;
        flex: 0 0 12px;
        align-items: center;
        justify-content: center;
        border-top: 1px solid var(--c-border-soft);
        border-bottom: 1px solid var(--c-border-soft);
        background: var(--c-panel-bg);
        cursor: row-resize;
        touch-action: none;
        transition: background 0.14s ease;
    }
    .split-handle:hover,
    .split-area.resizing .split-handle {
        background: var(--c-elevated-bg);
    }
    .split-handle-grip {
        width: 46px;
        height: 3px;
        border-radius: 3px;
        background: var(--c-border-strong);
        transition: background 0.14s ease;
    }
    .split-handle:hover .split-handle-grip,
    .split-area.resizing .split-handle-grip {
        background: var(--c-accent-2);
    }
    .split-handle-pct {
        position: absolute;
        right: 14px;
        color: var(--c-text-faint);
        font-size: 10px;
        letter-spacing: 0.02em;
        pointer-events: none;
        user-select: none;
    }
    .split-area.resizing {
        user-select: none;
    }
</style>
