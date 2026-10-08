<template>
    <div class="workspace-picker-mask" @click.self="$emit('close')">
        <section
            class="workspace-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-picker-title"
        >
            <header class="workspace-picker-header">
                <div class="workspace-picker-heading">
                    <div class="workspace-picker-icon">📁</div>
                    <div>
                        <strong id="workspace-picker-title">Select Workspace</strong>
                        <span>Choose a project directory</span>
                    </div>
                </div>
                <button
                    class="icon-button"
                    type="button"
                    aria-label="Close"
                    @click="$emit('close')"
                >
                    ×
                </button>
            </header>
            <div class="workspace-picker-path" :title="displayPath">
                <span>Location</span> <code>{{ displayPath || "Loading..." }}</code>
            </div>
            <div class="workspace-picker-toolbar">
                <button type="button" class="btn" :disabled="!canGoUp || loading" @click="goUp">
                    ← Up
                </button>
                <button
                    v-if="showDrivesButton"
                    type="button"
                    class="btn"
                    :disabled="loading"
                    @click="goToDrives"
                >
                    Drives
                </button>
                <button
                    type="button"
                    class="btn"
                    :disabled="!canCreateFolder || loading"
                    @click="openNewFolderPrompt"
                >
                    New Folder
                </button>
                <button
                    type="button"
                    class="btn btn-primary"
                    :disabled="!currentPath || loading"
                    @click="selectCurrent"
                >
                    Select this folder
                </button>
            </div>
            <div v-if="newFolderOpen" class="workspace-picker-new-folder">
                <input
                    ref="newFolderInput"
                    v-model="newFolderName"
                    class="workspace-picker-input"
                    type="text"
                    placeholder="Folder name"
                    :disabled="creatingFolder"
                    @keyup.enter="confirmNewFolder"
                    @keyup.esc="cancelNewFolder"
                />
                <button
                    type="button"
                    class="btn btn-primary"
                    :disabled="creatingFolder || !newFolderName.trim()"
                    @click="confirmNewFolder"
                >
                    {{ creatingFolder ? "Creating..." : "Create" }}
                </button>
                <button
                    type="button"
                    class="btn"
                    :disabled="creatingFolder"
                    @click="cancelNewFolder"
                >
                    Cancel
                </button>
            </div>
            <div v-if="errorMessage" class="error-banner">
                <strong>Unable to browse</strong> <span>{{ errorMessage }}</span>
            </div>
            <div class="workspace-picker-list">
                <div v-if="loading" class="workspace-picker-state">
                    <span class="workspace-picker-spinner"></span> <span>Loading folders...</span>
                </div>
                <div v-else-if="!entries.length" class="workspace-picker-state">
                    <span class="workspace-picker-state-icon">∅</span>
                    <strong>No subdirectories</strong>
                    <span>This folder does not contain any directories.</span>
                </div>
                <template v-else>
                    <button
                        v-for="entry in entries"
                        :key="entry.path"
                        class="workspace-picker-item"
                        type="button"
                        @click="enter(entry.path)"
                    >
                        <span class="workspace-picker-item-icon">📁</span>
                        <span class="workspace-picker-item-name">{{ entry.name }}</span>
                        <span class="workspace-picker-item-arrow">›</span>
                    </button>
                </template>
            </div>
            <footer class="workspace-picker-footer">
                <span v-if="isRootList">Select a drive to browse projects</span>
                <span v-else>Only directories are shown</span>
                <span>Double-click navigation is not required</span>
            </footer>
        </section>
    </div>
</template>
<script setup>
    import { computed, nextTick, onMounted, ref } from "vue";
    import { browseWorkspace, createWorkspaceFolder } from "../services/agent-api.js";
    const emit = defineEmits(["select", "close"]);
    const currentPath = ref("");
    const displayPath = ref("");
    const parentPath = ref(null);
    const entries = ref([]);
    const isRootList = ref(false);
    const loading = ref(false);
    const errorMessage = ref("");
    const newFolderOpen = ref(false);
    const newFolderName = ref("");
    const newFolderInput = ref(null);
    const creatingFolder = ref(false);
    const canGoUp = computed(() => {
        if (isRootList.value || !currentPath.value) {
            return false;
        }
        return Boolean(parentPath.value) || isFilesystemRoot(currentPath.value);
    });
    const showDrivesButton = computed(() => {
        if (isRootList.value || !currentPath.value || !parentPath.value) {
            return false;
        }
        return parentPath.value !== currentPath.value;
    });
    // 只有在真实目录（非 "This PC" 驱动器列表）下才允许新建文件夹。
    const canCreateFolder = computed(() => {
        return Boolean(currentPath.value) && !isRootList.value;
    });
    function isFilesystemRoot(targetPath) {
        if (targetPath === "/") {
            return true;
        }
        return /^[A-Za-z]:[\\/]+$/.test(targetPath);
    }
    async function load(targetPath) {
        loading.value = true;
        errorMessage.value = "";
        try {
            const result = await browseWorkspace(targetPath);
            currentPath.value = result.path || "";
            displayPath.value = result.displayPath || result.path || "This PC";
            parentPath.value = result.parent || null;
            entries.value = result.entries || [];
            isRootList.value = result.isRootList === true;
        } catch (error) {
            errorMessage.value = error.message || "Failed to browse workspace";
            entries.value = [];
        } finally {
            loading.value = false;
        }
    }
    function enter(targetPath) {
        load(targetPath);
    }
    function goUp() {
        if (isRootList.value) {
            return;
        }
        if (isFilesystemRoot(currentPath.value)) {
            load("");
            return;
        }
        if (parentPath.value) {
            load(parentPath.value);
        }
    }
    function goToDrives() {
        load("");
    }
    function selectCurrent() {
        if (!currentPath.value || loading.value) {
            return;
        }
        emit("select", currentPath.value);
    }
    function openNewFolderPrompt() {
        if (!canCreateFolder.value || loading.value) {
            return;
        }
        errorMessage.value = "";
        newFolderOpen.value = true;
        newFolderName.value = "";
        nextTick(() => {
            if (newFolderInput.value) {
                newFolderInput.value.focus();
            }
        });
    }
    function cancelNewFolder() {
        if (creatingFolder.value) {
            return;
        }
        newFolderOpen.value = false;
        newFolderName.value = "";
    }
    async function confirmNewFolder() {
        const name = newFolderName.value.trim();
        if (!name || creatingFolder.value) {
            return;
        }
        creatingFolder.value = true;
        errorMessage.value = "";
        try {
            await createWorkspaceFolder(currentPath.value, name);
            newFolderOpen.value = false;
            newFolderName.value = "";
            // 重新加载当前目录，让新文件夹立即出现在列表中。
            await load(currentPath.value);
        } catch (error) {
            errorMessage.value = error.message || "Failed to create folder";
        } finally {
            creatingFolder.value = false;
        }
    }
    onMounted(() => {
        load("");
    });
</script>
<style scoped>
    .workspace-picker-mask {
        position: fixed;
        z-index: 1000;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--c-backdrop);
        backdrop-filter: blur(5px);
    }
    .workspace-picker {
        display: flex;
        width: min(720px, 100%);
        max-height: min(720px, calc(100vh - 48px));
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--c-border-strong);
        border-radius: 14px;
        background: var(--c-card-bg);
        box-shadow:
            0 24px 70px var(--c-shadow-strong),
            0 0 0 1px rgb(255 255 255 / 2%);
    }
    .workspace-picker-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--c-border);
        background: var(--c-elevated-bg);
    }
    .workspace-picker-heading {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 12px;
    }
    .workspace-picker-icon {
        display: grid;
        width: 38px;
        height: 38px;
        flex: 0 0 38px;
        place-items: center;
        border: 1px solid var(--c-border-strong);
        border-radius: 9px;
        background: var(--c-raised-bg);
        font-size: 17px;
    }
    .workspace-picker-heading strong {
        display: block;
        color: var(--c-text-strong);
        font-size: 14px;
        font-weight: 650;
    }
    .workspace-picker-heading span {
        display: block;
        margin-top: 3px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .workspace-picker-path {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 10px;
        padding: 11px 18px;
        border-bottom: 1px solid var(--c-border-soft);
        background: var(--c-panel-bg);
    }
    .workspace-picker-path > span {
        flex: 0 0 auto;
        color: var(--c-text-muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }
    .workspace-picker-path code {
        min-width: 0;
        overflow: hidden;
        color: var(--c-code);
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .workspace-picker-toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 18px;
        border-bottom: 1px solid var(--c-border-soft);
    }
    .workspace-picker-toolbar .btn:first-child {
        min-width: 82px;
    }
    .workspace-picker-toolbar .btn-primary {
        min-width: 142px;
        margin-left: auto;
    }
    .workspace-picker-new-folder {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 18px;
        border-bottom: 1px solid var(--c-border-soft);
        background: var(--c-panel-bg);
    }
    .workspace-picker-input {
        min-width: 0;
        flex: 1;
        padding: 7px 10px;
        border: 1px solid var(--c-border-strong);
        border-radius: 7px;
        background: var(--c-raised-bg);
        color: var(--c-text-body);
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 12px;
    }
    .workspace-picker-input:focus {
        border-color: var(--c-accent-2);
        outline: none;
    }
    .workspace-picker-new-folder .btn-primary {
        min-width: 92px;
    }
    .workspace-picker-list {
        min-height: 240px;
        flex: 1;
        overflow-y: auto;
        padding: 8px;
    }
    .workspace-picker-list::-webkit-scrollbar {
        width: 8px;
    }
    .workspace-picker-list::-webkit-scrollbar-thumb {
        border-radius: 8px;
        background: var(--c-scrollbar);
    }
    .workspace-picker-item {
        display: flex;
        width: 100%;
        min-height: 44px;
        align-items: center;
        gap: 11px;
        margin: 2px 0;
        padding: 9px 11px;
        border: 1px solid transparent;
        border-radius: 8px;
        background: transparent;
        color: var(--c-text-body);
        text-align: left;
    }
    .workspace-picker-item:hover {
        border-color: var(--c-active-border);
        background: var(--c-hover-bg);
    }
    .workspace-picker-item-icon {
        width: 24px;
        flex: 0 0 24px;
        font-size: 16px;
        text-align: center;
    }
    .workspace-picker-item-name {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .workspace-picker-item-arrow {
        flex: 0 0 auto;
        color: var(--c-text-dim);
        font-size: 18px;
    }
    .workspace-picker-item:hover .workspace-picker-item-arrow {
        color: var(--c-accent-2);
    }
    .workspace-picker-state {
        display: flex;
        min-height: 220px;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 7px;
        color: var(--c-text-dim);
        font-size: 12px;
        text-align: center;
    }
    .workspace-picker-state strong {
        color: var(--c-text-soft);
        font-size: 13px;
    }
    .workspace-picker-state-icon {
        margin-bottom: 3px;
        color: var(--c-text-faint);
        font-size: 25px;
    }
    .workspace-picker-spinner {
        width: 20px;
        height: 20px;
        margin-bottom: 4px;
        border: 2px solid var(--c-border);
        border-top-color: var(--c-accent-2);
        border-radius: 50%;
        animation: workspace-picker-spin 0.8s linear infinite;
    }
    .workspace-picker .error-banner {
        margin: 10px 18px 0;
    }
    .workspace-picker-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 18px;
        border-top: 1px solid var(--c-border-soft);
        background: var(--c-panel-bg);
        color: var(--c-text-muted);
        font-size: 10px;
    }
    @keyframes workspace-picker-spin {
        to {
            transform: rotate(360deg);
        }
    }
    @media (max-width: 600px) {
        .workspace-picker-mask {
            padding: 12px;
        }
        .workspace-picker {
            max-height: calc(100vh - 24px);
        }
        .workspace-picker-toolbar {
            padding: 10px 12px;
        }
        .workspace-picker-path {
            padding: 10px 12px;
        }
        .workspace-picker-footer span:last-child {
            display: none;
        }
    }
</style>
