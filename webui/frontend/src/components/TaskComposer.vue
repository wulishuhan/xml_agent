<template>
    <section class="composer">
        <div class="composer-header">
            <div>
                <span class="composer-label">Task</span>
                <span class="composer-hint"
                    >Describe what the agent should do in this workspace</span
                >
            </div>

            <span class="composer-provider">{{ provider }}</span>
        </div>

        <textarea
            ref="input"
            :value="task"
            :disabled="running"
            rows="4"
            placeholder="Ask the agent to inspect, modify, test, or explain your project..."
            @input="$emit('update:task', $event.target.value)"
            @keydown.enter.ctrl="submit"
            @keydown.enter.meta="submit"
        ></textarea>

        <div class="composer-footer">
            <span class="composer-shortcut">
                <kbd>Ctrl</kbd>
                <span>+</span>
                <kbd>Enter</kbd>
                <span>to run</span>
            </span>

            <div class="composer-actions">
                <button v-if="running" class="btn btn-danger" type="button" @click="$emit('stop')">
                    ■ Stop
                </button>

                <button
                    v-else
                    class="btn btn-primary run-button"
                    type="button"
                    :disabled="!canRun"
                    @click="submit"
                >
                    ▶ Run Agent
                </button>
            </div>
        </div>
    </section>
</template>
<script setup>
import { computed, ref } from "vue";
const props = defineProps({
    task: { type: String, default: "" },
    provider: { type: String, default: "chatgpt" },
    running: { type: Boolean, default: false },
});
const emit = defineEmits(["update:task", "run", "stop"]);
const input = ref(null);
const canRun = computed(() => {
    return props.task.trim().length > 0;
});
function submit() {
    if (props.running || !canRun.value) {
        return;
    }
    emit("run");
}
function focus() {
    input.value?.focus();
}
defineExpose({ focus });
</script>
