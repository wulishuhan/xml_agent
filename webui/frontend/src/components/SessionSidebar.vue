<template>
    <aside class="session-sidebar">
        <div class="sidebar-header">
            <div class="brand">
                <div class="brand-mark"></div>
                <div class="brand-copy"><strong>XML Agent</strong> <span>Agent Harness</span></div>
            </div>
            <button class="icon-button" title="New workspace" @click="$emit('new-workspace')">
                +
            </button>
        </div>
        <div class="sidebar-toolbar">
            <span class="sidebar-label">Workspaces</span>
            <span class="session-count">{{ workspaces.length }}</span>
        </div>
        <div v-if="storage && (storage.warn || storage.overLimit)" class="storage-warning">
            <div class="storage-warning-title">
                <span>{{
                    storage.overLimit ? "Session storage full" : "Session storage high"
                }}</span>
            </div>
            <div class="storage-warning-text">
                {{ storage.sessions }}/{{ storage.maxSessions }} sessions ·
                {{ formatBytes(storage.bytes) }}/{{ formatBytes(storage.maxDiskBytes) }}
            </div>
            <div class="storage-warning-hint">
                Delete old sessions to free space before creating new ones.
            </div>
        </div>
        <div class="workspace-list">
            <div v-if="!workspaces.length" class="session-list-empty">
                <div class="empty-icon">◇</div>
                <strong>No workspaces</strong> <span>Add a workspace to start working.</span>
            </div>
            <div v-for="ws in workspaces" :key="ws.path" class="workspace-group">
                <div
                    class="workspace-header"
                    :class="{ expanded: ws.expanded }"
                    @click="toggleWorkspace(ws)"
                >
                    <span class="workspace-arrow">›</span>
                    <div class="workspace-info">
                        <strong class="workspace-path" :title="ws.path">{{
                            getWorkspaceName(ws.path)
                        }}</strong>
                        <span class="workspace-meta"
                            >{{ ws.sessionCount }} session{{
                                ws.sessionCount !== 1 ? "s" : ""
                            }}</span
                        >
                    </div>
                    <button
                        class="icon-button workspace-new-session"
                        title="New session in this workspace"
                        @click.stop="$emit('new-session', ws.path)"
                    >
                        +
                    </button>
                </div>
                <div v-if="ws.expanded" class="session-list">
                    <div
                        v-for="item in ws.sessions"
                        :key="item.id"
                        class="session-item"
                        :class="{ active: item.id === activeId }"
                        role="button"
                        tabindex="0"
                        @click="$emit('select', item.id)"
                        @keydown.enter.prevent="$emit('select', item.id)"
                        @keydown.space.prevent="$emit('select', item.id)"
                    >
                        <span class="session-status-dot" :class="`dot-${item.status}`"></span>
                        <span class="session-item-content">
                            <strong>{{ getTitle(item) }}</strong>
                            <span class="session-meta">
                                {{ item.provider || "chatgpt" }} <span>·</span>
                                {{ formatTime(item.createdAt) }}
                            </span>
                        </span>
                        <span v-if="item.running" class="session-running">●</span>
                        <button
                            v-if="!item.running"
                            class="session-delete"
                            type="button"
                            title="Delete session"
                            aria-label="Delete session"
                            @click.stop="requestDelete(item)"
                        >
                            ×
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <div class="sidebar-footer">
            <div class="connection-indicator">
                <span class="connection-dot"></span> <span>Local Runtime</span>
            </div>
            <div v-if="storage" class="storage-meter" :title="storageMeterTitle">
                <span class="storage-meter-text">
                    {{ storage.sessions }}/{{ storage.maxSessions }} ·
                    {{ formatBytes(storage.bytes) }}
                </span>
                <span class="storage-meter-bar">
                    <span
                        class="storage-meter-fill"
                        :class="{ warn: storage.warn, full: storage.overLimit }"
                        :style="{ width: meterPercent }"
                    ></span>
                </span>
            </div>
        </div>
        <div v-if="pendingDelete" class="session-confirm-backdrop" @click.self="cancelDelete">
            <div class="session-confirm">
                <div class="session-confirm-title">Delete this session?</div>
                <div class="session-confirm-text">{{ getTitle(pendingDelete) }}</div>
                <div class="session-confirm-hint">
                    This removes its history and output from local storage. It cannot be undone.
                </div>
                <div class="session-confirm-actions">
                    <button type="button" class="btn" @click="cancelDelete">Cancel</button>
                    <button type="button" class="btn btn-danger" @click="confirmDelete">
                        Delete
                    </button>
                </div>
            </div>
        </div>
    </aside>
</template>
<script setup>
    import { computed, ref } from "vue";
    const props = defineProps({
        workspaces: { type: Array, default: () => [] },
        activeId: { type: String, default: null },
        storage: { type: Object, default: null },
    });
    const emit = defineEmits([
        "select",
        "new-session",
        "delete",
        "new-workspace",
        "toggle-workspace",
    ]);
    const pendingDelete = ref(null);
    const BACKSLASH = String.fromCharCode(92);
    const meterPercent = computed(() => {
        const storage = props.storage;
        if (!storage) {
            return "0%";
        }
        const ratio = Math.max(0, Math.min(1, storage.ratio || 0));
        return Math.round(ratio * 100) + "%";
    });
    const storageMeterTitle = computed(() => {
        const storage = props.storage;
        if (!storage) {
            return "";
        }
        return (
            "Sessions: " +
            storage.sessions +
            "/" +
            storage.maxSessions +
            " - Disk: " +
            formatBytes(storage.bytes) +
            "/" +
            formatBytes(storage.maxDiskBytes) +
            " - Location: " +
            storage.root
        );
    });
    function toggleWorkspace(ws) {
        emit("toggle-workspace", ws);
    }
    function requestDelete(session) {
        if (!session || session.running) {
            return;
        }
        pendingDelete.value = session;
    }
    function cancelDelete() {
        pendingDelete.value = null;
    }
    function confirmDelete() {
        const session = pendingDelete.value;
        pendingDelete.value = null;
        if (session) {
            emit("delete", session.id);
        }
    }
    function getTitle(session) {
        const task = (session.task || "").trim();
        if (!task) {
            return "Untitled session";
        }
        return task.length > 46 ? task.slice(0, 46) + "..." : task;
    }
    function getWorkspaceName(workspace) {
        if (!workspace) {
            return "No workspace";
        }
        const normalized = workspace.split(BACKSLASH).join("/");
        const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
        const parts = trimmed.split("/");
        return parts[parts.length - 1] || trimmed;
    }
    function formatTime(timestamp) {
        if (!timestamp) {
            return "";
        }
        return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    function formatBytes(bytes) {
        if (!bytes || bytes < 0) {
            return "0 B";
        }
        const units = ["B", "KB", "MB", "GB"];
        let value = bytes;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index += 1;
        }
        return (index === 0 ? value : value.toFixed(1)) + " " + units[index];
    }
</script>
<style scoped>
    .workspace-list {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
    }
    .workspace-group {
        margin-bottom: 10px;
    }
    .workspace-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.14s ease;
    }
    .workspace-header:hover {
        background: var(--c-hover-bg);
    }
    .workspace-arrow {
        flex: 0 0 18px;
        color: var(--c-text-muted);
        font-size: 16px;
        transition: transform 0.2s ease;
    }
    .workspace-header.expanded .workspace-arrow {
        transform: rotate(90deg);
    }
    .workspace-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }
    .workspace-path {
        color: var(--c-text-body);
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 13px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .workspace-meta {
        color: var(--c-text-muted);
        font-size: 11px;
        margin-top: 2px;
    }
    .workspace-new-session {
        opacity: 0;
        transition: opacity 0.14s ease;
        font-size: 16px;
        width: 24px;
        height: 24px;
    }
    .workspace-header:hover .workspace-new-session {
        opacity: 1;
    }
    .session-list {
        margin-left: 18px;
        margin-top: 6px;
    }
    .session-item {
        display: flex;
        width: 100%;
        min-height: 44px;
        align-items: center;
        gap: 12px;
        margin: 3px 0;
        padding: 8px 12px;
        border: 1px solid transparent;
        border-radius: 7px;
        background: transparent;
        color: var(--c-text-body);
        text-align: left;
    }
    .session-item:hover {
        border-color: var(--c-active-border);
        background: var(--c-hover-bg);
    }
    .session-item.active {
        border-color: var(--c-accent-2);
        background: var(--c-elevated-bg);
    }
    .session-status-dot {
        width: 9px;
        height: 9px;
        flex: 0 0 9px;
        border-radius: 50%;
        background: var(--c-text-faint);
    }
    .dot-completed {
        background: #22c55e;
    }
    .dot-running {
        background: #3b82f6;
        animation: pulse 1.5s infinite;
    }
    .dot-error {
        background: #ef4444;
    }
    .dot-stopped {
        background: #6b7280;
    }
    .dot-interrupted {
        background: #f59e0b;
    }
    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }
    .session-item-content {
        min-width: 0;
        flex: 1;
        display: flex;
        flex-direction: column;
    }
    .session-item-content strong {
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .session-meta {
        color: var(--c-text-muted);
        font-size: 11px;
        margin-top: 2px;
    }
    .session-running {
        color: #3b82f6;
        font-size: 11px;
    }
    .session-delete {
        flex: 0 0 auto;
        padding: 2px 6px;
        border: 0;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 16px;
        opacity: 0;
        transition: opacity 0.14s ease;
    }
    .session-item:hover .session-delete {
        opacity: 1;
    }
    .session-delete:hover {
        color: var(--c-danger);
    }
    .session-list-empty {
        display: flex;
        min-height: 180px;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 8px;
        color: var(--c-text-dim);
        font-size: 13px;
        text-align: center;
    }
    .empty-icon {
        font-size: 28px;
        color: var(--c-text-faint);
    }
    .session-confirm-backdrop {
        position: fixed;
        inset: 0;
        background: var(--c-backdrop);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
    }
    .session-confirm {
        background: var(--c-card-bg);
        border: 1px solid var(--c-border-strong);
        border-radius: 12px;
        padding: 20px;
        max-width: 360px;
        width: 100%;
    }
    .session-confirm-title {
        font-weight: 650;
        font-size: 15px;
        margin-bottom: 8px;
    }
    .session-confirm-text {
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 13px;
        color: var(--c-text-body);
        margin-bottom: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .session-confirm-hint {
        font-size: 12px;
        color: var(--c-text-muted);
        margin-bottom: 16px;
    }
    .session-confirm-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
    }
</style>
