
<template>
<section class="agent-stream">
<div class="stream-header">
<div>
<span class="stream-title">Agent Activity</span>
<span class="stream-count">{{ output.length }} events</span>
</div>

        <button
            v-if="output.length"
            class="stream-clear"
            type="button"
            @click="$emit('clear')"
        >
            Clear
        </button>
    </div>

    <div ref="consoleElement" class="stream-body">
        <div v-if="!output.length" class="stream-empty">
            <div class="empty-orb">✦</div>
            <strong>{{ session ? "Waiting for agent activity" : "Start a new session" }}</strong>
            <span>
                {{
                    session
                        ? "Agent events, runtime actions and results will appear here."
                        : "Describe your task below and run the agent."
                }}
            </span>
        </div>

        <article
            v-for="(item, index) in output"
            :key="`${item.timestamp || 0}-${index}`"
            class="event-card"
            :class="`event-${item.type}`"
        >
            <div class="event-marker">
                <span>{{ getIcon(item.type) }}</span>
            </div>

            <div class="event-content">
                <div class="event-meta">
                    <span class="event-type">{{ getLabel(item.type) }}</span>
                    <time v-if="item.timestamp">
                        {{ formatTime(item.timestamp) }}
                    </time>
                </div>

                <pre v-if="isStructured(item.content)">{{ item.content }}</pre>
                <div v-else class="event-text">{{ item.content }}</div>
            </div>
        </article>
    </div>
</section>
</template> <script setup> import { nextTick, ref, watch } from "vue"; const props = defineProps({ output: { type: Array, default: () => [], }, session: { type: Object, default: null, }, }); defineEmits(["clear"]); const consoleElement = ref(null); watch( () => props.output.length, async () => { await nextTick(); if (!consoleElement.value) { return; } consoleElement.value.scrollTop = consoleElement.value.scrollHeight; } ); function getLabel(type) { const labels = { system: "System", stdout: "Agent", stderr: "Error", error: "Error", }; return labels[type] || "Event"; } function getIcon(type) { const icons = { system: "◆", stdout: "›", stderr: "!", error: "×", }; return icons[type] || "·"; } function isStructured(content) { if (typeof content !== "string") { return true; } return content.includes("\n{") || content.startsWith("{"); } function formatTime(timestamp) { return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", }); } </script>

