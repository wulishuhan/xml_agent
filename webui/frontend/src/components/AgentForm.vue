<template>
    <section class="panel">
        <div class="panel-title">
            <span>Agent Configuration</span>
        </div>

        <div class="form-group">
            <label>Workspace</label>

            <input
                v-model="form.workspace"
                type="text"
                placeholder="D:/code/backend/nodejs/xml_agent"
            />
        </div>

        <div class="form-group">
            <label>Provider</label>

            <select v-model="form.provider">
                <option value="chatgpt">ChatGPT</option>

                <option value="qwen">Qwen</option>

                <option value="deepseek">DeepSeek</option>
            </select>
        </div>

        <div class="form-group">
            <label>Task</label>

            <textarea
                v-model="form.task"
                rows="6"
                placeholder="请输入 Agent 要执行的任务..."
            ></textarea>
        </div>

        <div class="actions">
            <button class="btn btn-primary" :disabled="running || !canRun" @click="handleRun">
                ▶ Run Agent
            </button>

            <button class="btn btn-danger" :disabled="!running" @click="$emit('stop')">
                ■ Stop
            </button>

            <button class="btn btn-secondary" :disabled="running" @click="handleClear">
                Clear
            </button>
        </div>
    </section>
</template>

<script setup>
import { reactive, computed } from "vue";

const props = defineProps({
    running: {
        type: Boolean,
        default: false,
    },
});

const emit = defineEmits(["run", "stop", "clear"]);

const form = reactive({
    workspace: "D:/code/backend/nodejs/xml_agent",
    provider: "chatgpt",
    task: "",
});

const canRun = computed(() => {
    return form.workspace.trim() && form.task.trim();
});

function handleRun() {
    emit("run", {
        workspace: form.workspace.trim(),
        provider: form.provider,
        task: form.task.trim(),
    });
}

function handleClear() {
    form.task = "";

    emit("clear");
}
</script>
