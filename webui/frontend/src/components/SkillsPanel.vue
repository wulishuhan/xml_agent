<template>
    <div class="skills-mask" @click.self="$emit('close')">
        <section
            class="skills-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="skills-title"
        >
            <header class="skills-header">
                <div class="skills-heading">
                    <div class="skills-icon">◆</div>
                    <div>
                        <strong id="skills-title">Skills</strong>
                        <span>{{ summary }}</span>
                    </div>
                </div>
                <div class="skills-header-actions">
                    <button
                        type="button"
                        class="btn"
                        :disabled="busy || editing"
                        :title="
                            editing ? 'Finish or cancel editing first' : 'Reload skills from disk'
                        "
                        @click="reload"
                    >
                        {{ busy ? "Working..." : "Reload" }}
                    </button>
                    <button
                        class="icon-button"
                        type="button"
                        aria-label="Close"
                        @click="$emit('close')"
                    >
                        ×
                    </button>
                </div>
            </header>
            <div class="skills-body">
                <div v-if="isLoading" class="skills-loading">Loading skills...</div>
                <template v-else>
                    <div v-if="errorMessage" class="skills-alert">{{ errorMessage }}</div>
                    <div v-if="notice" class="skills-notice">{{ notice }}</div>
                    <div v-if="!workspace" class="skills-warning">
                        <strong>No workspace selected</strong>
                        <span>
                            Skills live inside a workspace. Pick a workspace on the left, then come
                            back — otherwise the agent has nothing to read.
                        </span>
                    </div>
                    <div v-if="!skills.length" class="skills-empty">
                        <div class="skills-empty-orb">◆</div>
                        <strong>No skills found</strong>
                        <span>
                            Drop a Markdown file into &lt;workspace&gt;/.agent/skills/ (or
                            ~/.xml-agent/skills/), then press Reload.
                        </span>
                    </div>
                    <div v-else class="skills-layout">
                        <aside class="skills-list">
                            <div v-for="group in grouped" :key="group.source" class="skills-group">
                                <div class="skills-group-title">
                                    <span>{{ group.label }}</span>
                                    <span class="skills-group-hint">{{ group.hint }}</span>
                                </div>
                                <button
                                    v-for="skill in group.items"
                                    :key="skill.id"
                                    type="button"
                                    class="skills-item"
                                    :class="{
                                        selected: skill.id === selectedId,
                                        inactive: !skill.active,
                                        disabled: !skill.enabled,
                                    }"
                                    @click="select(skill)"
                                >
                                    <span class="skills-item-name" :title="skill.name">
                                        {{ skill.name }}
                                    </span>
                                    <span class="skills-item-desc">{{ skill.description }}</span>
                                    <span class="skills-item-meta">
                                        <span
                                            class="skills-flag"
                                            :class="flagClass(skill)"
                                            :title="flagTitle(skill)"
                                        >
                                            {{ flagText(skill) }}
                                        </span>
                                        <span class="skills-item-size">{{
                                            formatSize(skill.size)
                                        }}</span>
                                    </span>
                                </button>
                            </div>
                        </aside>
                        <section class="skills-detail">
                            <div v-if="!detail" class="skills-detail-empty">
                                <span>Select a skill on the left to read it.</span>
                            </div>
                            <template v-else>
                                <header class="skills-detail-header">
                                    <div class="skills-detail-title">
                                        <h2>{{ detail.name }}</h2>
                                        <div class="skills-badges">
                                            <!-- id 已经是 source:slug，单独再挂一个来源徽章是重复信息 -->
                                            <span
                                                class="skills-badge"
                                                :class="'src-' + detail.source"
                                            >
                                                {{ detail.id }}
                                            </span>
                                            <span
                                                v-if="!detail.active"
                                                class="skills-badge badge-warn"
                                                :title="
                                                    'A higher-priority copy exists in ' +
                                                    detail.shadowedBy
                                                "
                                            >
                                                overridden by {{ detail.shadowedBy }}
                                            </span>
                                            <span
                                                v-else-if="!detail.enabled"
                                                class="skills-badge badge-warn"
                                            >
                                                disabled
                                            </span>
                                        </div>
                                    </div>
                                    <div class="skills-detail-actions">
                                        <template v-if="editing">
                                            <span v-if="dirty" class="skills-dirty">unsaved</span>
                                            <button
                                                type="button"
                                                class="btn btn-primary"
                                                :disabled="busy || !dirty"
                                                title="Save (Ctrl/⌘+S)"
                                                @click="save(detail)"
                                            >
                                                Save
                                            </button>
                                            <button
                                                type="button"
                                                class="btn"
                                                :disabled="busy"
                                                @click="cancelEdit"
                                            >
                                                Cancel
                                            </button>
                                        </template>
                                        <template v-else>
                                            <label class="skills-toggle" title="Include in prompt">
                                                <input
                                                    type="checkbox"
                                                    :checked="detail.enabled"
                                                    :disabled="busy"
                                                    @change="toggleEnabled(detail)"
                                                />
                                                <span>{{
                                                    detail.enabled ? "Enabled" : "Disabled"
                                                }}</span>
                                            </label>
                                            <button
                                                type="button"
                                                class="btn"
                                                :disabled="busy || !canEdit"
                                                :title="editTitle"
                                                @click="startEdit(detail)"
                                            >
                                                {{
                                                    detail.editable === false
                                                        ? "Copy & edit"
                                                        : "Edit"
                                                }}
                                            </button>
                                            <button
                                                v-if="!detail.installed"
                                                type="button"
                                                class="btn"
                                                :disabled="busy || !workspace"
                                                :title="
                                                    workspace
                                                        ? 'Copy into <workspace>/.agent/skills/ so the agent can read it'
                                                        : 'Select a workspace first'
                                                "
                                                @click="install(detail)"
                                            >
                                                Install to workspace
                                            </button>
                                            <button
                                                v-if="detail.removable"
                                                type="button"
                                                class="btn btn-danger"
                                                :disabled="busy"
                                                @click="remove(detail)"
                                            >
                                                Remove
                                            </button>
                                        </template>
                                    </div>
                                </header>
                                <div class="skills-detail-meta">
                                    <div class="skills-meta-row">
                                        <span>Path</span>
                                        <code :title="detail.path">{{ detail.path }}</code>
                                    </div>
                                    <div class="skills-meta-row">
                                        <span>Readable by agent</span>
                                        <code v-if="detail.workspacePath">{{
                                            detail.workspacePath
                                        }}</code>
                                        <em v-else class="skills-meta-warn">
                                            not inside this workspace — install it to use it
                                        </em>
                                    </div>
                                    <div class="skills-meta-row">
                                        <span>Updated</span>
                                        <code>{{ formatDate(detail.modifiedAt) }}</code>
                                    </div>
                                    <div v-if="detail.tags.length" class="skills-meta-row">
                                        <span>Tags</span>
                                        <code>{{ detail.tags.join(", ") }}</code>
                                    </div>
                                </div>
                                <div class="skills-doc" :class="{ 'skills-doc-editing': editing }">
                                    <div v-if="editing" class="skills-editor">
                                        <textarea
                                            v-model="draft"
                                            class="skills-editor-input"
                                            spellcheck="false"
                                            :disabled="busy"
                                            @keydown.ctrl.s.prevent="save(detail)"
                                            @keydown.meta.s.prevent="save(detail)"
                                        ></textarea>
                                        <div class="skills-editor-bar">
                                            <span
                                                >{{ draftChars }} chars ·
                                                {{ draftLines }} lines</span
                                            >
                                            <span>Ctrl/⌘+S saves · the whole file is replaced</span>
                                        </div>
                                    </div>
                                    <template v-else>
                                        <div
                                            v-if="docHtml"
                                            class="skills-doc-html"
                                            v-html="docHtml"
                                        ></div>
                                        <pre v-else class="skills-doc-raw">{{ detail.body }}</pre>
                                    </template>
                                </div>
                                <p v-if="detail.truncated" class="skills-doc-truncated">
                                    File is larger than 1 MB — content truncated.
                                </p>
                            </template>
                        </section>
                    </div>
                </template>
            </div>
        </section>
    </div>
</template>
<script setup>
    import { computed, onMounted, ref, watch } from "vue";
    import {
        getSkill,
        getSkills,
        installSkill,
        removeSkill,
        setSkillEnabled,
        updateSkill,
    } from "../services/agent-api.js";
    import { renderMarkdown } from "../services/markdown.mjs";
    const props = defineProps({
        workspace: { type: String, default: "" },
    });
    defineEmits(["close"]);
    const SOURCE_GROUPS = [
        { source: "workspace", label: "Workspace", hint: ".agent/skills — readable" },
        { source: "user", label: "User", hint: "~/.xml-agent/skills" },
        { source: "builtin", label: "Built-in", hint: "shipped with the app" },
    ];
    const skills = ref([]);
    const selectedId = ref("");
    const detail = ref(null);
    const isLoading = ref(true);
    const busy = ref(false);
    const notice = ref("");
    const errorMessage = ref("");
    // 编辑态只改本地草稿，按 Save 才落盘，避免每敲一个字就写文件
    const editing = ref(false);
    const draft = ref("");
    const grouped = computed(() => {
        return SOURCE_GROUPS.map((group) => ({
            source: group.source,
            label: group.label,
            hint: group.hint,
            items: skills.value.filter((skill) => skill.source === group.source),
        })).filter((group) => group.items.length);
    });
    const summary = computed(() => {
        if (isLoading.value) {
            return "Loading...";
        }
        const totalCount = skills.value.length;
        if (!totalCount) {
            return "No skills";
        }
        const activeCount = skills.value.filter((skill) => skill.active).length;
        return (
            totalCount +
            " document(s) · " +
            activeCount +
            " active · " +
            (props.workspace || "no workspace")
        );
    });
    const docHtml = computed(() => {
        if (!detail.value) {
            return "";
        }
        return renderMarkdown(detail.value.body || "");
    });
    const dirty = computed(() => {
        if (!editing.value || !detail.value) {
            return false;
        }
        return draft.value !== (detail.value.content || "");
    });
    const draftChars = computed(() => draft.value.length);
    const draftLines = computed(() => (draft.value ? draft.value.split("\n").length : 0));
    const canEdit = computed(() => {
        if (!detail.value) {
            return false;
        }
        // builtin 只读：没有工作区就没地方放可改写的那份副本
        return detail.value.editable !== false || Boolean(props.workspace);
    });
    const editTitle = computed(() => {
        if (!detail.value) {
            return "";
        }
        if (detail.value.editable !== false) {
            return "Edit this document in place";
        }
        return props.workspace
            ? "Built-in skills are read-only — copy it into the workspace and edit that copy"
            : "Select a workspace first — built-in skills are read-only";
    });
    function flagText(skill) {
        if (!skill.active) {
            return "overridden";
        }
        return skill.enabled ? "active" : "disabled";
    }
    function flagClass(skill) {
        if (!skill.active) {
            return "flag-muted";
        }
        return skill.enabled ? "flag-on" : "flag-off";
    }
    function flagTitle(skill) {
        if (!skill.active) {
            return "A copy in " + skill.shadowedBy + " takes precedence";
        }
        return skill.enabled ? "Used in the first prompt" : "Excluded from the first prompt";
    }
    function formatSize(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) {
            return value + " B";
        }
        if (value < 1024 * 1024) {
            return (value / 1024).toFixed(1) + " KB";
        }
        return (value / (1024 * 1024)).toFixed(1) + " MB";
    }
    function formatDate(value) {
        if (!value) {
            return "-";
        }
        const date = new Date(value);
        if (isNaN(date.getTime())) {
            return String(value);
        }
        return date.toLocaleString();
    }
    async function load() {
        isLoading.value = true;
        errorMessage.value = "";
        try {
            const result = await getSkills(props.workspace);
            skills.value = Array.isArray(result.skills) ? result.skills : [];
            // 保持当前选中项；它消失了（被删/工作区切换）就退回第一条
            const stillThere = skills.value.some((skill) => skill.id === selectedId.value);
            if (!stillThere) {
                const first = skills.value.find((skill) => skill.active) || skills.value[0];
                selectedId.value = first ? first.id : "";
                detail.value = null;
            }
            if (selectedId.value) {
                await loadDetail(selectedId.value);
            }
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            isLoading.value = false;
        }
    }
    async function loadDetail(id) {
        const skill = skills.value.find((item) => item.id === id);
        if (!skill) {
            detail.value = null;
            return;
        }
        try {
            detail.value = await getSkill(id, props.workspace);
        } catch (error) {
            errorMessage.value = error.message;
            detail.value = null;
        }
    }
    function select(skill) {
        selectedId.value = skill.id;
        editing.value = false;
        draft.value = "";
        loadDetail(skill.id);
    }
    async function reload() {
        busy.value = true;
        notice.value = "";
        await load();
        busy.value = false;
    }
    async function toggleEnabled(skill) {
        busy.value = true;
        errorMessage.value = "";
        try {
            const result = await setSkillEnabled(skill.id, !skill.enabled, props.workspace);
            if (detail.value && detail.value.id === skill.id) {
                detail.value = Object.assign({}, detail.value, { enabled: result.enabled });
            }
            await load();
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            busy.value = false;
        }
    }
    async function install(skill) {
        if (!props.workspace) {
            return;
        }
        busy.value = true;
        errorMessage.value = "";
        notice.value = "";
        try {
            const result = await installSkill(skill.id, props.workspace);
            notice.value = result.message || "Installed";
            // 安装后工作区多了一份同名副本，选中它（用户接下来要看的正是这份）
            selectedId.value = "workspace:" + skill.slug;
            await load();
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            busy.value = false;
        }
    }
    async function remove(skill) {
        busy.value = true;
        errorMessage.value = "";
        notice.value = "";
        try {
            await removeSkill(skill.id, props.workspace);
            notice.value = "Removed from workspace";
            if (selectedId.value === skill.id) {
                selectedId.value = "";
                detail.value = null;
            }
            await load();
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            busy.value = false;
        }
    }
    /**
     * 进入编辑。
     * builtin 只读，所以先复制一份到工作区、改的是那份 —— 内置文件在 app.asar 里，
     * 就算写成功了下次升级也会被覆盖，不如一开始就改可控的副本。
     */
    async function startEdit(skill) {
        if (!skill) {
            return;
        }
        errorMessage.value = "";
        notice.value = "";
        if (skill.editable === false) {
            if (!props.workspace) {
                errorMessage.value = "Select a workspace first — built-in skills are read-only.";
                return;
            }
            await install(skill);
            if (!detail.value || detail.value.source !== "workspace") {
                return;
            }
            notice.value = "Copied into the workspace — editing that copy";
        }
        draft.value = detail.value ? detail.value.content || "" : "";
        editing.value = true;
    }
    async function save(skill) {
        if (!skill || !dirty.value) {
            return;
        }
        busy.value = true;
        errorMessage.value = "";
        notice.value = "";
        try {
            await updateSkill(skill.id, draft.value, props.workspace);
            editing.value = false;
            draft.value = "";
            notice.value = "Saved — the agent reads the new version on its next turn";
            await load();
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            busy.value = false;
        }
    }
    function cancelEdit() {
        editing.value = false;
        draft.value = "";
    }
    watch(
        () => props.workspace,
        () => {
            selectedId.value = "";
            detail.value = null;
            editing.value = false;
            draft.value = "";
            load();
        }
    );
    onMounted(load);
</script>
<style scoped>
    .skills-mask {
        position: fixed;
        z-index: 1150;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--c-backdrop);
        backdrop-filter: blur(5px);
    }
    .skills-panel {
        display: flex;
        width: min(1080px, 100%);
        height: min(840px, calc(100vh - 48px));
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--c-border-strong);
        border-radius: 14px;
        background: var(--c-card-bg);
        box-shadow:
            0 24px 70px var(--c-shadow-strong),
            0 0 0 1px rgb(255 255 255 / 2%);
    }
    .skills-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--c-border);
        background: var(--c-elevated-bg);
    }
    .skills-heading {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 12px;
    }
    .skills-icon {
        display: grid;
        width: 38px;
        height: 38px;
        flex: 0 0 38px;
        place-items: center;
        border: 1px solid var(--c-border-strong);
        border-radius: 9px;
        background: var(--c-raised-bg);
        color: var(--c-accent-2);
        font-size: 15px;
    }
    .skills-heading strong {
        display: block;
        color: var(--c-text-strong);
        font-size: 14px;
        font-weight: 650;
    }
    .skills-heading span {
        display: block;
        margin-top: 3px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .skills-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .skills-body {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        overflow: hidden;
    }
    .skills-loading,
    .skills-detail-empty {
        padding: 32px;
        color: var(--c-text-muted);
        font-size: 13px;
        text-align: center;
    }
    .skills-alert,
    .skills-notice {
        margin: 12px 18px 0;
        padding: 9px 12px;
        border-radius: 8px;
        font-size: 12px;
    }
    .skills-alert {
        border: 1px solid var(--c-danger);
        background: var(--c-raised-bg);
        color: var(--c-danger-text);
    }
    .skills-notice {
        border: 1px solid var(--c-border-strong);
        background: var(--c-raised-bg);
        color: var(--c-text-body);
    }
    .skills-warning {
        display: flex;
        flex-direction: column;
        gap: 3px;
        margin: 12px 18px 0;
        padding: 10px 12px;
        border: 1px solid var(--c-border-strong);
        border-radius: 8px;
        background: var(--c-raised-bg);
        font-size: 12px;
    }
    .skills-warning strong {
        color: var(--c-text-strong);
    }
    .skills-warning span {
        color: var(--c-text-muted);
    }
    .skills-empty {
        display: flex;
        flex: 1;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 40px;
        color: var(--c-text-muted);
        font-size: 12px;
        text-align: center;
    }
    .skills-empty strong {
        color: var(--c-text-strong);
        font-size: 13px;
    }
    .skills-empty-orb {
        display: grid;
        width: 52px;
        height: 52px;
        place-items: center;
        border: 1px solid var(--c-border);
        border-radius: 50%;
        color: var(--c-text-faint);
        font-size: 20px;
    }
    .skills-layout {
        display: grid;
        min-height: 0;
        flex: 1;
        grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
    }
    .skills-list {
        overflow-y: auto;
        border-right: 1px solid var(--c-border);
        padding: 10px;
    }
    .skills-group + .skills-group {
        margin-top: 14px;
    }
    .skills-group-title {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        padding: 4px 6px 6px;
        color: var(--c-text-muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }
    .skills-group-hint {
        color: var(--c-text-faint);
        font-size: 10px;
        font-weight: 400;
        letter-spacing: 0;
        text-transform: none;
    }
    .skills-item {
        display: flex;
        width: 100%;
        flex-direction: column;
        gap: 3px;
        padding: 8px 10px;
        border: 1px solid transparent;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        transition:
            background 0.12s ease,
            border-color 0.12s ease;
    }
    .skills-item:hover {
        background: var(--c-hover-bg);
    }
    .skills-item.selected {
        border-color: var(--c-active-border);
        background: var(--c-active-bg);
    }
    .skills-item.inactive .skills-item-name,
    .skills-item.disabled .skills-item-name {
        color: var(--c-text-muted);
    }
    .skills-item-name {
        overflow: hidden;
        color: var(--c-text-strong);
        font-size: 12.5px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .skills-item-desc {
        display: -webkit-box;
        overflow: hidden;
        color: var(--c-text-muted);
        font-size: 11px;
        line-height: 1.45;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
    }
    .skills-item-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 2px;
    }
    .skills-item-size {
        color: var(--c-text-faint);
        font-size: 10px;
    }
    .skills-flag {
        padding: 1px 6px;
        border: 1px solid var(--c-border);
        border-radius: 999px;
        font-size: 9.5px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
    }
    .flag-on {
        border-color: var(--c-success);
        color: var(--c-success-text);
    }
    .flag-off {
        border-color: var(--c-border-strong);
        color: var(--c-text-muted);
    }
    .flag-muted {
        border-style: dashed;
        color: var(--c-text-faint);
    }
    .skills-detail {
        display: flex;
        min-width: 0;
        flex-direction: column;
        overflow: hidden;
    }
    .skills-detail-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px 12px;
        border-bottom: 1px solid var(--c-border-soft);
    }
    .skills-detail-title {
        min-width: 0;
    }
    .skills-detail-title h2 {
        margin: 0;
        color: var(--c-text-strong);
        font-size: 15px;
        font-weight: 650;
    }
    .skills-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 7px;
    }
    .skills-badge {
        padding: 1px 7px;
        border: 1px solid var(--c-border);
        border-radius: 999px;
        color: var(--c-text-muted);
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 10px;
    }
    .badge-warn {
        border-color: var(--c-warning-text);
        color: var(--c-warning-text);
    }
    .src-workspace {
        border-color: var(--c-accent-2);
        color: var(--c-accent-2);
    }
    .skills-detail-actions {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
    }
    .skills-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--c-text-muted);
        font-size: 11px;
        cursor: pointer;
    }
    .skills-toggle input {
        accent-color: var(--c-accent-2);
    }
    .btn-danger {
        border-color: var(--c-danger);
        color: var(--c-danger-text);
    }
    .skills-detail-meta {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 18px;
        border-bottom: 1px solid var(--c-border-soft);
        background: var(--c-elevated-bg);
    }
    .skills-meta-row {
        display: flex;
        align-items: baseline;
        gap: 10px;
        font-size: 11px;
    }
    .skills-meta-row > span {
        flex: 0 0 132px;
        color: var(--c-text-faint);
    }
    .skills-meta-row code {
        overflow-wrap: anywhere;
        color: var(--c-text-body);
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 10.5px;
    }
    .skills-meta-warn {
        color: var(--c-warning-text);
        font-size: 10.5px;
        font-style: normal;
    }
    .skills-doc {
        flex: 1;
        overflow-y: auto;
        padding: 18px 22px 26px;
    }
    .skills-doc-editing {
        display: flex;
        overflow: hidden;
        padding: 0;
    }
    .skills-editor {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
    }
    .skills-editor-input {
        min-height: 0;
        flex: 1;
        padding: 16px 20px;
        border: 0;
        background: var(--c-panel-bg);
        color: var(--c-text-body);
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 12px;
        line-height: 1.7;
        outline: none;
        resize: none;
        tab-size: 4;
    }
    .skills-editor-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 7px 20px;
        border-top: 1px solid var(--c-border-soft);
        background: var(--c-elevated-bg);
        color: var(--c-text-faint);
        font-size: 10.5px;
    }
    .skills-dirty {
        padding: 1px 7px;
        border: 1px solid var(--c-warning-text);
        border-radius: 999px;
        color: var(--c-warning-text);
        font-size: 9.5px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
    }
    .skills-doc-raw {
        margin: 0;
        color: var(--c-text-body);
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11.5px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
    }
    .skills-doc-html {
        color: var(--c-text-body);
        font-size: 12.5px;
        line-height: 1.7;
    }
    .skills-doc-html :deep(h1),
    .skills-doc-html :deep(h2),
    .skills-doc-html :deep(h3),
    .skills-doc-html :deep(h4) {
        margin: 18px 0 8px;
        color: var(--c-text-strong);
        font-weight: 650;
        line-height: 1.35;
    }
    .skills-doc-html :deep(h1) {
        font-size: 18px;
    }
    .skills-doc-html :deep(h2) {
        padding-bottom: 4px;
        border-bottom: 1px solid var(--c-border-soft);
        font-size: 15px;
    }
    .skills-doc-html :deep(h3) {
        font-size: 13.5px;
    }
    .skills-doc-html :deep(p) {
        margin: 8px 0;
    }
    .skills-doc-html :deep(ul),
    .skills-doc-html :deep(ol) {
        margin: 8px 0;
        padding-left: 20px;
    }
    .skills-doc-html :deep(li) {
        margin: 3px 0;
    }
    .skills-doc-html :deep(code) {
        padding: 1px 4px;
        border: 1px solid var(--c-border-input);
        border-radius: 4px;
        /* --c-code 是文字色不是底色：当底色用会变成"蓝底蓝字"看不清 */
        background: var(--c-panel-bg);
        color: var(--c-accent-2, var(--c-text));
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11.5px;
    }
    .skills-doc-html :deep(pre) {
        overflow-x: auto;
        padding: 10px 12px;
        border: 1px solid var(--c-border-soft);
        border-radius: 8px;
        background: var(--c-panel-bg);
    }
    .skills-doc-html :deep(pre code) {
        border: 0;
        background: transparent;
        padding: 0;
        color: var(--c-text-body);
    }
    .skills-doc-html :deep(blockquote) {
        margin: 10px 0;
        padding: 2px 12px;
        border-left: 3px solid var(--c-border-strong);
        color: var(--c-text-muted);
    }
    .skills-doc-html :deep(table) {
        width: 100%;
        margin: 10px 0;
        border-collapse: collapse;
        font-size: 11.5px;
    }
    .skills-doc-html :deep(th),
    .skills-doc-html :deep(td) {
        padding: 5px 8px;
        border: 1px solid var(--c-border-soft);
        text-align: left;
    }
    .skills-doc-html :deep(th) {
        background: var(--c-elevated-bg);
        color: var(--c-text-strong);
    }
    .skills-doc-html :deep(hr) {
        margin: 16px 0;
        border: 0;
        border-top: 1px solid var(--c-border-soft);
    }
    .skills-doc-html :deep(a) {
        color: var(--c-accent-blue);
    }
    .skills-doc-truncated {
        margin: 0;
        padding: 8px 18px 14px;
        color: var(--c-warning-text);
        font-size: 11px;
    }
</style>
