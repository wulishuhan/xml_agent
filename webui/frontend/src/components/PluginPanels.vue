<template>
    <section v-if="panels.length" class="panels-section">
        <header class="panels-header">
            <div class="panels-heading">
                <strong>Plugin panels</strong>
                <span>{{ panels.length }} panel(s) contributed by plugins</span>
            </div>
            <div class="panels-actions">
                <button type="button" class="btn btn-quiet" @click="toggleAllPanels">
                    {{ allPanelsOpen ? "Collapse all" : "Expand all" }}
                </button>
                <button type="button" class="btn" :disabled="busy" @click="refreshAll">
                    {{ busy ? "Loading..." : "Refresh" }}
                </button>
            </div>
        </header>
        <article
            v-for="panel in panels"
            :key="panelKey(panel)"
            class="panel-card"
            :class="{ 'is-open': isPanelOpen(panelKey(panel)) }"
        >
            <header class="panel-card-header">
                <button
                    type="button"
                    class="panel-card-toggle"
                    :aria-expanded="isPanelOpen(panelKey(panel)) ? 'true' : 'false'"
                    @click="togglePanel(panelKey(panel))"
                >
                    <span class="panel-chevron" aria-hidden="true"></span>
                    <strong>{{ panel.title }}</strong>
                    <span class="panel-plugin">{{ panel.plugin }}</span>
                    <!-- 收起时给一行摘要，免得为了看一眼有啥内容就得展开 -->
                    <span v-if="!isPanelOpen(panelKey(panel))" class="panel-meta">
                        {{ panelMeta(panel) }}
                    </span>
                </button>
            </header>
            <div v-show="isPanelOpen(panelKey(panel))" class="panel-card-body">
                <p v-if="panel.description" class="panel-description">{{ panel.description }}</p>
                <div v-for="(block, index) in panel.blocks" :key="index" class="panel-block">
                    <p v-if="block.kind === 'note'" class="panel-note">{{ block.text }}</p>

                    <template v-else-if="block.kind === 'status'">
                        <div v-if="block.title" class="panel-block-title">{{ block.title }}</div>
                        <div v-if="blockState(panel, block).error" class="panel-error">
                            {{ blockState(panel, block).error }}
                        </div>
                        <div v-else class="panel-status">
                            <div
                                v-for="item in block.items"
                                :key="item.label"
                                class="panel-status-item"
                            >
                                <span class="panel-status-label">{{ item.label }}</span>
                                <span class="panel-status-value">
                                    {{
                                        formatValue(
                                            readPath(blockState(panel, block).value, item.value)
                                        )
                                    }}
                                </span>
                            </div>
                        </div>
                    </template>

                    <template v-else-if="block.kind === 'table'">
                        <div v-if="block.title" class="panel-block-title">{{ block.title }}</div>
                        <div v-if="blockState(panel, block).error" class="panel-error">
                            {{ blockState(panel, block).error }}
                        </div>
                        <template v-else>
                            <!-- 表格限高内部滚动：审计日志这类面板一次二十行，铺开会把整屏占满 -->
                            <div v-if="tableRows(panel, block).length" class="panel-table-scroll">
                                <table class="panel-table">
                                    <thead>
                                        <tr>
                                            <th v-for="column in block.columns" :key="column.key">
                                                {{ column.label }}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr
                                            v-for="(row, rowIndex) in tableRows(panel, block)"
                                            :key="rowIndex"
                                        >
                                            <td v-for="column in block.columns" :key="column.key">
                                                {{ formatValue(readPath(row, column.key)) }}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <p v-else class="panel-empty">{{ block.empty }}</p>
                        </template>
                    </template>

                    <template v-else-if="block.kind === 'action'">
                        <div class="panel-action">
                            <button
                                type="button"
                                class="btn"
                                :disabled="actionState(panel, block).loading"
                                @click="runAction(panel, block)"
                            >
                                {{ actionState(panel, block).loading ? "Running..." : block.label }}
                            </button>
                            <span v-if="block.description" class="panel-action-hint">
                                {{ block.description }}
                            </span>
                        </div>
                        <div v-if="actionState(panel, block).error" class="panel-error">
                            {{ actionState(panel, block).error }}
                        </div>
                        <pre v-if="actionState(panel, block).value" class="panel-result">{{
                            actionState(panel, block).value
                        }}</pre>
                    </template>
                </div>
            </div>
        </article>
        <p class="panels-hint">
            Panels are declared by plugins as plain JSON blocks; the host renders them and the
            plugin never ships JavaScript to the browser.
        </p>
    </section>
</template>

<script setup>
    import { onMounted, reactive, ref } from "vue";
    import { callPluginApi, getPluginUi } from "../services/agent-api.js";
    import { useCollapse } from "../services/collapse-state.js";

    const panels = ref([]);
    const uiErrors = ref([]);
    const busy = ref(false);
    // `${plugin}${path}` → { loading, error, value }
    const blockStates = reactive({});
    const actionStates = reactive({});

    function panelKey(panel) {
        return panel.plugin + ":" + panel.id;
    }

    // 面板默认收起：审计日志那种面板一展开就是几十行，会把下面的插件卡片全顶出屏幕
    const {
        isOpen: isPanelOpen,
        toggle: togglePanel,
        toggleAll: toggleAllPanels,
        allOpen: allPanelsOpen,
        restore: restorePanels,
    } = useCollapse("xml-agent.plugin-panels.collapsed", () => panels.value.map(panelKey));

    function panelMeta(panel) {
        const blocks = Array.isArray(panel.blocks) ? panel.blocks.length : 0;
        return blocks + " block(s)";
    }

    function stateKey(panel, block) {
        return panel.plugin + "|" + block.path;
    }

    function blockState(panel, block) {
        return blockStates[stateKey(panel, block)] || { loading: false, error: "", value: null };
    }

    function actionState(panel, block) {
        return actionStates[stateKey(panel, block)] || { loading: false, error: "", value: "" };
    }

    // 支持 "recent.0.ts" 这类点号路径
    function readPath(source, path) {
        if (!path) {
            return source;
        }
        let current = source;
        for (const part of String(path).split(".")) {
            if (current === undefined || current === null) {
                return undefined;
            }
            current = current[part];
        }
        return current;
    }

    function formatValue(value) {
        if (value === undefined || value === null || value === "") {
            return "—";
        }
        if (typeof value === "object") {
            const text = JSON.stringify(value);
            return text.length > 160 ? text.substring(0, 160) + "..." : text;
        }
        return String(value);
    }

    function tableRows(panel, block) {
        const rows = readPath(blockState(panel, block).value, block.rows);
        return Array.isArray(rows) ? rows : [];
    }

    async function loadBlock(panel, block) {
        const key = stateKey(panel, block);
        if (!blockStates[key]) {
            blockStates[key] = { loading: true, error: "", value: null };
        } else {
            blockStates[key].loading = true;
            blockStates[key].error = "";
        }
        try {
            blockStates[key].value = await callPluginApi(panel.plugin, block.path, "GET");
        } catch (error) {
            blockStates[key].error = error.message;
            blockStates[key].value = null;
        } finally {
            blockStates[key].loading = false;
        }
    }

    async function runAction(panel, block) {
        const key = stateKey(panel, block);
        if (!actionStates[key]) {
            actionStates[key] = { loading: false, error: "", value: "" };
        }
        actionStates[key].loading = true;
        actionStates[key].error = "";
        actionStates[key].value = "";
        try {
            const result = await callPluginApi(
                panel.plugin,
                block.path,
                block.method || "POST",
                block.body || undefined
            );
            actionStates[key].value = JSON.stringify(result, null, 2);
            // 动作可能改变数据，顺手刷新同一面板里的数据块
            for (const other of panel.blocks) {
                if (other.kind === "status" || other.kind === "table") {
                    loadBlock(panel, other);
                }
            }
        } catch (error) {
            actionStates[key].error = error.message;
        } finally {
            actionStates[key].loading = false;
        }
    }

    async function refreshAll() {
        busy.value = true;
        try {
            const manifest = await getPluginUi();
            panels.value = Array.isArray(manifest.panels) ? manifest.panels : [];
            uiErrors.value = [];
            for (const panel of panels.value) {
                for (const block of panel.blocks || []) {
                    if (block.kind === "status" || block.kind === "table") {
                        loadBlock(panel, block);
                    }
                }
            }
        } catch (error) {
            uiErrors.value.push(error.message);
        } finally {
            busy.value = false;
        }
    }

    onMounted(() => {
        restorePanels();
        refreshAll();
    });
</script>

<style scoped>
    .panels-section {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--c-border);
    }
    .panels-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    .panels-actions {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .panels-heading strong {
        display: block;
        color: var(--c-text-strong);
        font-size: 12px;
        font-weight: 650;
    }
    .panels-heading span {
        display: block;
        margin-top: 2px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .panel-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px 14px;
        border: 1px solid var(--c-border);
        border-radius: 10px;
        background: var(--c-input-bg-soft);
    }
    .panel-card-header {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    /* 头部整块是折叠按钮：点标题或插件名都能展开收起 */
    .panel-card-toggle {
        display: flex;
        min-width: 0;
        flex: 1 1 auto;
        align-items: center;
        gap: 8px;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        text-align: left;
        cursor: pointer;
    }
    .panel-card-toggle:focus-visible {
        outline: 2px solid var(--c-accent-blue);
        outline-offset: 3px;
        border-radius: 5px;
    }
    /* 字体里的 ▸ 在这个字族下只有 2px，改用 border 画实心三角 */
    .panel-chevron {
        flex: 0 0 auto;
        width: 0;
        height: 0;
        border-top: 3.5px solid transparent;
        border-bottom: 3.5px solid transparent;
        border-left: 4.5px solid var(--c-text-muted);
        transition: transform 120ms ease;
    }
    .panel-card.is-open .panel-chevron {
        transform: rotate(90deg);
    }
    .panel-meta {
        color: var(--c-text-dim);
        font-size: 10px;
        white-space: nowrap;
    }
    .panel-card-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .panel-card-header strong {
        color: var(--c-text-strong);
        font-size: 12px;
        font-weight: 650;
    }
    .panel-plugin {
        padding: 1px 7px;
        border: 1px solid var(--c-border-strong);
        border-radius: 999px;
        color: var(--c-badge-text);
        font-size: 10px;
    }
    .panel-description {
        margin: 0;
        color: var(--c-text-body);
        font-size: 11px;
        line-height: 1.55;
    }
    .panel-block {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .panel-block-title {
        color: var(--c-text-dim);
        font-size: 10px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
    }
    .panel-note {
        margin: 0;
        color: var(--c-text-muted);
        font-size: 11px;
        line-height: 1.6;
    }
    .panel-status {
        display: flex;
        flex-wrap: wrap;
        gap: 18px;
    }
    .panel-status-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .panel-status-label {
        color: var(--c-text-dim);
        font-size: 10px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
    }
    .panel-status-value {
        color: var(--c-text-strong);
        font-family: var(--mono, ui-monospace, monospace);
        font-size: 12px;
    }
    .panel-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
    }
    /* 表头固定在滚动区顶部，行多的时候不丢列名 */
    .panel-table-scroll {
        max-height: 240px;
        overflow: auto;
        border: 1px solid var(--c-border-soft);
        border-radius: 8px;
    }
    .panel-table-scroll thead th {
        position: sticky;
        top: 0;
        background: var(--c-panel-bg);
    }
    .panel-table th {
        padding: 4px 8px;
        border-bottom: 1px solid var(--c-border-strong);
        color: var(--c-text-dim);
        font-weight: 600;
        text-align: left;
        white-space: nowrap;
    }
    .panel-table td {
        max-width: 260px;
        overflow: hidden;
        padding: 4px 8px;
        border-bottom: 1px solid var(--c-border-soft);
        color: var(--c-text-body);
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .panel-empty {
        margin: 0;
        color: var(--c-text-dim);
        font-size: 11px;
    }
    .panel-error {
        padding: 6px 9px;
        border: 1px solid var(--c-danger);
        border-radius: 7px;
        background: rgb(248 81 73 / 8%);
        color: var(--c-danger-text);
        font-size: 11px;
        line-height: 1.5;
    }
    .panel-action {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .panel-action-hint {
        color: var(--c-text-dim);
        font-size: 10px;
    }
    .panel-result {
        max-height: 180px;
        margin: 0;
        overflow: auto;
        padding: 8px 10px;
        border: 1px solid var(--c-border);
        border-radius: 7px;
        background: var(--c-panel-bg);
        color: var(--c-code);
        font-family: var(--mono, ui-monospace, monospace);
        font-size: 10px;
        line-height: 1.5;
    }
    .panels-hint {
        margin: 0;
        color: var(--c-text-dim);
        font-size: 10px;
        line-height: 1.6;
    }
</style>
