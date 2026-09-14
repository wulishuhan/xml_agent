<template>
    <section class="agent-stream">
        <div class="stream-header">
            <div>
                <span class="stream-title">Agent Activity</span>
                <span class="stream-count">{{ output.length }} events</span>
            </div>
            <div class="stream-actions">
                <button
                    v-if="collapsibleCount"
                    class="stream-clear"
                    type="button"
                    @click="toggleAll"
                >
                    {{ allExpanded ? "Collapse all" : "Expand all" }}
                </button>
                <button
                    v-if="output.length"
                    class="stream-clear"
                    type="button"
                    @click="$emit('clear')"
                >
                    Clear
                </button>
            </div>
        </div>
        <div ref="consoleElement" class="stream-body">
            <div v-if="!output.length" class="stream-empty">
                <div class="empty-orb">✦</div>
                <strong>{{
                    session ? "Waiting for agent activity" : "Start a new session"
                }}</strong>
                <span>{{
                    session
                        ? "Agent events, runtime actions and results will appear here."
                        : "Describe your task below and run the agent."
                }}</span>
            </div>
            <article
                v-for="(item, index) in output"
                :key="`${item.timestamp || 0}-${index}`"
                class="event-card"
                :class="[`event-${item.type}`, { 'event-answer': getActionTag(item) === 'answer' }]"
            >
                <div class="event-marker">
                    <span>{{ getIcon(item) }}</span>
                </div>
                <div class="event-content">
                    <div class="event-meta">
                        <span class="event-type">{{ getLabel(item) }}</span>
                        <span v-if="getActionTag(item)" class="event-tag">{{
                            getActionTag(item)
                        }}</span>
                        <span v-if="isCollapsible(item)" class="event-lines"
                            >{{ getLineCount(item) }} lines</span
                        >
                        <time v-if="item.timestamp">{{ formatTime(item.timestamp) }}</time>
                    </div>
                    <div
                        v-if="isCollapsible(item) && !isExpanded(index)"
                        class="event-preview-wrap"
                    >
                        <div class="event-preview">{{ getPreview(item) }}</div>
                    </div>
                    <pre v-else-if="isStructured(item)">{{ getBody(item) }}</pre>
                    <div v-else class="event-text">{{ getBody(item) }}</div>
                    <button
                        v-if="isCollapsible(item)"
                        class="event-toggle"
                        type="button"
                        @click="toggle(index)"
                    >
                        <span class="event-toggle-icon">{{ isExpanded(index) ? "▴" : "▾" }}</span>
                        {{ isExpanded(index) ? "Show less" : "Show more" }}
                    </button>
                </div>
            </article>
        </div>
    </section>
</template>
<script setup>
import { computed, nextTick, ref, watch } from "vue";
const props = defineProps({
    output: { type: Array, default: () => [] },
    session: { type: Object, default: null },
});
defineEmits(["clear"]);
const consoleElement = ref(null);
const expanded = ref(new Set());
const PREVIEW_MAX_CHARS = 220;
const PREVIEW_MAX_LINES = 4;
watch(
    () => props.output.length,
    async () => {
        await nextTick();
        if (!consoleElement.value) {
            return;
        }
        consoleElement.value.scrollTop = consoleElement.value.scrollHeight;
    }
);
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
    if (item.type === "system") return "◆";
    if (item.type === "stderr" || item.type === "error") return "!";
    const tag = getActionTag(item);
    if (tag === "answer") return "★";
    if (tag === "read") return "R";
    if (tag === "write") return "W";
    if (tag === "exec") return "$";
    if (tag === "done") return "■";
    return "›";
}
/*** * 从 agent 事件里取出 XML Action 名（read / write / exec / answer / done）。 * session 记录里 record.event 保存了原始 agent 事件。 */
function getActionTag(item) {
    const event = item.event;
    if (!event) {
        return "";
    }
    if (event.type === "runtime.result" && event.action) {
        return event.action;
    }
    if (event.type === "answer") {
        return "answer";
    }
    if (event.type === "action.parsed" && event.action) {
        return event.action;
    }
    return "";
}
/*** * 实际展示用的正文。 * * answer 的 runtime.result 记录原始内容是 "Runtime action: answer\n{ ...json... }"， * 直接展示既冗长又看不到重点。这里把 result.content 抽出来单独展示， * 让用户在收缩状态下也能直接读到 Agent 的最终回答。 */
function getBody(item) {
    const event = item.event;
    if (
        event &&
        event.type === "runtime.result" &&
        event.result &&
        event.result.action === "answer"
    ) {
        const text = event.result.content;
        if (typeof text === "string" && text.trim()) {
            return text;
        }
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
/*** * 是否可折叠：answer 始终可折叠；其它内容较长或行数较多时也可折叠。 */
function isCollapsible(item) {
    const text = getBody(item);
    if (!text) {
        return false;
    }
    if (getActionTag(item) === "answer") {
        return true;
    }
    if (text.length > PREVIEW_MAX_CHARS) {
        return true;
    }
    if (getLineCount(item) > PREVIEW_MAX_LINES) {
        return true;
    }
    return false;
}
/*** * 收缩时展示的摘要：取前几行 / 前若干字符。 */
function getPreview(item) {
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
        return shown.replace(/\s+$/, "") + " …";
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
const collapsibleIndexes = computed(() => {
    const list = [];
    props.output.forEach((item, index) => {
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
