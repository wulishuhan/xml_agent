<template>
    <section class="panel">
        <div class="status-header">
            <div class="panel-title">Agent Status</div>

            <span class="status-badge" :class="statusClass">
                {{ statusText }}
            </span>
        </div>

        <div class="status-grid">
            <div class="status-item">
                <span class="label">Status</span>
                <span>{{ status }}</span>
            </div>

            <div class="status-item">
                <span class="label">Provider</span>
                <span>{{ provider || "-" }}</span>
            </div>

            <div class="status-item">
                <span class="label">PID</span>
                <span>{{ pid || "-" }}</span>
            </div>

            <div class="status-item">
                <span class="label">Output</span>
                <span>{{ outputLength }}</span>
            </div>
        </div>
    </section>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
    status: {
        type: String,
        default: "created",
    },

    provider: {
        type: String,
        default: "",
    },

    pid: {
        type: [Number, String],
        default: null,
    },

    outputLength: {
        type: Number,
        default: 0,
    },
});

const statusClass = computed(() => {
    return `status-${props.status}`;
});

const statusText = computed(() => {
    const map = {
        created: "Created",
        running: "Running",
        completed: "Completed",
        error: "Error",
        stopped: "Stopped",
    };

    return map[props.status] || props.status;
});
</script>
