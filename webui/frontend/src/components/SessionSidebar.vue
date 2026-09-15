<template>
    <aside class="session-sidebar">
        <div class="sidebar-header">
            <div class="brand">
                <div class="brand-mark"></div>
                <div class="brand-copy"><strong>XML Agent</strong> <span>Agent Harness</span></div>
            </div>
            <button class="icon-button" title="New session" @click="$emit('new-session')">+</button>
        </div>
        <div class="sidebar-toolbar">
            <span class="sidebar-label">Sessions</span>
            <span class="session-count">{{ sessions.length }}</span>
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
        <div class="session-list">
            <div v-if="!sessions.length" class="session-list-empty">
                <div class="empty-icon">◇</div>
                <strong>No sessions</strong> <span>Create a session to start working.</span>
            </div>
            <div
                v-for="item in sessions"
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
                    <span class="session-workspace" :title="item.workspace">
                        {{ getWorkspaceName(item.workspace) }}
                    </span>
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
        sessions: { type: Array, default: () => [] },
        activeId: { type: String, default: null },
        storage: { type: Object, default: null },
    });
    const emit = defineEmits(["select", "new-session", "delete"]);
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
