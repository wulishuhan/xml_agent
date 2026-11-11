<template>
    <section
        class="composer"
        :class="{ 'composer-drop-active': dragActive }"
        @dragover.prevent="onDragOver"
        @dragleave="onDragLeave"
        @drop.prevent="onDrop"
    >
        <div class="composer-header">
            <div>
                <span class="composer-label">{{ t("composer.task") }}</span>
                <span class="composer-hint">
                    {{ t("composer.hint") }}
                </span>
            </div>
            <span class="composer-provider">{{ provider }}</span>
        </div>
        <div class="composer-conversation-row">
            <label class="composer-conversation-label" for="conversation-input">
                {{ t("composer.continueLabel") }}
            </label>
            <input
                id="conversation-input"
                class="composer-conversation-input"
                type="text"
                :disabled="running"
                :value="conversationId"
                :placeholder="t('composer.continuePlaceholder')"
                @input="$emit('update:conversationId', $event.target.value)"
            />
            <button
                v-if="conversationId"
                type="button"
                class="composer-conversation-clear"
                :disabled="running"
                @click="$emit('update:conversationId', '')"
            >
                {{ t("composer.clear") }}
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
            :placeholder="t('composer.placeholder')"
            @input="$emit('update:task', $event.target.value)"
            @keydown.enter.ctrl="submit"
            @keydown.enter.meta="submit"
            @paste="onPaste"
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
                    <img
                        v-if="thumbFor(image)"
                        class="composer-image-thumb"
                        :src="thumbFor(image)"
                        :alt="displayName(image)"
                        :title="t('composer.previewImage')"
                        @click="previewImage(image)"
                    />
                    <span v-else class="composer-image-placeholder" aria-hidden="true">🖼</span>
                    <span class="composer-image-name">{{ displayName(image) }}</span>
                    <button
                        type="button"
                        class="composer-image-remove"
                        :disabled="running"
                        :title="t('composer.removeImage')"
                        @click="removeImage(index)"
                    >
                        ×
                    </button>
                </li>
            </ul>
        </div>
        <div class="composer-footer">
            <span class="composer-shortcut">
                <kbd>Ctrl</kbd> <span>+</span> <kbd>Enter</kbd>
                <span>{{ t("composer.shortcutRun") }}</span>
            </span>
            <div class="composer-actions">
                <button
                    type="button"
                    class="composer-attach"
                    :disabled="running || uploading"
                    :title="isElectron ? t('composer.attachFromDisk') : t('composer.attachUpload')"
                    @click="attachImages"
                >
                    {{ uploading ? t("composer.uploading") : t("composer.attach") }}
                </button>
                <!-- file input 始终渲染：桌面端在原生对话框不可用（例如旧版 Electron）时
                     会降级到 file input + 上传接口，避免用户以为选了图却什么都没发生。 -->
                <input
                    ref="fileInput"
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp,.gif,.bmp"
                    multiple
                    class="composer-file-input"
                    :disabled="running || uploading"
                    @change="onFilesSelected"
                />
                <!-- 权限控制下拉按钮 -->
                <div class="composer-permission-dropdown">
                    <button
                        type="button"
                        class="composer-permission-btn"
                        :class="{
                            'permission-workspace': execScope === 'workspace',
                            'permission-all': execScope === 'all',
                        }"
                        :disabled="running"
                        :title="
                            execScope === 'workspace'
                                ? t('composer.scopeWorkspaceTitle')
                                : t('composer.scopeAllTitle')
                        "
                        @click="togglePermissionMenu"
                    >
                        <span class="permission-icon">🔒</span>
                        <span class="permission-text">{{ permissionLabel }}</span>
                        <span
                            class="composer-permission-arrow"
                            :class="{ open: showPermissionMenu }"
                            >▼</span
                        >
                    </button>
                    <div v-if="showPermissionMenu" class="composer-permission-menu">
                        <button
                            type="button"
                            class="composer-permission-option"
                            :class="{ active: execScope === 'workspace' }"
                            @click="setExecScope('workspace')"
                        >
                            <span class="option-icon">🔒</span>
                            {{ t("composer.scopeWorkspaceOption") }}
                        </button>
                        <button
                            type="button"
                            class="composer-permission-option"
                            :class="{ active: execScope === 'all' }"
                            @click="setExecScope('all')"
                        >
                            <span class="option-icon">⚠️</span>
                            {{ t("composer.scopeAllOption") }}
                        </button>
                    </div>
                </div>
                <button
                    v-if="running"
                    class="btn btn-danger composer-run-button"
                    type="button"
                    @click="$emit('stop')"
                >
                    {{ t("composer.stop") }}
                </button>
                <button
                    v-else
                    class="btn btn-primary composer-run-button"
                    type="button"
                    :disabled="!canRun"
                    @click="submit"
                >
                    {{ t("composer.run") }}
                </button>
            </div>
        </div>
    </section>
</template>
<script setup>
    import { computed, ref } from "vue";
    import { t } from "../services/i18n.js";
    import {
        extractConversationId,
        pickImages,
        uploadWorkspaceImages,
        uploadedImageUrl,
    } from "../services/agent-api.js";
    // 与 webui/upload-api.js 保持一致：单次 8 张、单张 20MB、只收位图。
    // 前端先拦一遍，避免把 21MB 的文件整个传上去再被服务端拒绝。
    const MAX_IMAGES = 8;
    const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
    const ALLOWED_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
    const props = defineProps({
        task: { type: String, default: "" },
        provider: { type: String, default: "chatgpt" },
        running: { type: Boolean, default: false },
        conversationId: { type: String, default: "" },
        workspace: { type: String, default: "" },
        images: { type: Array, default: () => [] },
        sessionId: { type: String, default: null },
        execScope: { type: String, default: "workspace" },
    });
    const emit = defineEmits([
        "update:task",
        "update:conversationId",
        "update:images",
        "update:execScope",
        "run",
        "stop",
    ]);
    const input = ref(null);
    const fileInput = ref(null);
    const uploading = ref(false);
    const imageError = ref("");
    // 拖拽悬停高亮：只在真的有文件被拖进来时点亮，避免拖动选中文本也亮
    const dragActive = ref(false);
    const showPermissionMenu = ref(false);
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
    const permissionLabel = computed(() => {
        return props.execScope === "workspace"
            ? t("composer.permissionWorkspace")
            : t("composer.permissionAll");
    });
    // 用户可能粘贴完整会话 URL 或纯 conversation id；这里只做轻量提示，
    // 真正的 URL -> id 解析由 provider 端在 Agent 内部负责。
    const conversationIdHint = computed(() => {
        if (!props.conversationId || !props.conversationId.trim()) {
            return "";
        }
        const parsed = extractConversationId(props.provider, props.conversationId.trim());
        if (parsed) {
            return t("composer.willContinue", { id: parsed });
        }
        return t("composer.willContinue", { id: props.conversationId.trim() });
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
    // 上传接口会给文件名加「-<13 位时间戳>-<6 位随机>」防重名。
    // 这串东西对用户没有意义，显示时去掉，只留原始文件名。
    const UPLOAD_SUFFIX = /-\d{13}-[a-z0-9]{6}(\.[A-Za-z0-9]+)$/;
    function displayName(value) {
        const base = shortName(value);
        return base.replace(UPLOAD_SUFFIX, "$1");
    }
    function thumbFor(image) {
        return uploadedImageUrl(props.workspace, image);
    }
    function previewImage(image) {
        const url = thumbFor(image);
        if (url) {
            window.open(url, "_blank", "noopener");
        }
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
        // input.files 返回的是「活」的 FileList：把 value 清空后它会立刻变成空列表。
        // 所以必须先拷成普通数组再清 value，否则下面的 files.length 永远是 0，
        // 选完图什么都不发生（Web 端附加图片完全失效的根因）。
        const raw = event.target && event.target.files ? event.target.files : null;
        const files = raw ? Array.from(raw) : [];
        // 允许用户连续选择同一文件：处理完立即清空 value。
        if (event.target) {
            event.target.value = "";
        }
        if (!files.length) {
            return;
        }
        await uploadFiles(files);
    }
    /**
    统一的上传入口：按钮选文件、拖拽、粘贴都走这里，保证三处的校验与提示一致。
    */
    async function uploadFiles(files) {
        if (!files.length) {
            return;
        }
        if (!props.workspace || !props.workspace.trim()) {
            imageError.value = t("composer.attachNoWorkspace");
            return;
        }
        // 先本地过一遍：类型、大小、总数。宁可这里说清楚，也不要传完再报
        // "File too large" / "Too many files" 这种英文服务端错误。
        const remaining = Math.max(0, MAX_IMAGES - (props.images || []).length);
        const accepted = [];
        let tooMany = 0;
        const problems = [];
        for (const file of files) {
            const dot = file.name.lastIndexOf(".");
            const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
            if (ALLOWED_EXT.indexOf(ext) === -1) {
                problems.push(t("composer.attachBadType", { name: file.name }));
                continue;
            }
            if (file.size > MAX_IMAGE_BYTES) {
                problems.push(
                    t("composer.attachTooLarge", {
                        name: file.name,
                        size: Math.round(MAX_IMAGE_BYTES / (1024 * 1024)),
                    })
                );
                continue;
            }
            if (accepted.length >= remaining) {
                tooMany += 1;
                continue;
            }
            accepted.push(file);
        }
        if (tooMany > 0) {
            problems.push(t("composer.attachLimit", { max: MAX_IMAGES, count: tooMany }));
        }
        imageError.value = problems.join(t("composer.attachSeparator"));
        if (!accepted.length) {
            return;
        }
        uploading.value = true;
        try {
            const paths = await uploadWorkspaceImages(props.workspace, accepted);
            if (paths && paths.length) {
                mergeImages(paths);
            }
        } catch (error) {
            imageError.value = t("composer.attachFailed", { reason: error.message });
        } finally {
            uploading.value = false;
        }
    }
    /**
    剪贴板里的截图常常没有扩展名（或叫 image.png），而服务端按扩展名白名单放行。
    这里补一个带扩展名的文件名，否则粘贴会被自己的校验拦掉。
    */
    function withImageExtension(file) {
        if (!file) {
            return null;
        }
        const name = file.name || "";
        const hasExt = /\.[A-Za-z0-9]+$/.test(name);
        // 剪贴板的截图通常叫 image.png / blob.png，多张放在一起完全分不清；
        // 统一改成 pasted-<时间>.png，至少能按时间区分。
        const generic = /^(image|blob|clipboard)(\.(png|jpe?g|webp|gif|bmp))?$/i.test(name);
        if (hasExt && !generic) {
            return file;
        }
        // 用本地时间，不要 toISOString：那会把 +8 区用户写成早 8 小时，
        // 混在一堆文件名里很难对上自己刚粘的那张。
        const now = new Date();
        const pad = (value) => String(value).padStart(2, "0");
        const stamp =
            String(now.getFullYear()) +
            pad(now.getMonth() + 1) +
            pad(now.getDate()) +
            pad(now.getHours()) +
            pad(now.getMinutes()) +
            pad(now.getSeconds());
        const ext = hasExt
            ? name.slice(name.lastIndexOf("."))
            : file.type === "image/jpeg"
              ? ".jpg"
              : ".png";
        try {
            return new File([file], "pasted-" + stamp + ext, { type: file.type || "image/png" });
        } catch (error) {
            return file;
        }
    }
    function clipboardImages(event) {
        const data = event.clipboardData;
        if (!data || !data.items) {
            return [];
        }
        const files = [];
        for (const item of Array.from(data.items)) {
            if (item.kind !== "file" || String(item.type).indexOf("image/") !== 0) {
                continue;
            }
            const named = withImageExtension(item.getAsFile());
            if (named) {
                files.push(named);
            }
        }
        return files;
    }
    async function onPaste(event) {
        if (props.running || uploading.value) {
            return;
        }
        const files = clipboardImages(event);
        if (!files.length) {
            return;
        }
        // 有图片就不要再把二进制内容插进 textarea（会变成乱码或 base64 长串）
        event.preventDefault();
        imageError.value = "";
        await uploadFiles(files);
    }
    function onDragOver(event) {
        if (props.running || uploading.value) {
            return;
        }
        const types =
            event.dataTransfer && event.dataTransfer.types ? event.dataTransfer.types : [];
        if (Array.from(types).indexOf("Files") === -1) {
            return;
        }
        dragActive.value = true;
    }
    function onDragLeave() {
        dragActive.value = false;
    }
    async function onDrop(event) {
        dragActive.value = false;
        if (props.running || uploading.value) {
            return;
        }
        const dropped =
            event.dataTransfer && event.dataTransfer.files
                ? Array.from(event.dataTransfer.files)
                : [];
        if (!dropped.length) {
            return;
        }
        // 拖进来的可能是文件夹或任意文件：交给 uploadFiles 统一校验类型与大小，
        // 非图片会得到一句明确的提示，而不是静默丢弃。
        imageError.value = "";
        await uploadFiles(dropped);
    }
    function togglePermissionMenu() {
        if (props.running) {
            return;
        }
        showPermissionMenu.value = !showPermissionMenu.value;
    }
    function setExecScope(scope) {
        if (props.running) {
            return;
        }
        emit("update:execScope", scope);
        showPermissionMenu.value = false;
    }
    defineExpose({ focus });
</script>
<style scoped>
    /* 拖拽图片进来时给整个输入区一个可见落点，否则用户不知道能不能放 */
    .composer.composer-drop-active {
        outline: 2px dashed var(--c-accent);
        outline-offset: -3px;
        background: color-mix(in srgb, var(--c-accent) 8%, transparent);
    }
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
    .composer-permission-btn,
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
    /* 权限控制按钮样式 */
    .composer-permission-dropdown {
        position: relative;
    }
    .composer-permission-btn {
        border: 1px solid var(--c-border-strong);
        background: var(--c-btn-bg);
        color: var(--c-text-muted);
        transition:
            color 0.14s ease,
            border-color 0.14s ease,
            background 0.14s ease;
        gap: 6px;
        font-weight: 500;
    }
    .composer-permission-btn.permission-workspace {
        border-color: #10b981;
        color: #10b981;
        background: rgba(16, 185, 129, 0.1);
    }
    .composer-permission-btn.permission-workspace:hover:not(:disabled) {
        background: rgba(16, 185, 129, 0.2);
        border-color: #059669;
        color: #059669;
    }
    .composer-permission-btn.permission-all {
        border-color: #f59e0b;
        color: #f59e0b;
        background: rgba(245, 158, 11, 0.1);
    }
    .composer-permission-btn.permission-all:hover:not(:disabled) {
        background: rgba(245, 158, 11, 0.2);
        border-color: #d97706;
        color: #d97706;
    }
    .composer-permission-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }
    .permission-icon {
        font-size: 14px;
        margin-right: 4px;
    }
    .permission-text {
        font-weight: 600;
    }
    .composer-permission-arrow {
        font-size: 8px;
        transition: transform 0.15s ease;
        margin-left: 4px;
    }
    .composer-permission-arrow.open {
        transform: rotate(180deg);
    }
    .composer-permission-menu {
        position: absolute;
        bottom: 100%;
        right: 0;
        margin-bottom: 4px;
        min-width: 160px;
        border: 1px solid var(--c-border-strong);
        border-radius: 6px;
        background: var(--c-elevated-bg);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        overflow: hidden;
        z-index: 100;
    }
    .composer-permission-option {
        display: flex;
        align-items: center;
        width: 100%;
        padding: 8px 12px;
        border: 0;
        background: transparent;
        color: var(--c-text-body);
        font-size: 12px;
        text-align: left;
        cursor: pointer;
        transition: background 0.14s ease;
        gap: 8px;
    }
    .composer-permission-option:hover {
        background: var(--c-btn-hover);
    }
    .composer-permission-option.active {
        background: #64748b;
        color: #fff;
    }
    .option-icon {
        font-size: 14px;
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
    .composer-image-thumb {
        flex: 0 0 auto;
        width: 46px;
        height: 34px;
        border: 1px solid var(--c-border-soft);
        border-radius: 4px;
        background: var(--c-elevated-bg);
        object-fit: cover;
        cursor: zoom-in;
    }
    .composer-image-placeholder {
        display: inline-flex;
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        opacity: 0.7;
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
