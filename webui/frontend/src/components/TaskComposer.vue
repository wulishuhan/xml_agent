
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
        <div v-if="images.length || imageError" class="composer-images">
            <div v-if="imageError" class="composer-images-error">{{ imageError }}</div>
            <ul v-if="images.length" class="composer-images-list">
                <li
                    v-for="(image, index) in images"
                    :key="image + '-' + index"
                    class="composer-image-item"
                    :title="image"
                >
                    <span class="composer-image-name">{{ shortName(image) }}</span>
                    <button
                        type="button"
                        class="composer-image-remove"
                        :disabled="running"
                        title="Remove image"
                        @click="removeImage(index)"
                    >
                        ×
                    </button>
                </li>
            </ul>
        </div>
        <div class="composer-footer">
            <span class="composer-shortcut">
                <kbd>Ctrl</kbd> <span>+</span> <kbd>Enter</kbd> <span>to run</span>
            </span>
            <div class="composer-actions">
                <button
                    type="button"
                    class="composer-attach"
                    :disabled="running || uploading"
                    :title="isElectron ? 'Attach images from disk' : 'Upload images to workspace'"
                    @click="attachImages"
                >
                    {{ uploading ? "Uploading..." : "Attach images" }}
                </button>
                <!-- file input 始终渲染：桌面端在原生对话框不可用（例如旧版 Electron）时
                     会降级到 file input + 上传接口，避免用户以为选了图却什么都没发生。 -->
                <input
                    ref="fileInput"
                    type="file"
                    accept="image/*"
                    multiple
                    class="composer-file-input"
                    :disabled="running || uploading"
                    @change="onFilesSelected"
                />
                <button
                    v-if="running"
                    class="btn btn-danger composer-run-button"
                    type="button"
                    @click="$emit('stop')"
                >
                    Stop
                </button>
                <button
                    v-else
                    class="btn btn-primary composer-run-button"
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
    import { extractConversationId, pickImages, uploadWorkspaceImages } from "../services/agent-api.js";
    const props = defineProps({
        task: { type: String, default: "" },
        provider: { type: String, default: "chatgpt" },
        running: { type: Boolean, default: false },
        conversationId: { type: String, default: "" },
        workspace: { type: String, default: "" },
        images: { type: Array, default: () => [] },
    });
    const emit = defineEmits([
        "update:task",
        "update:conversationId",
        "update:images",
        "run",
        "stop",
    ]);
    const input = ref(null);
    const fileInput = ref(null);
    const uploading = ref(false);
    const imageError = ref("");
    const isElectron = computed(() => {
        return (
            typeof window !== "undefined" &&
            window.xmlAgentDesktop &&
            window.xmlAgentDesktop.isElectron === true
        );
    });
    const canRun = computed(() => {
        return props.task.trim().length > 0;
    });
    // 用户可能粘贴完整会话 URL 或纯 conversation id；这里只做轻量提示，
    // 真正的 URL -> id 解析由 provider 端在 Agent 内部负责。
    const conversationIdHint = computed(() => {
        if (!props.conversationId || !props.conversationId.trim()) {
            return "";
        }const parsed = extractConversationId(props.provider, props.conversationId.trim());
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
function shortName(value) {
if (typeof value !== "string") {
return "";
}
const normalized = value.split(String.fromCharCode(92)).join("/");
const parts = normalized.split("/");
return parts[parts.length - 1] || value;
}
function mergeImages(list) {
const next = Array.isArray(props.images) ? props.images.slice() : [];
for (const item of list || []) {
if (typeof item === "string" && item.trim() && next.indexOf(item) === -1) {
next.push(item);
}
if (next.length >= 8) {
break;
}
}
emit("update:images", next);
}
function removeImage(index) {
if (props.running) {
return;
}
const next = (props.images || []).slice();
next.splice(index, 1);
imageError.value = "";
emit("update:images", next);
}
function openFilePicker() {
if (fileInput.value) {
fileInput.value.click();
}
}
async function attachImages() {
if (props.running || uploading.value) {
return;
}
imageError.value = "";
// 桌面端：优先用原生对话框拿绝对路径。
// 若当前 Electron 版本没有 dialog.pickImages（旧版 exe），
// pickImages() 会返回 null，此时降级到 file input + 上传接口，
// 避免"点了按钮什么都没发生"。
if (isElectron.value) {
let picked = null;
try {
picked = await pickImages();
} catch (error) {
imageError.value = error.message;
return;
}
if (picked === null) {
// 原生对话框不可用：降级到 Web 上传方式。
openFilePicker();
return;
}
if (picked.length) {
mergeImages(picked);
}
return;
}
openFilePicker();
}
async function onFilesSelected(event) {
const files = event.target && event.target.files ? event.target.files : null;
// 允许用户连续选择同一文件：处理完立即清空 value。
if (event.target) {
event.target.value = "";
}
if (!files || !files.length) {
return;
}
if (!props.workspace || !props.workspace.trim()) {
imageError.value = "Please set a workspace before uploading images.";
return;
}
uploading.value = true;
imageError.value = "";
try {
const paths = await uploadWorkspaceImages(props.workspace, files);
if (paths && paths.length) {
mergeImages(paths);
}
} catch (error) {
imageError.value = error.message;
} finally {
uploading.value = false;
}
}
defineExpose({ focus });
</script>
<style scoped>
    .composer-conversation-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px 10px;
        border-bottom: 1px solid var(--c-border-soft);
    }
    .composer-conversation-label {
        flex: 0 0 auto;
        color: var(--c-text-muted);
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
        color: var(--c-text);
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 12px;
        outline: none;
    }
    .composer-conversation-input::placeholder {
        color: var(--c-text-faint);
    }
    .composer-conversation-clear {
        flex: 0 0 auto;
        padding: 4px 8px;
        border: 1px solid var(--c-border-strong);
        border-radius: 5px;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .composer-conversation-clear:hover:not(:disabled) {
        border-color: var(--c-accent-2);
        color: var(--c-text-body);
    }
    .composer-conversation-hint {
        padding: 0 12px 8px;
        color: var(--c-text-soft);
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 11px;
        word-break: break-all;
    }
    /* 底部一行：左侧快捷键提示，右侧"附加图片 + Run/Stop"按钮组，垂直居中且等高。 */
    .composer-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px 12px;
    }
    .composer-actions {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
    }
    /* 让"Attach images"与"Run Agent"按钮在高度与对齐上保持一致。 */
    .composer-attach,
    .composer-run-button {
        display: inline-flex;
        min-height: 32px;
        align-items: center;
        justify-content: center;
        padding: 0 14px;
        border-radius: 6px;
        font-size: 12px;
        line-height: 1;
        white-space: nowrap;
    }
    .composer-attach {
        border: 1px solid var(--c-border-strong);
        background: var(--c-btn-bg);
        color: var(--c-text-muted);
        transition:
            color 0.14s ease,
            border-color 0.14s ease,
            background 0.14s ease;
    }
    .composer-attach:hover:not(:disabled) {
        border-color: var(--c-accent-2);
        background: var(--c-btn-hover);
        color: var(--c-text-body);
    }
    .composer-attach:disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }
    .composer-run-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }
    .composer-images {
        padding: 0 12px 8px;
    }
    .composer-images-error {
        margin-bottom: 6px;
        color: #f87171;
        font-size: 11px;
    }
    .composer-images-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .composer-image-item {
        display: inline-flex;
        max-width: 220px;
        align-items: center;
        gap: 6px;
        padding: 3px 6px;
        border: 1px solid var(--c-border-strong);
        border-radius: 5px;
        background: var(--c-elevated-bg);
    }
    .composer-image-name {
        overflow: hidden;
        color: var(--c-text-body);
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .composer-image-remove {
        flex: 0 0 auto;
        padding: 0 4px;
        border: 0;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
    }
    .composer-image-remove:hover:not(:disabled) {
        color: var(--c-danger);
    }
    .composer-file-input {
        display: none;
    }
</style>