<template>
    <section class="agent-stream">
        <div class="stream-header">
            <div>
                <span class="stream-title">Agent Activity</span>
                <span class="stream-count">{{ displayOutput.length }} events</span>
            </div>
            <div class="stream-actions">
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
                        <span v-if="getActionTag(item)" class="event-tag">{{
                            getActionTag(item)
                        }}</span>
                        <span v-if="isCollapsible(item)" class="event-lines"
                            >{{ getLineCount(item) }} lines</span
                        >
                        <time v-if="item.timestamp">{{ formatTime(item.timestamp) }}</time>
                    </div>
                    <template v-if="isAnswerItem(item)">
                        <div
                            v-if="isCollapsible(item) && !isExpanded(index)"
                            class="event-preview-wrap"
                        >
                            <div class="event-preview">{{ getPreview(item) }}</div>
                        </div>
                        <div v-else class="event-answer-body">
                            <div class="answer-row">
                                <span class="answer-key">ok</span>
                                <span class="answer-value">true</span>
                            </div>
                            <div class="answer-row">
                                <span class="answer-key">action</span>
                                <span class="answer-value">answer</span>
                            </div>
                            <div class="answer-row"><span class="answer-key">content</span></div>
                            <pre class="answer-content">{{ getAnswerContent(item) }}</pre>
                        </div> </template
                    ><template v-else>
                        <div
                            v-if="isCollapsible(item) && !isExpanded(index)"
                            class="event-preview-wrap"
                        >
                            <div class="event-preview">{{ getPreview(item) }}</div>
                        </div>
                        <pre v-else-if="isStructured(item)">{{ getBody(item) }}</pre>
                        <div v-else class="event-text">{{ getBody(item) }}</div>
                    </template>

                    <button v-if="isCollapsible(item)" class="event-toggle" @click="toggle(index)">
                        <span class="event-toggle-icon">{{ toggleIcon(index) }}</span>
                        <span>{{ toggleText(index) }}</span>
                    </button>
                </div>
            </article>
            <article v-if="finalAnswerContent" class="event-card event-final-answer">
                <div class="event-marker"><span>+</span></div>
                <div class="event-content">
                    <div class="event-meta">
                        <span class="event-type">Final Answer</span>
                        <span class="event-tag">answer</span>
                    </div>
                    <pre class="final-answer-content">{{ finalAnswerContent }}</pre>
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
const emit = defineEmits(["clear"]);
function emitClear() {
    emit("clear");
}
const consoleElement = ref(null);
const expanded = ref(new Set());
const PREVIEW_MAX_CHARS = 220;
const PREVIEW_MAX_LINES = 4;
const emptyTitle = computed(() =>
    props.session ? "Waiting for agent activity" : "Start a new session"
);
const emptyHint = computed(() =>
    props.session
        ? "Agent events, runtime actions and results will appear here."
        : "Describe your task below and run the agent."
);
const displayOutput = computed(() => {
    return props.output.filter((item) => {
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
});
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
watch(finalAnswerContent, async () => {
    await nextTick();
    if (!consoleElement.value) {
        return;
    }
    consoleElement.value.scrollTop = consoleElement.value.scrollHeight;
});
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
    if (tag === "exec") return "$";
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
function getPreview(item) {
    if (isAnswerItem(item)) {
        const content = getAnswerContent(item) || "";
        const oneLine = content.replace(/\s+/g, " ").trim();
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
        return shown.replace(/\s+$/, "") + " ...";
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
