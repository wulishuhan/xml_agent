<template>
    <div class="app-shell">
        <SessionSidebar
            :workspaces="workspaces"
            :active-id="activeSessionId"
            :storage="storage"
            @select="selectSession"
            @new-session="createPlaceholderSessionInWorkspace"
            @delete="deleteSessionById"
            @new-workspace="openWorkspacePicker"
            @toggle-workspace="toggleWorkspace"
        />
        <main class="workspace-view">
            <header class="workspace-header">
                <div class="workspace-heading">
                    <div class="workspace-icon">⌘</div>
                    <div class="workspace-heading-text">
                        <div class="workspace-title" :title="workspaceTitle">
                            {{ workspaceTitle }}
                        </div>
                        <div class="workspace-path" :title="workspace">
                            {{ workspace || t("app.selectWorkspaceHint") }}
                        </div>
                    </div>
                </div>
                <div class="workspace-actions">
                    <select v-model="provider" :disabled="running">
                        <option v-for="item in providerOptions" :key="item.id" :value="item.id">
                            {{ item.label }}
                        </option>
                    </select>
                    <span class="status-badge" :class="'status-' + sessionStatus">
                        {{ statusText }}
                    </span>
                    <button
                        type="button"
                        class="btn"
                        :title="t('app.traceTitle')"
                        :disabled="!activeSessionId"
                        @click="showTrace = true"
                    >
                        {{ t("app.trace") }}
                    </button>
                    <button
                        type="button"
                        class="btn"
                        :title="t('app.historyTitle')"
                        @click="showHistory = true"
                    >
                        {{ t("app.history") }}
                    </button>
                    <button
                        type="button"
                        class="btn"
                        :title="t('app.pluginsTitle')"
                        @click="showPlugins = true"
                    >
                        {{ t("app.plugins") }}
                    </button>
                    <button
                        type="button"
                        class="btn"
                        :title="t('app.skillsTitle')"
                        @click="showSkills = true"
                    >
                        {{ t("app.skills") }}
                    </button>
                    <button
                        type="button"
                        class="btn theme-toggle"
                        :title="theme === 'dark' ? t('app.themeToLight') : t('app.themeToDark')"
                        :aria-label="
                            theme === 'dark' ? t('app.themeToLight') : t('app.themeToDark')
                        "
                        @click="toggleTheme"
                    >
                        <span class="theme-toggle-icon">{{ theme === "dark" ? "☾" : "☀" }}</span>
                        <span class="theme-toggle-label">{{
                            theme === "dark" ? t("app.themeDarkLabel") : t("app.themeLightLabel")
                        }}</span>
                    </button>
                    <button
                        type="button"
                        class="btn lang-toggle"
                        :title="t('app.langTitle')"
                        :aria-label="t('app.langTitle')"
                        @click="toggleLang"
                    >
                        <span class="lang-toggle-icon" aria-hidden="true">文</span>
                        <span class="lang-toggle-label">{{ t("app.langSwitchTo") }}</span>
                    </button>
                    <button
                        type="button"
                        class="btn"
                        :title="isElectron ? t('app.settingsTitle') : t('app.browserSettingsTitle')"
                        @click="showSettings = true"
                    >
                        {{ isElectron ? t("app.settings") : t("app.browserSettings") }}
                    </button>
                </div>
            </header>
            <section class="workspace-body">
                <div v-if="activeSession" class="session-context">
                    <div class="context-item">
                        <span class="context-label">{{ t("app.workspace") }}</span>
                        <code>{{ activeSession.workspace }}</code>
                    </div>
                    <div class="context-item">
                        <span class="context-label">{{ t("app.provider") }}</span>
                        <span>{{ activeSession.provider }}</span>
                    </div>
                    <div class="context-item">
                        <span class="context-label">{{ t("app.session") }}</span>
                        <code>{{ shortId(activeSession.id) }}</code>
                    </div>
                    <div v-if="activeConversationId" class="context-item">
                        <span class="context-label">{{ t("app.conversation") }}</span>
                        <code :title="activeConversationId">{{
                            shortId(activeConversationId)
                        }}</code>
                    </div>
                    <div v-if="isElectron" class="context-item">
                        <span class="context-label">{{ t("app.port") }}</span>
                        <code>{{ electronPort }}</code>
                    </div>
                    <!--
                        手动转移入口：横幅只在 80%/92% 才出现，但用户可能只用了两成
                        就想换条线（拆任务、换个 provider、把这条线先放着）。所以这里常驻
                        一个百分比 + 一个入口，任何时候都能转。
                    -->
                    <div v-if="activeSession" class="context-item context-usage-item">
                        <span class="context-label">{{ t("context.usageLabel") }}</span>
                        <span
                            class="context-usage"
                            :class="'context-usage-' + contextLevel"
                            :title="t('context.usageHint')"
                            >{{ contextPercent }}%</span
                        >
                        <div class="context-transfer">
                            <button
                                type="button"
                                class="btn context-transfer-btn"
                                :disabled="transferring"
                                :title="t('context.manualTitle')"
                                @click.stop="toggleTransferMenu"
                            >
                                {{ transferring ? t("context.transferring") : t("context.manual") }}
                                <span class="context-transfer-caret" aria-hidden="true">▾</span>
                            </button>
                            <div v-if="transferMenuOpen" class="transfer-menu" @click.stop>
                                <div class="transfer-menu-title">
                                    {{ t("context.manualTitle") }}
                                </div>
                                <!-- 手动点菜单不该悄悄停掉正在跑的任务，先说清楚 -->
                                <div v-if="running" class="transfer-menu-hint">
                                    {{ t("context.manualRunning") }}
                                </div>
                                <button
                                    type="button"
                                    class="transfer-menu-item"
                                    @click="transferToNewSession('digest')"
                                >
                                    <strong>{{ t("context.manualDigest") }}</strong>
                                    <span>{{ t("context.manualDigestBody") }}</span>
                                </button>
                                <button
                                    type="button"
                                    class="transfer-menu-item"
                                    @click="transferToNewSession('records')"
                                >
                                    <strong>{{ t("context.manualRecords") }}</strong>
                                    <span>{{ t("context.manualRecordsBody") }}</span>
                                </button>
                                <button
                                    type="button"
                                    class="transfer-menu-cancel"
                                    @click="closeTransferMenu"
                                >
                                    {{ t("context.manualCancel") }}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- 上下文快满：提示把记忆转到新会话 -->
                <div
                    v-if="showContextBanner"
                    class="context-banner"
                    :class="'context-banner-' + contextUsage.level"
                >
                    <div class="context-banner-text">
                        <strong>{{ t("context.bannerTitle", { percent: contextPercent }) }}</strong>
                        <span>
                            {{
                                t("context.bannerBody", {
                                    used: formatTokens(contextUsage.used),
                                    limit: formatTokens(contextUsage.limit),
                                })
                            }}
                        </span>
                    </div>
                    <div class="context-banner-actions">
                        <button
                            type="button"
                            class="btn btn-primary"
                            :disabled="transferring"
                            @click="transferToNewSession"
                        >
                            {{ contextActionLabel }}
                        </button>
                        <button
                            type="button"
                            class="btn"
                            :disabled="transferring"
                            @click="dismissContextBanner"
                        >
                            {{ t("context.later") }}
                        </button>
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
                            <strong>{{ t("app.agentError") }}</strong>
                            <span>{{ errorMessage }}</span>
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
                        <TaskComposer
                            v-model:task="task"
                            v-model:conversationId="conversationId"
                            v-model:images="images"
                            v-model:execScope="execScope"
                            :provider="provider"
                            :running="running"
                            :workspace="workspace"
                            :session-id="activeSessionId"
                            @run="runAgent"
                            @stop="stopAgent"
                        />
                    </div>
                </div>
            </section>
        </main>
        <WorkspacePicker
            v-if="showWorkspacePicker"
            @select="handleWorkspaceSelected"
            @close="closeWorkspacePicker"
        />
        <DesktopSettings
            v-if="showSettings"
            @close="showSettings = false"
            @saved="onSettingsSaved"
        />
        <AnswerHistory
            v-if="showHistory"
            :initial-session-id="activeSessionId"
            @close="showHistory = false"
        />
        <AgentTrace
            v-if="showTrace"
            :session-id="activeSessionId"
            :live-output="output"
            @close="showTrace = false"
        />
        <PluginsPanel v-if="showPlugins" @close="showPlugins = false" />
        <SkillsPanel v-if="showSkills" :workspace="workspace" @close="showSkills = false" />
    </div>
</template>
<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref } from "vue";
    import AgentConsole from "./components/AgentConsole.vue";
    import SessionSidebar from "./components/SessionSidebar.vue";
    import TaskComposer from "./components/TaskComposer.vue";
    import WorkspacePicker from "./components/WorkspacePicker.vue";
    import DesktopSettings from "./components/DesktopSettings.vue";
    import AnswerHistory from "./components/AnswerHistory.vue";
    import AgentTrace from "./components/AgentTrace.vue";
    import PluginsPanel from "./components/PluginsPanel.vue";
    import SkillsPanel from "./components/SkillsPanel.vue";
    import {
        createPlaceholderSession,
        deleteSession,
        extractConversationId,
        getEventSourceUrl,
        getSession,
        getSessionOutput,
        getWorkspaces,
        getStorage,
        loadProviders,
        runAgent as apiRunAgent,
        stopSession,
        transferMemory,
    } from "./services/agent-api.js";
    import { applyTheme, persistTheme, resolveInitialTheme } from "./services/theme.js";
    import { t, toggleLang } from "./services/i18n.js";
    import { notifyTaskCompleted } from "./services/desktop-notify.js";
    const workspaces = ref([]);
    const activeSessionId = ref(null);
    const activeSession = ref(null);
    const output = ref([]);
    const errorMessage = ref("");
    const eventSource = ref(null);
    const workspace = ref("");
    const provider = ref("chatgpt");
    // provider 列表来自 /api/providers（含插件 provider）；接口异常时用内置表兜底，
    // 因此新增 provider 不需要再改这个文件。
    const FALLBACK_PROVIDER_OPTIONS = [
        { id: "chatgpt", label: "ChatGPT" },
        { id: "qwen", label: "Qwen" },
        { id: "deepseek", label: "DeepSeek" },
        { id: "glm", label: "GLM" },
        { id: "gemini", label: "Gemini" },
    ];
    const providerOptions = ref(FALLBACK_PROVIDER_OPTIONS.slice());
    const task = ref("");
    // 用户随任务附带的图片：桌面端为本地绝对路径，Web 端为 workspace 下相对路径。
    const images = ref([]);
    // 每个会话各自保留一份「还没发出去的图片」。
    // 之前切换会话直接清空，用户去看一眼别的会话再回来，图片就没了且没有任何提示。
    // key 是会话 id，值是路径数组；图片路径是相对 workspace 的，而会话与 workspace 绑定，
    // 所以按会话 id 存不会串味。
    const imageDrafts = new Map();
    // exec 权限控制：workspace 限制在当前工作区，all 无限制
    const execScope = ref("workspace");
    const storage = ref(null);
    const theme = ref(resolveInitialTheme());
    function toggleTheme() {
        theme.value = theme.value === "dark" ? "light" : "dark";
        applyTheme(theme.value);
        persistTheme(theme.value);
    }
    const conversationId = ref("");
    const showWorkspacePicker = ref(false);
    const showSettings = ref(false);
    const showHistory = ref(false);
    const showTrace = ref(false);
    const showPlugins = ref(false);
    const showSkills = ref(false);
    // ---- 上下文预算提醒 ----
    // 会话在 provider 那边用掉了多少窗口，来自 SSE 的 context 事件（服务端在跨阈值时推）
    const contextUsage = ref(null);
    // 用户点过「稍后」的会话 id：同一会话不再重复打扰，切换会话后重新生效
    const contextDismissed = ref("");
    const transferring = ref(false);
    const contextPercent = computed(() => {
        return contextUsage.value ? Math.round(contextUsage.value.ratio * 100) : 0;
    });
    const showContextBanner = computed(() => {
        const usage = contextUsage.value;
        if (!usage || !activeSessionId.value || usage.level === "normal") {
            return false;
        }
        return contextDismissed.value !== activeSessionId.value;
    });
    // 常驻百分比用的档位：还没采到数时按 normal 上色，别一上来就变红
    const contextLevel = computed(() => (contextUsage.value ? contextUsage.value.level : "normal"));
    // 手动转移菜单：与横幅无关，任何占用比例都能打开
    const transferMenuOpen = ref(false);
    function toggleTransferMenu() {
        if (transferring.value) {
            return;
        }
        transferMenuOpen.value = !transferMenuOpen.value;
    }
    function closeTransferMenu() {
        transferMenuOpen.value = false;
    }
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
        } catch (error) {}
    }
    function persistRatio() {
        try {
            window.localStorage.setItem(SPLIT_STORAGE_KEY, String(ratio.value));
        } catch (error) {}
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
    const workspaceTitle = computed(() => {
        if (!activeSession.value) {
            return t("app.newAgentSession");
        }
        const taskValue = (activeSession.value.task || "").trim();
        return taskValue ? sessionTitle(activeSession.value) : t("app.newSession");
    });
    const statusText = computed(() => {
        const labels = {
            created: t("app.status.created"),
            running: t("app.status.running"),
            completed: t("app.status.completed"),
            stopped: t("app.status.stopped"),
            interrupted: t("app.status.interrupted"),
            error: t("app.status.error"),
        };
        return labels[sessionStatus.value] || sessionStatus.value;
    });
    // 运行中要先停才能转移（transfer 拒绝运行中的会话），按钮文案要如实反映这一点
    const contextActionLabel = computed(() => {
        if (transferring.value) {
            return t("context.transferring");
        }
        return running.value ? t("context.transferStop") : t("context.transfer");
    });
    async function refreshStorage() {
        try {
            storage.value = await getStorage();
        } catch (error) {}
    }
    async function loadWorkspaces() {
        try {
            const result = await getWorkspaces();
            // 恢复每个工作区的展开状态
            const expandedSet = new Set(
                workspaces.value.filter((ws) => ws.expanded).map((ws) => ws.path)
            );
            workspaces.value = (result.workspaces || []).map((ws) => ({
                ...ws,
                expanded: expandedSet.has(ws.path),
            }));
            if (result.storage) {
                storage.value = result.storage;
            }
            // 如果有活跃会话，确保其所在工作区被展开
            if (activeSessionId.value) {
                const activeWs = workspaces.value.find((ws) =>
                    ws.sessions.some((s) => s.id === activeSessionId.value)
                );
                if (activeWs) {
                    activeWs.expanded = true;
                }
            }
        } catch (error) {
            errorMessage.value = error.message;
        }
    }
    /**
    上下文快满时的一键转移。
    源会话还在跑就先停：transfer 会拒绝运行中的会话，而「快满了」的时候
    往往正是它还在跑。停完再转，用户只需要点一次。

    mode 由调用方给：横幅走 digest（只带摘要）；手动入口可以选 digest 或 records。
    两种都不接旧的 provider 线程 —— 换会话的目的就是换一条干净的线程。
    */
    async function transferToNewSession(mode = "digest") {
        const sessionId = activeSessionId.value;
        if (!sessionId || transferring.value) {
            return;
        }
        closeTransferMenu();
        transferring.value = true;
        errorMessage.value = "";
        try {
            if (activeSession.value && activeSession.value.running === true) {
                await stopSession(sessionId);
            }
            // digest：只把 task 和一页摘要带过去，不搬旧的几千条记录。
            // 上下文满了的场景下旧记录本来就是把窗口塞满的元凶，搬过去毫无意义；
            // 模型需要的是"做过什么、改过哪些文件、还差什么"，也就是摘要本身。
            // records：手动转移时用户可能确实要把流水账带过去，由摘要换成全量记录。
            const payload = await transferMemory(sessionId, { mode });
            if (!payload || payload.ok === false) {
                throw new Error((payload && payload.error) || t("context.transferFailed"));
            }
            const targetId = payload.result && payload.result.to;
            await loadWorkspaces();
            if (targetId) {
                // 目标会话是全新的空壳，不会自动开始运行：用户在那里点运行即可。
                // 任务已被回填到输入框，切过去就能看到，不再额外弹提示。
                await selectSession(targetId);
            }
        } catch (error) {
            // 转移的实现放在 memory-transfer 插件里，插件被禁用时给一句人话
            errorMessage.value =
                error && error.code === "PLUGIN_DISABLED"
                    ? t("context.pluginDisabled")
                    : (error && error.message) || t("context.transferFailed");
        } finally {
            transferring.value = false;
        }
    }
    function dismissContextBanner() {
        contextDismissed.value = activeSessionId.value || "";
    }
    /** token 数按 K/M 缩写：横幅里不该出现七位数字。 */
    function formatTokens(value) {
        const number = Number(value) || 0;
        if (number >= 1000000) {
            return (number / 1000000).toFixed(1) + "M";
        }
        if (number >= 1000) {
            return Math.round(number / 1000) + "K";
        }
        return String(number);
    }
    async function selectSession(sessionId) {
        if (!sessionId) {
            return;
        }
        const previousId = activeSessionId.value;
        activeSessionId.value = sessionId;
        errorMessage.value = "";
        // 切换会话时把没发出去的图片寄存到原会话，并取回目标会话的那份。
        // 直接清空的旧做法会让「看一眼别的会话」变成丢图，且没有任何提示。
        if (previousId && previousId !== sessionId) {
            if (images.value.length) {
                imageDrafts.set(previousId, images.value.slice());
            } else {
                imageDrafts.delete(previousId);
            }
        }
        const draft = imageDrafts.get(sessionId);
        images.value = draft ? draft.slice() : [];
        // 上下文占用与「稍后」都是按会话计的，跟着切换一起重置
        contextUsage.value = null;
        contextDismissed.value = "";
        closeTransferMenu();
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
            // 只有尚未运行过的会话才把 task 回填到输入框；已运行过的会话保持为空，
            // 避免用户看到上一次已经执行过的任务还以为没有提交。
            // 例外：记忆转移刚生成的目标会话 —— 它有记录但没真跑过，task 里还要
            // 写给模型看的「先 read 摘要」提示，空着的话用户点运行会被拦下。
            const transferred = (outputResult.output || []).some(
                (record) => record && record.id === "memory-transfer-note"
            );
            const hasRunBefore =
                !!sessionResult.conversationId ||
                (sessionResult.runCount || 0) > 0 ||
                (sessionResult.outputLength || 0) > 0;
            task.value = transferred || !hasRunBefore ? sessionResult.task || "" : "";
            conversationId.value = sessionResult.conversationId || "";
            subscribeToSession(sessionId);
        } catch (error) {
            errorMessage.value = error.message;
            // 打不开就当这次切换没发生：退回到上一个会话，别让界面停在一个
            // 不存在的 id 上（左侧却还留着这条会话），顺带把列表重新对一次。
            if (previousId && previousId !== sessionId) {
                activeSessionId.value = previousId;
                subscribeToSession(previousId);
                loadWorkspaces();
            }
        }
    }
    function subscribeToSession(sessionId) {
        closeEventSource();
        const source = new EventSource(getEventSourceUrl(sessionId));
        // 记录本次订阅期间是否真的观察到了 running 状态。
        // 只有从 running -> completed 的转变才发送"任务完成"通知，
        // 避免打开一个已完成的历史会话时（服务端会立即重放 finished）误弹通知。
        let sawRunning = false;
        if (activeSession.value && activeSession.value.running === true) {
            sawRunning = true;
        }
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
                    }
                    conversationId.value = info.conversationId;
                }
            } catch (error) {
                errorMessage.value = error.message;
            }
        });
        source.addEventListener("context", (event) => {
            try {
                const usage = JSON.parse(event.data);
                if (usage && typeof usage.ratio === "number") {
                    contextUsage.value = usage;
                }
            } catch (error) {
                errorMessage.value = error.message;
            }
        });
        source.addEventListener("finished", (event) => {
            let finishedInfo = null;
            try {
                finishedInfo = JSON.parse(event.data);
                activeSession.value = finishedInfo;
            } catch (error) {
                errorMessage.value = error.message;
            }
            // 任务结束后清空任务输入框，避免下一次误以为任务还没提交。
            // 只在"真的跑过"（runCount > 0）时清：服务端在连接建立时会重放一次
            // finished，转移生成的会话 runCount 还是 0，那条重放会把刚回填的接手任务抹掉。
            if (
                finishedInfo &&
                finishedInfo.status !== "running" &&
                (finishedInfo.runCount || 0) > 0
            ) {
                task.value = "";
            }
            refreshStorage();
            loadWorkspaces();
            // 仅在本次订阅期间确实处于过 running 状态、且最终状态为 completed 时通知。
            if (sawRunning && finishedInfo) {
                notifyTaskCompleted(finishedInfo);
            }
            sawRunning = false;
        });
        source.addEventListener("error", (event) => {
            if (event.data) {
                try {
                    const result = JSON.parse(event.data);
                    errorMessage.value = result.message || t("app.agentError");
                } catch {
                    errorMessage.value = "Agent event stream error";
                }
            }
        });
        eventSource.value = source;
    }
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
            errorMessage.value = t("app.error.noWorkspace");
            return;
        }
        if (!task.value.trim()) {
            errorMessage.value = t("app.error.noTask");
            return;
        }
        errorMessage.value = "";
        try {
            const payload = {
                workspace: workspace.value.trim(),
                provider: provider.value,
                task: task.value.trim(),
                sessionId: activeSessionId.value, // 传入当前占位会话 ID
            };
            const cid = normalizeConversationId();
            if (cid) {
                payload.conversationId = cid;
            }
            // 只提交图片路径；真正的上传由 Agent 在 provider 启动后执行。
            if (images.value.length) {
                payload.images = images.value.slice();
            }
            // 传递 execScope 权限控制
            if (execScope.value) {
                payload.execScope = execScope.value;
            }
            const result = await apiRunAgent(payload);
            activeSessionId.value = result.sessionId;
            // 启动后图片已交给本次运行，清空避免下次重复上传。
            // 对应会话的草稿也要一起清掉，否则切回来又冒出上一次的图。
            images.value = [];
            imageDrafts.delete(result.sessionId);
            await loadWorkspaces();
            await selectSession(result.sessionId);
        } catch (error) {
            errorMessage.value = error.message;
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
            await loadWorkspaces();
        } catch (error) {
            errorMessage.value = error.message;
        }
    }
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
        if (!wasActive) {
            await loadWorkspaces();
            return;
        }
        closeEventSource();
        activeSessionId.value = null;
        activeSession.value = null;
        output.value = [];
        await loadWorkspaces();
        // 如果删除的是当前会话，不自动创建新会话，让用户选择
    }
    // 点击工作区旁的"+"时，创建占位会话并切换到该会话
    async function createPlaceholderSessionInWorkspace(workspacePath) {
        try {
            const result = await createPlaceholderSession(workspacePath, provider.value);
            // 设置工作区路径
            workspace.value = workspacePath;
            // 切换到新创建的占位会话
            await selectSession(result.sessionId);
            nextTick(() => {
                focusTask();
            });
        } catch (error) {
            errorMessage.value = error.message;
            if (error.code === "MAX_SESSIONS" || error.code === "MAX_DISK") {
                refreshStorage();
            }
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
        conversationId.value = "";
        images.value = [];
        execScope.value = "workspace";
        provider.value = providerOptions.value.length ? providerOptions.value[0].id : "chatgpt";
    }
    function clearConsole() {
        output.value = [];
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
        const textarea = document.querySelector(".composer textarea");
        textarea?.focus();
    }
    function openWorkspacePicker() {
        showWorkspacePicker.value = true;
    }
    function closeWorkspacePicker() {
        showWorkspacePicker.value = false;
    }
    // 处理 WorkspacePicker 选择后的逻辑：立即创建占位会话
    async function handleWorkspaceSelected(selectedPath) {
        closeWorkspacePicker();
        try {
            // 立即创建占位会话
            const result = await createPlaceholderSession(selectedPath, provider.value);
            // 设置工作区路径
            workspace.value = selectedPath;
            // 切换到新创建的占位会话
            await selectSession(result.sessionId);
            nextTick(() => {
                focusTask();
            });
        } catch (error) {
            errorMessage.value = error.message;
            if (error.code === "MAX_SESSIONS" || error.code === "MAX_DISK") {
                refreshStorage();
            }
        }
    }
    function toggleWorkspace(ws) {
        ws.expanded = !ws.expanded;
    }
    function onSettingsSaved() {
        errorMessage.value = "";
    }
    onMounted(() => {
        applyTheme(theme.value);
        loadRatio();
        loadWorkspaces();
        refreshStorage();
        // 点空白处收起转移菜单；触发按钮自己 stop 了冒泡，不会被这次监听关掉
        document.addEventListener("click", closeTransferMenu);
        // provider 列表（含插件 provider）由后端提供，失败时保持内置兜底表
        loadProviders().then((list) => {
            if (!Array.isArray(list) || list.length === 0) {
                return;
            }
            providerOptions.value = list.map((item) => ({
                id: item.id,
                label: item.label || item.id,
            }));
            const known = providerOptions.value.some((item) => item.id === provider.value);
            if (!known) {
                provider.value = providerOptions.value[0].id;
            }
        });
    });
    onUnmounted(() => {
        document.removeEventListener("click", closeTransferMenu);
        closeEventSource();
    });
    onBeforeUnmount(stopResize);
</script>
<style scoped>
    .theme-toggle,
    .lang-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .theme-toggle-icon,
    .lang-toggle-icon {
        font-size: 13px;
        line-height: 1;
    }
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
