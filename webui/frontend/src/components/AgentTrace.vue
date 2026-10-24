<template>
    <div class="trace-mask" @click.self="$emit('close')">
        <section class="trace-panel" role="dialog" aria-modal="true" aria-labelledby="trace-title">
            <header class="trace-header">
                <div class="trace-heading">
                    <div class="trace-icon">≡</div>
                    <div>
                        <strong id="trace-title">Agent Reply Trace</strong>
                        <span>
                            {{
                                sessionId
                                    ? "Click a run to expand its steps and results"
                                    : "Step-by-step actions and runtime results"
                            }}
                        </span>
                    </div>
                </div>
                <div class="trace-header-actions">
                    <div class="trace-search">
                        <span class="trace-search-icon" aria-hidden="true">⌕</span>
                        <input
                            v-model="searchQuery"
                            type="search"
                            class="trace-search-input"
                            placeholder="Search trace (action, path, command, error...)"
                            aria-label="Search trace"
                            @keydown.esc="clearSearch"
                        />
                        <span v-if="normalizedQuery" class="trace-search-count">
                            {{ matchCount }} hit(s)
                        </span>
                        <button
                            v-if="searchQuery"
                            type="button"
                            class="trace-search-clear"
                            aria-label="Clear search"
                            @click="clearSearch"
                        >
                            ×
                        </button>
                    </div>
                    <button v-if="runs.length" type="button" class="btn" @click="toggleExpandAll">
                        {{ allExpanded ? "Collapse all" : "Expand all" }}
                    </button>
                    <button
                        class="icon-button"
                        type="button"
                        aria-label="Close"
                        @click="$emit('close')"
                    >
                        ×
                    </button>
                </div>
            </header>
            <div v-if="isLoading" class="trace-loading">Loading trace...</div>
            <div v-else class="trace-body">
                <div v-if="errorMessage" class="trace-error">{{ errorMessage }}</div>
                <div v-if="!runs.length" class="trace-empty">
                    <template v-if="normalizedQuery">
                        <div class="trace-empty-orb">⌕</div>
                        <strong>No match</strong>
                        <span>No trace event matches "{{ searchQuery.trim() }}".</span>
                        <button type="button" class="btn" @click="clearSearch">Clear search</button>
                    </template>
                    <template v-else>
                        <div class="trace-empty-orb">≡</div>
                        <strong>No trace yet</strong>
                        <span>Run the agent to see each action and runtime result here.</span>
                    </template>
                </div>
                <div v-else class="trace-runs">
                    <div
                        v-for="run in runs"
                        :key="run.runIndex"
                        class="trace-run"
                        :class="{ collapsed: !isRunExpanded(run.runIndex) }"
                    >
                        <button
                            type="button"
                            class="trace-run-head"
                            :aria-expanded="isRunExpanded(run.runIndex)"
                            @click="toggleRun(run.runIndex)"
                        >
                            <span class="trace-run-chevron">{{
                                isRunExpanded(run.runIndex) ? "▾" : "▸"
                            }}</span>
                            <span class="trace-run-index">Run {{ run.runIndex }}</span>
                            <span v-if="run.task" class="trace-run-task" :title="run.task">{{
                                run.task
                            }}</span>
                            <span v-else class="trace-run-task trace-run-task-empty"
                                >(no task captured)</span
                            >
                            <span class="trace-run-summary">{{ run.summary }}</span>
                            <span v-if="run.startTimestamp" class="trace-run-time">{{
                                formatTime(run.startTimestamp)
                            }}</span>
                        </button>
                        <div v-if="isRunExpanded(run.runIndex)" class="trace-run-body">
                            <div v-if="run.runEvents.length" class="trace-run-events">
                                <div
                                    v-for="(event, index) in run.runEvents"
                                    :key="'r' + index"
                                    class="trace-run-event"
                                    :class="eventClass(event)"
                                >
                                    <span class="trace-run-event-kind">{{ event.label }}</span>
                                    <span v-if="event.summary" class="trace-run-event-summary">{{
                                        event.summary
                                    }}</span>
                                </div>
                            </div>
                            <div class="trace-timeline">
                                <div v-for="step in run.steps" :key="step.step" class="trace-step">
                                    <div class="trace-step-head">
                                        <span class="trace-step-index">Step {{ step.step }}</span>
                                        <span class="trace-step-summary">{{ step.summary }}</span>
                                    </div>
                                    <ul class="trace-events">
                                        <li
                                            v-for="(event, index) in step.events"
                                            :key="index"
                                            class="trace-event"
                                            :class="'trace-event-' + event.kind"
                                        >
                                            <div class="trace-event-head">
                                                <span class="trace-event-main">
                                                    <span
                                                        class="trace-event-kind"
                                                        :class="eventClass(event)"
                                                    >
                                                        {{ event.label }}
                                                    </span>
                                                    <span
                                                        v-if="event.action"
                                                        class="trace-event-action"
                                                        >action: {{ event.action }}</span
                                                    >
                                                </span>
                                                <span class="trace-event-side">
                                                    <span
                                                        v-if="event.ok === false"
                                                        class="trace-event-badge trace-event-badge-error"
                                                        >failed</span
                                                    >
                                                    <span
                                                        v-else-if="event.ok === true"
                                                        class="trace-event-badge trace-event-badge-ok"
                                                        >ok</span
                                                    >
                                                    <span
                                                        v-if="event.timestamp"
                                                        class="trace-event-ts"
                                                        >{{ formatTime(event.timestamp) }}</span
                                                    >
                                                    <button
                                                        v-if="event.payload"
                                                        type="button"
                                                        class="trace-event-toggle"
                                                        @click.stop="
                                                            toggleEvent(
                                                                run.runIndex,
                                                                step.step,
                                                                index
                                                            )
                                                        "
                                                    >
                                                        {{
                                                            isEventExpanded(
                                                                run.runIndex,
                                                                step.step,
                                                                index
                                                            )
                                                                ? "Hide"
                                                                : "Details"
                                                        }}
                                                    </button>
                                                </span>
                                            </div>
                                            <div v-if="event.summary" class="trace-event-summary">
                                                {{ event.summary }}
                                            </div>
                                            <pre
                                                v-if="
                                                    event.payload &&
                                                    isEventExpanded(run.runIndex, step.step, index)
                                                "
                                                class="trace-event-payload"
                                                >{{ event.payload }}</pre
                                            >
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <footer class="trace-footer">
                <span class="trace-footer-stat">
                    {{ runs.length }} run(s) · {{ totalSteps }} steps · {{ totalEvents }} events
                    <template v-if="normalizedQuery">
                        · filtered by "{{ searchQuery.trim() }}"</template
                    >
                </span>
                <button type="button" class="btn" @click="refresh">Refresh</button>
            </footer>
        </section>
    </div>
</template>
<script setup>
    import { computed, onMounted, ref, watch } from "vue";
    import { getSessionOutput } from "../services/agent-api.js";
    const props = defineProps({
        sessionId: { type: String, default: null },
        liveOutput: { type: Array, default: null },
    });
    defineEmits(["close"]);
    const isLoading = ref(false);
    const errorMessage = ref("");
    const records = ref([]);
    // 事件 payload 展开状态：runIndex:step:index
    const expanded = ref(new Set());
    // Run 折叠状态：默认全部折叠，只有显式展开的 runIndex 才会出现在集合里
    const expandedRuns = ref(new Set());
    // trace 搜索关键字
    const searchQuery = ref("");
    const normalizedQuery = computed(() => searchQuery.value.trim().toLowerCase());
    function clearSearch() {
        searchQuery.value = "";
    }
    function eventCategory(event) {
        if (!event || !event.type) {
            return "other";
        }
        const type = event.type;
        if (type === "action.parsed") return "action";
        if (type === "action.parse_error") return "action-error";
        if (type === "runtime.result") return "runtime";
        if (type === "provider.request") return "request";
        if (type === "provider.response") return "response";
        if (type === "provider.error" || type === "provider.retry") return "provider-error";
        if (type === "provider.starting" || type === "provider.started") return "provider";
        if (type === "provider.closed" || type === "provider.close_error") return "provider";
        if (type === "agent.started") return "agent";
        if (type === "agent.completed") return "agent";
        if (type === "agent.stopped") return "agent";
        if (type === "agent.error") return "agent-error";
        if (type === "step.started") return "step";
        return "other";
    }
    function eventLabel(event) {
        if (!event || !event.type) {
            return "Event";
        }
        const map = {
            "action.parsed": "Action parsed",
            "action.parse_error": "Action parse error",
            "runtime.result": "Runtime result",
            "provider.request": "Provider request",
            "provider.response": "Provider response",
            "provider.error": "Provider error",
            "provider.retry": "Provider retry",
            "provider.starting": "Provider starting",
            "provider.started": "Provider started",
            "provider.closed": "Provider closed",
            "provider.close_error": "Provider close error",
            "agent.started": "Agent started",
            "agent.completed": "Agent completed",
            "agent.stopped": "Agent stopped",
            "agent.error": "Agent error",
            "step.started": "Step started",
        };
        return map[event.type] || event.type;
    }
    /**
给动作对象生成可读摘要，例如：
read  -> path: package.json
write -> path: src/a.js
exec  -> command: npm test
answer -> content: xxx
*/
    function describeParsedAction(parsed) {
        if (!parsed || typeof parsed !== "object") {
            return "";
        }
        if (typeof parsed.path === "string" && parsed.path) {
            return "path: " + parsed.path;
        }
        if (typeof parsed.command === "string" && parsed.command) {
            return "command: " + parsed.command;
        }
        if (typeof parsed.content === "string" && parsed.content) {
            const flat = parsed.content.split("\n").join(" ").replace(/\s+/g, " ").trim();
            return "content: " + (flat.length > 80 ? flat.slice(0, 80) + "..." : flat);
        }
        return "";
    }
    function buildEvent(record) {
        const event = record && record.event ? record.event : null;
        if (!event || !event.type) {
            return null;
        }
        const kind = eventCategory(event);
        const stepNumber = typeof event.step === "number" ? event.step : null;
        let summary = "";
        let action = "";
        let ok;
        let payload = "";
        if (event.type === "action.parsed") {
            action = event.action || "";
            const detail = describeParsedAction(event.parsed);
            summary =
                "Parsed XML action: " +
                (event.action || "unknown") +
                (detail ? " · " + detail : "");
            if (event.parsed && typeof event.parsed === "object") {
                payload = JSON.stringify(event.parsed, null, 2);
            }
        } else if (event.type === "action.parse_error") {
            summary = "Failed to parse action: " + (event.error || "");
            payload = event.error || "";
        } else if (event.type === "runtime.result") {
            action = event.action || "";
            if (event.result && typeof event.result === "object") {
                ok = event.result.ok;
                if (event.result.action === "answer" && event.result.content) {
                    summary = "Answer produced";
                } else if (event.result.ok === false) {
                    summary = "Runtime error: " + (event.result.error || "unknown");
                } else {
                    summary = "Runtime ok: " + (event.result.action || "");
                }
                payload = JSON.stringify(event.result, null, 2);
            }
        } else if (event.type === "provider.request") {
            summary = "Sending request to provider (step " + (event.step || "?") + ")";
        } else if (event.type === "provider.response") {
            summary = "Provider response received (" + (event.length || 0) + " chars)";
        } else if (event.type === "provider.retry") {
            summary =
                "Retry " +
                (event.count || "?") +
                "/" +
                (event.max || "?") +
                ": " +
                (event.error || "");
            payload = JSON.stringify(event, null, 2);
        } else if (event.type === "provider.error") {
            summary =
                "Provider error " +
                (event.count || "?") +
                "/" +
                (event.max || "?") +
                ": " +
                (event.error || "");
            payload = JSON.stringify(event, null, 2);
        } else if (event.type === "agent.started") {
            summary =
                "Workspace: " + (event.workspace || "") + " · provider: " + (event.provider || "");
        } else if (event.type === "agent.completed") {
            summary = "Finished: " + (event.status || "unknown");
        } else if (event.type === "agent.stopped") {
            summary = "Stopped by user";
        } else if (event.type === "agent.error") {
            summary = "Agent error: " + (event.error || "");
            payload = JSON.stringify(event, null, 2);
        } else if (event.type === "step.started") {
            summary = "Step " + (event.step || "?") + " started";
        } else {
            summary = event.type;
        }
        return {
            kind,
            label: eventLabel(event),
            action,
            ok,
            summary,
            payload,
            timestamp: event.timestamp || null,
            step: stepNumber,
            raw: event,
        };
    }
    function oneLine(text) {
        return String(text || "")
            .split("\n")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    }
    function makeTaskSummary(task) {
        const line = oneLine(task);
        if (!line) {
            return "";
        }
        return line.length > 90 ? line.slice(0, 90) + "..." : line;
    }
    function rebuild() {
        const source =
            props.liveOutput && props.liveOutput.length ? props.liveOutput : records.value;
        const runs = [];
        let currentRun = null;
        let syntheticStep = 0;
        function ensureRun() {
            if (!currentRun) {
                currentRun = {
                    runIndex: runs.length + 1,
                    steps: [],
                    stepMap: new Map(),
                    runEvents: [],
                    startTimestamp: null,
                    task: "",
                    status: "in progress",
                    answerCount: 0,
                };
                runs.push(currentRun);
            }
            return currentRun;
        }
        for (const record of source || []) {
            const built = buildEvent(record);
            if (!built) {
                continue;
            }
            if (built.kind === "agent" && built.raw.type === "agent.started") {
                currentRun = null;
                const run = ensureRun();
                run.startTimestamp = built.timestamp;
                run.task = makeTaskSummary(built.raw.task);
                run.runEvents.push(built);
                continue;
            }
            const run = ensureRun();
            if (built.kind === "agent" || built.kind === "agent-error") {
                run.runEvents.push(built);
                if (built.raw.type === "agent.completed") {
                    run.status = built.raw.status || "completed";
                } else if (built.raw.type === "agent.error") {
                    run.status = "error";
                } else if (built.raw.type === "agent.stopped") {
                    run.status = "stopped";
                }
                continue;
            }
            if (built.kind === "step") {
                continue;
            }
            if (built.kind === "runtime" && built.action === "answer") {
                run.answerCount += 1;
            }
            let stepKey = built.step;
            if (stepKey === null) {
                syntheticStep += 1;
                stepKey = syntheticStep;
            }
            if (!run.stepMap.has(stepKey)) {
                const step = { step: stepKey, events: [] };
                run.stepMap.set(stepKey, step);
                run.steps.push(step);
            }
            run.stepMap.get(stepKey).events.push(built);
        }
        for (const run of runs) {
            run.steps = run.steps
                .filter((step) => step.events.length > 0)
                .sort((a, b) => a.step - b.step);
            for (const step of run.steps) {
                const actionEvent = step.events.find((e) => e.kind === "action");
                const runtimeEvent = step.events.find((e) => e.kind === "runtime");
                const parts = [];
                if (actionEvent && actionEvent.action) {
                    parts.push(actionEvent.action);
                }
                if (runtimeEvent) {
                    if (runtimeEvent.ok === false) {
                        parts.push("failed");
                    } else if (runtimeEvent.action === "answer") {
                        parts.push("answer");
                    } else if (runtimeEvent.action) {
                        parts.push(runtimeEvent.action + " ok");
                    }
                }
                step.summary = parts.join(" · ") || "in progress";
            }
            const summaryParts = [];
            if (run.answerCount > 0) {
                summaryParts.push(run.answerCount + " answer(s)");
            }
            summaryParts.push(run.status);
            run.summary = summaryParts.join(" · ");
        }
        return runs.filter((run) => run.steps.length > 0 || run.runEvents.length > 0);
    }
    const allRuns = computed(() => rebuild());
    // ---- 搜索过滤 ----
    function matchesQuery(text) {
        if (!normalizedQuery.value) {
            return true;
        }
        return String(text === null || text === undefined ? "" : text)
            .toLowerCase()
            .includes(normalizedQuery.value);
    }
    function eventMatchesQuery(event) {
        if (!normalizedQuery.value) {
            return true;
        }
        return (
            matchesQuery(event.label) ||
            matchesQuery(event.action) ||
            matchesQuery(event.summary) ||
            matchesQuery(event.payload)
        );
    }
    function filterRuns(sourceRuns) {
        if (!normalizedQuery.value) {
            return sourceRuns;
        }
        const result = [];
        for (const run of sourceRuns) {
            // 任务描述命中时保留整条 Run，方便看完整上下文
            if (matchesQuery(run.task)) {
                result.push(run);
                continue;
            }
            const runEvents = run.runEvents.filter(eventMatchesQuery);
            const steps = [];
            for (const step of run.steps) {
                const events = step.events.filter(eventMatchesQuery);
                if (events.length) {
                    steps.push({ ...step, events });
                }
            }
            if (runEvents.length || steps.length) {
                result.push({ ...run, runEvents, steps });
            }
        }
        return result;
    }
    const runs = computed(() => filterRuns(allRuns.value));
    const matchCount = computed(() => {
        if (!normalizedQuery.value) {
            return 0;
        }
        let count = 0;
        for (const run of allRuns.value) {
            for (const event of run.runEvents) {
                if (eventMatchesQuery(event)) {
                    count += 1;
                }
            }
            for (const step of run.steps) {
                for (const event of step.events) {
                    if (eventMatchesQuery(event)) {
                        count += 1;
                    }
                }
            }
        }
        return count;
    });
    const totalSteps = computed(() => runs.value.reduce((sum, run) => sum + run.steps.length, 0));
    const totalEvents = computed(() =>
        runs.value.reduce(
            (sum, run) =>
                sum +
                run.runEvents.length +
                run.steps.reduce((stepSum, step) => stepSum + step.events.length, 0),
            0
        )
    );
    function eventClass(event) {
        return "trace-kind-" + event.kind;
    }
    // ---- Run 折叠 ----
    function isRunExpanded(runIndex) {
        return expandedRuns.value.has(runIndex);
    }
    // 搜索词变化时收拢所有 Run：避免多个匹配 Run 全部展开难以排查
    watch(normalizedQuery, () => {
        expandedRuns.value = new Set();
    });
    function toggleRun(runIndex) {
        const next = new Set(expandedRuns.value);
        if (next.has(runIndex)) {
            next.delete(runIndex);
        } else {
            next.add(runIndex);
        }
        expandedRuns.value = next;
    }
    const allExpanded = computed(() => {
        if (!runs.value.length) {
            return false;
        }
        return runs.value.every((run) => expandedRuns.value.has(run.runIndex));
    });
    function toggleExpandAll() {
        if (allExpanded.value) {
            expandedRuns.value = new Set();
            return;
        }
        expandedRuns.value = new Set(runs.value.map((run) => run.runIndex));
    }
    // ---- 事件 payload 展开 ----
    function eventKey(runIndex, step, index) {
        return runIndex + ":" + step + ":" + index;
    }
    function isEventExpanded(runIndex, step, index) {
        return expanded.value.has(eventKey(runIndex, step, index));
    }
    function toggleEvent(runIndex, step, index) {
        const key = eventKey(runIndex, step, index);
        const next = new Set(expanded.value);
        if (next.has(key)) {
            next.delete(key);
        } else {
            next.add(key);
        }
        expanded.value = next;
    }
    async function loadFromServer() {
        if (!props.sessionId) {
            isLoading.value = false;
            return;
        }
        isLoading.value = true;
        errorMessage.value = "";
        try {
            const result = await getSessionOutput(props.sessionId);
            records.value = result.output || [];
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            isLoading.value = false;
        }
    }
    async function refresh() {
        await loadFromServer();
    }
    function formatTime(timestamp) {
        if (!timestamp) {
            return "";
        }
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) {
            return "";
        }
        return date.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }
    onMounted(() => {
        if (props.liveOutput && props.liveOutput.length) {
            isLoading.value = false;
            return;
        }
        loadFromServer();
    });
</script>
<style scoped>
    .trace-mask {
        position: fixed;
        z-index: 1160;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--c-backdrop);
        backdrop-filter: blur(5px);
    }
    .trace-panel {
        display: flex;
        width: min(980px, 100%);
        height: min(780px, calc(100vh - 48px));
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--c-border-strong);
        border-radius: 14px;
        background: var(--c-card-bg);
        box-shadow:
            0 24px 70px var(--c-shadow-strong),
            0 0 0 1px rgb(255 255 255 / 2%);
    }
    .trace-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--c-border);
        background: var(--c-elevated-bg);
    }
    .trace-heading {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 12px;
    }
    .trace-icon {
        display: grid;
        width: 38px;
        height: 38px;
        flex: 0 0 38px;
        place-items: center;
        border: 1px solid var(--c-border-strong);
        border-radius: 9px;
        background: var(--c-raised-bg);
        font-size: 18px;
    }
    .trace-heading strong {
        display: block;
        color: var(--c-text-strong);
        font-size: 14px;
        font-weight: 650;
    }
    .trace-heading span {
        display: block;
        margin-top: 3px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .trace-header-actions {
        display: flex;
        flex: 1;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
    }
    /* ---- Trace 搜索框 ---- */
    .trace-search {
        display: flex;
        flex: 0 1 320px;
        min-width: 180px;
        align-items: center;
        gap: 6px;
        padding: 0 8px;
        border: 1px solid var(--c-border-input);
        border-radius: 8px;
        background: var(--c-input-bg);
        transition: border-color 0.14s ease;
    }
    .trace-search:focus-within {
        border-color: var(--c-accent-2);
    }
    .trace-search-icon {
        flex: 0 0 auto;
        color: var(--c-text-faint);
        font-size: 12px;
    }
    .trace-search-input {
        width: 100%;
        min-width: 0;
        padding: 6px 0;
        border: 0;
        background: transparent;
        color: var(--c-text-strong);
        font-size: 12px;
        outline: none;
    }
    .trace-search-input::placeholder {
        color: var(--c-text-faint);
    }
    .trace-search-count {
        flex: 0 0 auto;
        color: var(--c-text-muted);
        font-size: 10px;
        white-space: nowrap;
    }
    .trace-search-clear {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
    }
    .trace-search-clear:hover {
        background: var(--c-hover-bg);
        color: var(--c-text-strong);
    }
    .trace-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 14px 18px;
    }
    .trace-loading {
        padding: 32px;
        color: var(--c-text-muted);
        text-align: center;
    }
    .trace-error {
        margin-bottom: 12px;
        padding: 8px 10px;
        border: 1px solid #7f1d1d;
        border-radius: 8px;
        background: rgb(127 29 29 / 22%);
        color: #fca5a5;
        font-size: 12px;
    }
    .trace-empty {
        display: flex;
        height: 100%;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--c-text-muted);
        text-align: center;
    }
    .trace-empty-orb {
        font-size: 30px;
        opacity: 0.6;
    }
    .trace-empty strong {
        color: var(--c-text-strong);
    }
    .trace-runs {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .trace-run {
        border: 1px solid var(--c-border-strong);
        border-radius: 10px;
        background: var(--c-card-bg);
        overflow: hidden;
    }
    .trace-run-head {
        display: flex;
        width: 100%;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border: 0;
        background: var(--c-elevated-bg);
        color: inherit;
        text-align: left;
        cursor: pointer;
        transition: background 0.14s ease;
    }
    .trace-run-head:hover {
        background: var(--c-hover-bg);
    }
    .trace-run.collapsed .trace-run-head {
        border-bottom: 0;
    }
    .trace-run-chevron {
        flex: 0 0 auto;
        color: var(--c-text-muted);
        font-size: 11px;
        line-height: 1;
    }
    .trace-run-index {
        flex: 0 0 auto;
        color: var(--c-accent-2);
        font-size: 13px;
        font-weight: 700;
    }
    .trace-run-task {
        overflow: hidden;
        flex: 1;
        min-width: 0;
        color: var(--c-text-strong);
        font-size: 12px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .trace-run-task-empty {
        color: var(--c-text-faint);
        font-weight: 400;
    }
    .trace-run-summary {
        overflow: hidden;
        flex: 0 0 auto;
        max-width: 30%;
        color: var(--c-text-muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .trace-run-time {
        flex: 0 0 auto;
        margin-left: auto;
        color: var(--c-text-faint);
        font-size: 10px;
    }
    .trace-run-body {
        border-top: 1px solid var(--c-border);
    }
    .trace-run-events {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 8px 14px;
        border-bottom: 1px dashed var(--c-border-soft);
    }
    .trace-run-event {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
    }
    .trace-run-event-kind {
        font-weight: 650;
    }
    .trace-run-event-summary {
        overflow: hidden;
        max-width: 320px;
        color: var(--c-text-muted);
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .trace-timeline {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
    }
    .trace-step {
        border: 1px solid var(--c-border-soft);
        border-radius: 10px;
        background: var(--c-panel-bg);
        overflow: hidden;
    }
    .trace-step-head {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--c-border-soft);
        background: var(--c-elevated-bg);
    }
    .trace-step-index {
        color: var(--c-accent-2);
        font-size: 12px;
        font-weight: 700;
    }
    .trace-step-summary {
        overflow: hidden;
        color: var(--c-text-muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .trace-events {
        margin: 0;
        padding: 4px 0;
        list-style: none;
    }
    .trace-event {
        padding: 6px 12px;
        border-left: 3px solid transparent;
    }
    .trace-event + .trace-event {
        border-top: 1px dashed var(--c-border-soft);
    }
    /* 事件头：左侧（类型 + action）与右侧（徽标 + 时间 + Details）两端对齐 */
    .trace-event-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 22px;
    }
    .trace-event-main {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        overflow: hidden;
    }
    .trace-event-side {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
        margin-left: auto;
    }
    .trace-event-kind {
        flex: 0 0 auto;
        font-size: 11px;
        font-weight: 650;
    }
    .trace-kind-action {
        color: #60a5fa;
    }
    .trace-kind-action-error {
        color: #f87171;
    }
    .trace-kind-runtime {
        color: #a78bfa;
    }
    .trace-kind-request {
        color: #38bdf8;
    }
    .trace-kind-response {
        color: #34d399;
    }
    .trace-kind-provider-error {
        color: #f87171;
    }
    .trace-kind-provider {
        color: var(--c-text-muted);
    }
    .trace-kind-agent {
        color: #fbbf24;
    }
    .trace-kind-agent-error {
        color: #f87171;
    }
    .trace-event-action {
        overflow: hidden;
        min-width: 0;
        color: var(--c-text-muted);
        font-size: 11px;
        font-family: "Cascadia Code", Consolas, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .trace-event-badge {
        flex: 0 0 auto;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 650;
    }
    .trace-event-badge-ok {
        background: rgb(52 211 153 / 15%);
        color: #34d399;
    }
    .trace-event-badge-error {
        background: rgb(248 113 113 / 15%);
        color: #f87171;
    }
    .trace-event-ts {
        flex: 0 0 auto;
        color: var(--c-text-faint);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
    }
    .trace-event-toggle {
        flex: 0 0 auto;
        min-width: 54px;
        padding: 1px 8px;
        border: 1px solid var(--c-border-input);
        border-radius: 5px;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 10px;
        text-align: center;
        cursor: pointer;
    }
    .trace-event-toggle:hover {
        background: var(--c-hover-bg);
        color: var(--c-text-strong);
    }
    .trace-event-summary {
        margin-top: 3px;
        padding-left: 0;
        color: var(--c-text-body);
        font-size: 12px;
        line-height: 1.5;
        word-break: break-word;
    }
    .trace-event-payload {
        margin: 6px 0 0;
        padding: 8px 10px;
        max-height: 320px;
        overflow: auto;
        border: 1px solid var(--c-border-soft);
        border-radius: 6px;
        background: var(--c-input-bg);
        color: var(--c-code);
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 11px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
    }
    .trace-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 18px;
        border-top: 1px solid var(--c-border-soft);
        background: var(--c-panel-bg);
    }
    .trace-footer-stat {
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .icon-button {
        width: 32px;
        height: 32px;
        border: 1px solid var(--c-border-strong);
        border-radius: 8px;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
    }
    .icon-button:hover {
        background: var(--c-hover-bg);
    }
</style>
