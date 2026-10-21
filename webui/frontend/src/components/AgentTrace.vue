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
                                    ? "Step-by-step trace for each run in this session"
                                    : "Step-by-step actions and runtime results"
                            }}
                        </span>
                    </div>
                </div>
                <div class="trace-header-actions">
                    <button v-if="filteredCount" type="button" class="btn" @click="toggleExpandAll">
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
                    <div class="trace-empty-orb">≡</div>
                    <strong>No trace yet</strong>
                    <span>Run the agent to see each action and runtime result here.</span>
                </div>
                <div v-else class="trace-runs">
                    <div v-for="run in runs" :key="run.runIndex" class="trace-run">
                        <div class="trace-run-head">
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
                        </div>
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
                                            <span
                                                class="trace-event-kind"
                                                :class="eventClass(event)"
                                            >
                                                {{ event.label }}
                                            </span>
                                            <span v-if="event.action" class="trace-event-action"
                                                >action: {{ event.action }}</span
                                            >
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
                                            <span v-if="event.timestamp" class="trace-event-ts">{{
                                                formatTime(event.timestamp)
                                            }}</span>
                                            <button
                                                v-if="event.payload"
                                                type="button"
                                                class="trace-event-toggle"
                                                @click="toggleEvent(run.runIndex, step.step, index)"
                                            >
                                                {{
                                                    isEventExpanded(run.runIndex, step.step, index)
                                                        ? "Hide"
                                                        : "Details"
                                                }}
                                            </button>
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
            <footer class="trace-footer">
                <span class="trace-footer-stat">
                    {{ runs.length }} run(s) · {{ totalSteps }} steps · {{ totalEvents }} events
                </span>
                <button type="button" class="btn" @click="refresh">Refresh</button>
            </footer>
        </section>
    </div>
</template>
<script setup>
    import { computed, onMounted, ref } from "vue";
    import { getSessionOutput } from "../services/agent-api.js";
    const props = defineProps({
        sessionId: { type: String, default: null },
        liveOutput: { type: Array, default: null },
    });
    const emit = defineEmits(["close"]);
    const isLoading = ref(false);
    const errorMessage = ref("");
    const records = ref([]);
    const expanded = ref(new Set());
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
            summary = "Parsed XML action: " + (event.action || "unknown");
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
    /**
按"每次运行"分段：
以 agent.started 事件作为一次运行的起点（resume 会再次触发 agent.started）。

每次运行的 task 从 agent.started 事件中读取，用于区分 Run 1/2/3。

agent.* 生命周期事件记录在 run 级别（runEvents），不进入 step 分组。

step.started 只用于分组，不作为事件展示。
*/
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
                    hasError: false,
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
                    run.hasError = true;
                } else if (built.raw.type === "agent.stopped") {
                    run.status = "stopped";
                }
                if (built.kind === "agent-error") {
                    run.hasError = true;
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

    const runs = computed(() => rebuild());
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
    const filteredCount = computed(() => totalEvents.value);
    function eventClass(event) {
        return "trace-kind-" + event.kind;
    }
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
    const allExpanded = computed(() => {
        const keys = [];
        for (const run of runs.value) {
            for (const step of run.steps) {
                step.events.forEach((event, index) => {
                    if (event.payload) {
                        keys.push(eventKey(run.runIndex, step.step, index));
                    }
                });
            }
        }
        if (!keys.length) {
            return false;
        }
        return keys.every((key) => expanded.value.has(key));
    });
    function toggleExpandAll() {
        if (allExpanded.value) {
            expanded.value = new Set();
            return;
        }
        const next = new Set(expanded.value);
        for (const run of runs.value) {
            for (const step of run.steps) {
                step.events.forEach((event, index) => {
                    if (event.payload) {
                        next.add(eventKey(run.runIndex, step.step, index));
                    }
                });
            }
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
        align-items: center;
        gap: 10px;
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
        gap: 20px;
    }
    .trace-run {
        border: 1px solid var(--c-border-strong);
        border-radius: 12px;
        background: var(--c-card-bg);
        overflow: hidden;
    }
    .trace-run-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: var(--c-elevated-bg);
        border-bottom: 1px solid var(--c-border);
    }
    .trace-run-index {
        color: var(--c-accent-2);
        font-size: 13px;
        font-weight: 700;
        flex: 0 0 auto;
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
        max-width: 40%;
        color: var(--c-text-muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .trace-run-time {
        margin-left: auto;
        color: var(--c-text-faint);
        font-size: 10px;
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
    .trace-event-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
    }
    .trace-event-kind {
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
        max-width: 320px;
        color: var(--c-text-muted);
        font-size: 11px;
        font-family: "Cascadia Code", Consolas, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .trace-event-badge {
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
    .trace-event-time {
        color: var(--c-text-faint);
        font-size: 10px;
    }
    .trace-event-ts {
        margin-left: auto;
        color: var(--c-text-faint);
        font-size: 10px;
    }
    .trace-event-toggle {
        padding: 1px 8px;
        border: 1px solid var(--c-border-input);
        border-radius: 5px;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 10px;
        cursor: pointer;
    }
    .trace-event-toggle:hover {
        background: var(--c-hover-bg);
        color: var(--c-text-strong);
    }
    .trace-event-summary {
        margin-top: 3px;
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
