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
                <span>Location</span>
                <code>{{ displayPath || "Loading..." }}</code>
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
                    class="btn btn-primary"
                    :disabled="!currentPath || loading"
                    @click="selectCurrent"
                >
                    Select this folder
                </button>
            </div>

            <div v-if="errorMessage" class="error-banner">
                <strong>Unable to browse</strong>
                <span>{{ errorMessage }}</span>
            </div>

            <div class="workspace-picker-list">
                <div v-if="loading" class="workspace-picker-state">
                    <span class="workspace-picker-spinner"></span>
                    <span>Loading folders...</span>
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
import { computed, onMounted, ref } from "vue";
import { browseWorkspace } from "../services/agent-api.js";
const emit = defineEmits(["select", "close"]);
const currentPath = ref("");
const displayPath = ref("");
const parentPath = ref(null);
const entries = ref([]);
const isRootList = ref(false);
const loading = ref(false);
const errorMessage = ref("");
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
    background: rgb(3 6 10 / 72%);
    backdrop-filter: blur(5px);
}

.workspace-picker {
    display: flex;
    width: min(720px, 100%);
    max-height: min(720px, calc(100vh - 48px));
    flex-direction: column;
    overflow: hidden;
    border: 1px solid #303b49;
    border-radius: 14px;
    background: #0f151d;
    box-shadow:
        0 24px 70px rgb(0 0 0 / 45%),
        0 0 0 1px rgb(255 255 255 / 2%);
}

.workspace-picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 18px;
    border-bottom: 1px solid #222c38;
    background: #121923;
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
    border: 1px solid #2d4158;
    border-radius: 9px;
    background: #172333;
    font-size: 17px;
}

.workspace-picker-heading strong {
    display: block;
    color: #edf2f7;
    font-size: 14px;
    font-weight: 650;
}

.workspace-picker-heading span {
    display: block;
    margin-top: 3px;
    color: #718093;
    font-size: 11px;
}

.workspace-picker-path {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 10px;
    padding: 11px 18px;
    border-bottom: 1px solid #1d2732;
    background: #0b1016;
}

.workspace-picker-path > span {
    flex: 0 0 auto;
    color: #68778a;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.workspace-picker-path code {
    min-width: 0;
    overflow: hidden;
    color: #b8c8dc;
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
    border-bottom: 1px solid #1d2732;
}

.workspace-picker-toolbar .btn:first-child {
    min-width: 82px;
}

.workspace-picker-toolbar .btn-primary {
    min-width: 142px;
    margin-left: auto;
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
    background: #2a3440;
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
    color: #cbd4df;
    text-align: left;
}

.workspace-picker-item:hover {
    border-color: #293b50;
    background: #17202b;
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
    color: #536276;
    font-size: 18px;
}

.workspace-picker-item:hover .workspace-picker-item-arrow {
    color: #8aa5c4;
}

.workspace-picker-state {
    display: flex;
    min-height: 220px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 7px;
    color: #647284;
    font-size: 12px;
    text-align: center;
}

.workspace-picker-state strong {
    color: #9aa7b7;
    font-size: 13px;
}

.workspace-picker-state-icon {
    margin-bottom: 3px;
    color: #506176;
    font-size: 25px;
}

.workspace-picker-spinner {
    width: 20px;
    height: 20px;
    margin-bottom: 4px;
    border: 2px solid #2c3948;
    border-top-color: #7197c0;
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
    border-top: 1px solid #1d2732;
    background: #0b1016;
    color: #566477;
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
