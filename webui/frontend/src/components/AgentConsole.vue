
<template>
    <section class="agent-stream">
        <div class="stream-header">
            <div>
                <span class="stream-title">Agent Activity</span>
                <span class="stream-count">{{ displayOutput.length }} events</span>
                <span v-if="runCount > 1" class="stream-run-badge">
                    Run {{ runCount }} · current
                </span>
            </div>
            <div class="stream-actions">
                <button
                    v-if="runCount > 1"
                    class="stream-clear"
                    :class="{ active: showAllRuns }"
                    :title="showAllRuns ? 'Show only current run' : 'Show all runs'"
                    @click="toggleAllRuns"
                >
                    {{ showAllRuns ? "Current run" : "All runs" }}
                </button>
                <button v-if="collapsibleCount" class="stream-clear" @click="toggleAll">
                    {{ allExpanded ? "Collapse all" : "Expand all" }}
                </button>
                <button v-if="displayOutput.length" class="stream-clear" @click="emitClear">
                    Clear
                </button>
            </div>
        </div>
        <div ref="consoleElement" class="stream-body">
            <div v-if="displayOutput.length === 0" class="stream-empty">
                <div class="empty-orb">*</div>
                <strong>{{ emptyTitle }}</strong> <span>{{ emptyHint }}</span>
            </div>
            <div v-if="showAllRuns && runCount > 1" class="stream-runs">
                <div v-for="run in runs" :key="run.index" class="stream-run">
                    <div class="stream-run-head">
                        <span class="stream-run-label">Run {{ run.index }}</span>
                        <span v-if="run.isCurrent" class="stream-run-current">current</span>
                    </div>
                    <article
                        v-for="(item, index) in run.items"
                        :key="run.index + '-' + index"
                        class="event-card"
                    >
                        <div class="event-marker">
                            <span>{{ getIcon(item) }}</span>
                        </div>
                        <div class="event-content">
                            <div class="event-meta">
                                <span class="event-type">{{ getLabel(item) }}</span>
                                <span v-if="getActionTag(item)" class="event-tag">
                                    {{ getActionTag(item) }}
                                </span>
                                <time v-if="item.timestamp">{{ formatTime(item.timestamp) }}</time>
                            </div>
                            <pre v-if="isStructured(item)" class="event-text">
{{ getBody(item) }}</pre>
                            <div v-else class="event-text">{{ getBody(item) }}</div>
                        </div>
                    </article>
                </div>
            </div>
            <template v-else>
                <article
                    v-for="(item, index) in displayOutput"
                    v-bind:key="item.timestamp + '-' + index"
                    class="event-card"
                >
                    <div class="event-marker">
                        <span>{{ getIcon(item) }}</span>
                    </div>
                    <div class="event-content">
                        <div class="event-meta">
                            <span class="event-type">{{ getLabel(item) }}</span>
                            <span v-if="getActionTag(item)" class="event-tag">
                                {{ getActionTag(item) }}
                            </span>
                            <span
                                v-if="isCollapsible(item) && !isAnswerItem(item)"
                                class="event-lines"
                                >{{ getLineCount(item) }} lines</span
                            >
                            <time v-if="item.timestamp">{{ formatTime(item.timestamp) }}</time>
                        </div>
                        <template v-if="isAnswerItem(item)">
                            <!-- Answer items are hidden from the main list to avoid duplication -->
                        </template>
                        <template v-else>
                            <div
                                v-if="isCollapsible(item) && !isExpanded(index)"
                                class="event-preview-wrap"
                            >
                                <div class="event-preview">{{ getPreview(item) }}</div>
                            </div>
                            <pre v-else-if="isStructured(item)">{{ getBody(item) }}</pre>
                            <div v-else class="event-text">{{ getBody(item) }}</div>
                            <button
                                v-if="isCollapsible(item) && !isAnswerItem(item)"
                                class="event-toggle"
                                @click="toggle(index)"
                            >
                                <span class="event-toggle-icon">{{ toggleIcon(index) }}</span>
                                <span>{{ toggleText(index) }}</span>
                            </button>
                        </template>
                    </div>
                </article>
                <article v-if="finalAnswer.content" class="event-card event-final-answer">
                    <div class="event-marker"><span>+</span></div>
                    <div class="event-content">
                        <div class="final-answer-card">
                            <div class="event-meta">
                                <span class="event-type">Final Answer</span>
                                <span class="event-tag">answer</span>
                            </div>
                            <div
                                v-if="finalAnswer.html"
                                class="final-answer-content markdown-body"
                                v-html="finalAnswer.html"
                            ></div>
                            <div v-else class="final-answer-content final-answer-plain">
                                {{ finalAnswer.content }}
                            </div>
                        </div>
                    </div>
                </article>
            </template>
        </div>
    </section>
</template>
<script setup>
    import { computed, nextTick, ref, watch } from "vue";
    import { renderMarkdown } from "../services/markdown.mjs";
    const props = defineProps({
        output: { type: Array, default: () => [] },
        session: { type: Object, default: null },
    });
    const emit = defineEmits(["clear"]);
    function emitClear() {
        emit("clear");
    }
    const consoleElement = ref(null);
    const expanded = ref(new Set());
    const showAllRuns = ref(false);
    const PREVIEW_MAX_CHARS = 220;
    const PREVIEW_MAX_LINES = 4;
    function baseFilter(items) {
        return items.filter((item) => {
            const event = item.event;
            if (!event) {
                return true;
            }
            if (event.type === "answer") {
                return false;
            }
            if (event.type === "action.parsed" && event.action === "answer") {
                return false;
            }
            return true;
        });
    }
    const runs = computed(() => {
        const raw = props.output || [];
        const segments = [];
        let current = null;
        for (const item of raw) {
            const event = item && item.event;
            const isStart = event && event.type === "agent.started";
            if (isStart || !current) {
                current = { items: [] };
                segments.push(current);
            }
            current.items.push(item);
        }
        const total = segments.length;
        return segments.map((seg, idx) => ({
            index: idx + 1,
            items: baseFilter(seg.items),
            isCurrent: idx === total - 1,
        }));
    });
    const runCount = computed(() => runs.value.length);
    const displayOutput = computed(() => {
        if (!runs.value.length) {
            return [];
        }
        if (showAllRuns.value) {
            return runs.value.reduce((acc, run) => acc.concat(run.items), []);
        }
        return runs.value[runs.value.length - 1].items;
    });
    const emptyTitle = computed(() =>
        props.session ? "Waiting for agent activity" : "Start a new session"
    );
    const emptyHint = computed(() =>
        props.session
            ? "Agent events, runtime actions and results will appear here."
            : "Describe your task below and run the agent."
    );
    function hasDoneEvent(list) {
        return list.some((item) => {
            const event = item.event;
            return event && event.type === "runtime.result" && event.action === "done";
        });
    }
    function findAnswerContent(list) {
        for (let i = list.length - 1; i >= 0; i--) {
            const event = list[i].event;
            if (
                event &&
                event.type === "runtime.result" &&
                event.action === "answer" &&
                event.result &&
                typeof event.result.content === "string"
            ) {
                return event.result.content;
            }
        }
        return "";
    }
    const finalAnswerContent = computed(() => {
        const list = displayOutput.value;
        if (!hasDoneEvent(list)) {
            return "";
        }
        return findAnswerContent(list);
    });
    const finalAnswer = computed(() => {
        const content = finalAnswerContent.value;
        if (!content) {
            return { content: "", html: "" };
        }
        // 统一使用 renderMarkdown：breaks:true 保留单换行，protectInlineSpaces 保留连续空格。
        // 纯文本（无 markdown 特征）时返回空字符串，回退到 pre-wrap 纯文本显示。
        return { content, html: renderMarkdown(content) };
    });
    watch(
        () => displayOutput.value.length,
        async () => {
            await nextTick();
            if (!consoleElement.value) {
                return;
            }
            consoleElement.value.scrollTop = consoleElement.value.scrollHeight;
        }
    );
    watch(finalAnswer, async () => {
        await nextTick();
        if (!consoleElement.value) {
            return;
        }
        consoleElement.value.scrollTop = consoleElement.value.scrollHeight;
    });
    function toggleAllRuns() {
        showAllRuns.value = !showAllRuns.value;
    }
    function getLabel(item) {
        const type = item.type;
        if (type === "system") return "System";
        if (type === "stderr" || type === "error") return "Error";
        if (type === "stdout") {
            const tag = getActionTag(item);
            if (tag === "answer") return "Answer";
            return "Agent";
        }
        return "Event";
    }
    function getIcon(item) {
        if (item.type === "system") return "#";
        if (item.type === "stderr" || item.type === "error") return "!";
        const tag = getActionTag(item);
        if (tag === "answer") return "*";
        if (tag === "read") return "R";
        if (tag === "write") return "W";
        if (tag === "exec") return ">";
        if (tag === "screenshot") return "P";
        if (tag === "done") return "=";
        return ">";
    }
    function getActionTag(item) {
        const event = item.event;
        if (!event) {
            return "";
        }
        if (event.type === "runtime.result" && event.action) {
            return event.action;
        }
        return "";
    }
    function isAnswerItem(item) {
        return getActionTag(item) === "answer";
    }
    function getAnswerContent(item) {
        const event = item.event;
        if (
            event &&
            event.type === "runtime.result" &&
            event.result &&
            typeof event.result.content === "string"
        ) {
            return event.result.content;
        }
        if (typeof item.content === "string") {
            return item.content;
        }
        return "";
    }
    function getBody(item) {
        const event = item.event;
        if (
            event &&
            event.type === "runtime.result" &&
            event.result &&
            event.result.action === "answer"
        ) {
            return JSON.stringify(event.result, null, 2);
        }
        if (typeof item.content !== "string") {
            return "";
        }
        return item.content;
    }
    function getLineCount(item) {
        const text = getBody(item);
        if (!text) {
            return 0;
        }
        return text.split("\n").length;
    }
    function isCollapsible(item) {
        if (isAnswerItem(item)) {
            return false; // Answer items are handled separately
        }
        const text = getBody(item);
        if (!text) {
            return false;
        }
        if (text.length > PREVIEW_MAX_CHARS) {
            return true;
        }
        if (getLineCount(item) > PREVIEW_MAX_LINES) {
            return true;
        }
        return false;
    }
    function getPreview(item) {
        if (isAnswerItem(item)) {
            const content = getAnswerContent(item) || "";
            const oneLine = content.split("\n").join(" ").replace(/\s+/g, " ").trim();
            if (oneLine.length > PREVIEW_MAX_CHARS) {
                return "answer: " + oneLine.slice(0, PREVIEW_MAX_CHARS) + " ...";
            }
            return "answer: " + oneLine;
        }
        const text = getBody(item);
        if (!text) {
            return "";
        }
        const lines = text.split("\n");
        const head = lines.slice(0, PREVIEW_MAX_LINES).join("\n");
        const truncatedByLine = lines.length > PREVIEW_MAX_LINES;
        const truncatedByChar = head.length > PREVIEW_MAX_CHARS;
        const shown = truncatedByChar ? head.slice(0, PREVIEW_MAX_CHARS) : head;
        if (truncatedByLine || truncatedByChar) {
            // 只替换所有空白用于单行预览；完整内容仍通过展开查看。
            return shown.replace(/\s+/g, " ") + " ...";
        }
        return shown;
    }
    function isStructured(item) {
        const text = getBody(item);
        if (!text) {
            return false;
        }
        return text.includes("\n{") || text.startsWith("{") || text.startsWith("[");
    }
    function isExpanded(index) {
        return expanded.value.has(index);
    }
    function toggle(index) {
        const next = new Set(expanded.value);
        if (next.has(index)) {
            next.delete(index);
        } else {
            next.add(index);
        }
        expanded.value = next;
    }
    function toggleIcon(index) {
        return isExpanded(index) ? "v" : ">";
    }
    function toggleText(index) {
        return isExpanded(index) ? "Show less" : "Show more";
    }
    const collapsibleIndexes = computed(() => {
        const list = [];
        displayOutput.value.forEach((item, index) => {
            if (isCollapsible(item)) {
                list.push(index);
            }
        });
        return list;
    });
    const collapsibleCount = computed(() => collapsibleIndexes.value.length);
    const allExpanded = computed(() => {
        if (!collapsibleIndexes.value.length) {
            return false;
        }
        return collapsibleIndexes.value.every((index) => expanded.value.has(index));
    });
    function toggleAll() {
        if (allExpanded.value) {
            expanded.value = new Set();
            return;
        }
        expanded.value = new Set(collapsibleIndexes.value);
    }
    function formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }
</script>
<style scoped>
    .stream-run-badge {
        margin-left: 8px;
        padding: 1px 8px;
        border-radius: 10px;
        background: var(--c-raised-bg);
        color: var(--c-accent-2);
        font-size: 10px;
        font-weight: 650;
    }
    .stream-clear.active {
        border-color: var(--c-accent-2);
        color: var(--c-text-strong);
    }
    .stream-runs {
        display: flex;
        flex-direction: column;
        gap: 16px;
    }
    .stream-run {
        border: 1px solid var(--c-border-soft);
        border-radius: 10px;
        padding: 8px;
        background: var(--c-panel-bg);
    }
    .stream-run-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 6px 8px;
        border-bottom: 1px solid var(--c-border-soft);
        margin-bottom: 8px;
    }
    .stream-run-label {
        color: var(--c-accent-2);
        font-size: 12px;
        font-weight: 700;
    }
    .stream-run-current {
        padding: 0 6px;
        border-radius: 8px;
        background: var(--c-raised-bg);
        color: var(--c-text-muted);
        font-size: 10px;
    }
</style>
