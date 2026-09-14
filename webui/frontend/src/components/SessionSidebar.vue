<template>

<aside class="session-sidebar"> <div class="sidebar-header"> <div class="brand"> <div class="brand-mark"></div> <div class="brand-copy"> <strong>XML Agent</strong> <span>Agent Harness</span> </div> </div>

<button class="icon-button" title="New session" @click="$emit('new-session')">+</button>

</div> <div class="sidebar-toolbar"> <span class="sidebar-label">Sessions</span>

<span class="session-count">{{ sessions.length }}</span>

</div> <div class="session-list"> <div v-if="!sessions.length" class="session-list-empty"> <div class="empty-icon">◇</div> <strong>No sessions</strong> <span>Create a session to start working.</span> </div> <div v-for="item in sessions" :key="item.id" class="session-item" :class="{ active: item.id === activeId }" role="button" tabindex="0" @click="$emit('select', item.id)" @keydown.enter.prevent="$emit('select', item.id)" @keydown.space.prevent="$emit('select', item.id)" > <span class="session-status-dot" :class="`dot-${item.status}`"></span> <span class="session-item-content"> <strong>{{ getTitle(item) }}</strong> <span class="session-workspace" :title="item.workspace"> {{ getWorkspaceName(item.workspace) }} </span> <span class="session-meta"> {{ item.provider || "chatgpt" }} <span>·</span> {{ formatTime(item.createdAt) }} </span> </span>

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

</div> </div> <div class="sidebar-footer"> <div class="connection-indicator"> <span class="connection-dot"></span> <span>Local Runtime</span> </div> </div> <div v-if="pendingDelete" class="session-confirm-backdrop" @click.self="cancelDelete"> <div class="session-confirm"> <div class="session-confirm-title">Delete this session?</div> <div class="session-confirm-text">{{ getTitle(pendingDelete) }}</div> <div class="session-confirm-hint"> This removes its history and output from local storage. It cannot be undone. </div> <div class="session-confirm-actions"> <button type="button" class="btn" @click="cancelDelete">Cancel</button> <button type="button" class="btn btn-danger" @click="confirmDelete">Delete</button> </div> </div> </div> </aside> </template><script setup> import { ref } from "vue"; defineProps({ sessions: { type: Array, default: () => [] }, activeId: { type: String, default: null }, }); const emit = defineEmits(["select", "new-session", "delete"]); const pendingDelete = ref(null); function requestDelete(session) { if (!session || session.running) { return; } pendingDelete.value = session; } function cancelDelete() { pendingDelete.value = null; } function confirmDelete() { const session = pendingDelete.value; pendingDelete.value = null; if (session) { emit("delete", session.id); } } function getTitle(session) { const task = (session.task || "").trim(); if (!task) { return "Untitled session"; } return task.length > 46 ? `${task.slice(0, 46)}…` : task; } function getWorkspaceName(workspace) { if (!workspace) { return "No workspace"; } const normalized = workspace.replace(/\\/g, "/").replace(/\/+$/, ""); const parts = normalized.split("/"); return parts[parts.length - 1] || normalized; } function formatTime(timestamp) { if (!timestamp) { return ""; } return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } </script>

