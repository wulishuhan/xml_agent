<template>
    <section class="composer">
        <div class="composer-header">
            <div>
                <span class="composer-label">Task</span>
                <span class="composer-hint">
                    Describe what the agent should do in this workspace
                </span>
            </div>
            <span class="composer-provider">{{ provider }}</span>
        </div>
        <div class="composer-conversation-row">
            <label class="composer-conversation-label" for="conversation-input">
                Continue from conversation (optional)
            </label>
            <input
                id="conversation-input"
                class="composer-conversation-input"
                type="text"
                :disabled="running"
                :value="conversationId"
                placeholder="Paste an existing conversation URL or id to keep memory in sync"
                @input="$emit('update:conversationId', $event.target.value)"
            />
            <button
                v-if="conversationId"
                type="button"
                class="composer-conversation-clear"
                :disabled="running"
                @click="$emit('update:conversationId', '')"
            >
                Clear
            </button>
        </div>
        <div v-if="conversationIdHint" class="composer-conversation-hint">
            {{ conversationIdHint }}
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
                <kbd>Ctrl</kbd> <span>+</span> <kbd>Enter</kbd> <span>to run</span>
            </span>
            <div class="composer-actions">
                <button v-if="running" class="btn btn-danger" type="button" @click="$emit('stop')">
                    Stop
                </button>
                <button
                    v-else
                    class="btn btn-primary run-button"
                    type="button"
                    :disabled="!canRun"
                    @click="submit"
                >
                    Run Agent
                </button>
            </div>
        </div>
    </section>
</template>
<script setup>
import { computed, ref } from "vue";
import { extractConversationId } from "../services/agent-api.js";
const props = defineProps({
    task: { type: String, default: "" },
    provider: { type: String, default: "chatgpt" },
    running: { type: Boolean, default: false },
    conversationId: { type: String, default: "" },
});
const emit = defineEmits(["update:task", "update:conversationId", "run", "stop"]);
const input = ref(null);
const canRun = computed(() => {
    return props.task.trim().length > 0;
});
/** * 用户可能粘贴： * - 完整的会话 URL，例如 https://chat.deepseek.com/a/chat/s/<uuid> * - 只粘贴 conversation id，例如 9efa4714-... * - 什么都不填（新会话） * * 这里只做轻量提示，真正的 URL -> id 解析由 provider 端在 Agent 内部负责。 */ const conversationIdHint =
    computed(() => {
        if (!props.conversationId || !props.conversationId.trim()) {
            return "";
        }
        const parsed = extractConversationId(props.provider, props.conversationId.trim());
        if (parsed) {
            return "Will continue conversation: " + parsed;
        }
        return "Will continue conversation: " + props.conversationId.trim();
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
<style scoped>
.composer-conversation-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 10px;
    border-bottom: 1px solid #1d2732;
}
.composer-conversation-label {
    flex: 0 0 auto;
    color: #67788a;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}
.composer-conversation-input {
    flex: 1;
    min-width: 0;
    padding: 5px 0;
    border: 0;
    background: transparent;
    color: #d7dee7;
    font-family: "Cascadia Code", Consolas, monospace;
    font-size: 12px;
    outline: none;
}
.composer-conversation-input::placeholder {
    color: #576678;
}
.composer-conversation-clear {
    flex: 0 0 auto;
    padding: 4px 8px;
    border: 1px solid #303b49;
    border-radius: 5px;
    background: transparent;
    color: #8895a6;
    font-size: 11px;
}
.composer-conversation-clear:hover:not(:disabled) {
    border-color: #48586c;
    color: #aeb9c7;
}
.composer-conversation-hint {
    padding: 0 12px 8px;
    color: #6f8095;
    font-family: "Cascadia Code", Consolas, monospace;
    font-size: 11px;
    word-break: break-all;
}
</style>
