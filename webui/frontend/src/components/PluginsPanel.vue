<template>
    <div class="plugins-mask" @click.self="$emit('close')">
        <section
            class="plugins-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugins-title"
        >
            <header class="plugins-header">
                <div class="plugins-heading">
                    <div class="plugins-icon">⚙</div>
                    <div>
                        <strong id="plugins-title">Plugins</strong>
                        <span>{{ summary }}</span>
                    </div>
                </div>
                <div class="plugins-header-actions">
                    <button type="button" class="btn btn-quiet" @click="toggleAll">
                        {{ allOpen ? "Collapse all" : "Expand all" }}
                    </button>
                    <button type="button" class="btn" :disabled="busy" @click="reload">
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
            <div class="plugins-body">
                <div v-if="isLoading" class="plugins-loading">Loading plugins...</div>
                <template v-else>
                    <div v-if="notice" class="plugins-notice">{{ notice }}</div>
                    <div v-if="errorMessage" class="plugins-alert">{{ errorMessage }}</div>
                    <div v-if="!enabled" class="plugins-warning">
                        <strong>Plugin system is disabled</strong>
                        <span>
                            Start the server with XML_AGENT_PLUGINS=1 (or remove the variable) to
                            load plugins.
                        </span>
                    </div>
                    <div v-if="loadErrors.length" class="plugins-warning">
                        <strong>{{ loadErrors.length }} plugin(s) failed to load</strong>
                        <span
                            v-for="item in loadErrors"
                            :key="item.plugin + ':' + item.error"
                            class="plugins-load-error"
                        >
                            {{ item.plugin }}: {{ item.error }}
                        </span>
                    </div>
                    <div v-if="!plugins.length" class="plugins-empty">
                        <div class="plugins-empty-orb">⚙</div>
                        <strong>No plugins found</strong>
                        <span>
                            Drop a plugin folder into ~/.xml-agent/plugins (plugin.json + index.js),
                            then press Reload.
                        </span>
                    </div>
                    <!-- 插件声明的面板：宿主渲染，插件不下发任何可执行代码 -->
                    <PluginPanels />
                    <!-- 密钥：只显示键名与长度，写入后不可回读 -->
                    <section
                        class="plugin-card secrets-card"
                        :class="{ 'is-open': isOpen(SECRETS_KEY) }"
                    >
                        <header class="plugin-card-header">
                            <button
                                type="button"
                                class="plugin-card-toggle"
                                :aria-expanded="isOpen(SECRETS_KEY) ? 'true' : 'false'"
                                @click="toggleCard(SECRETS_KEY)"
                            >
                                <span class="plugin-chevron" aria-hidden="true"></span>
                                <span class="plugin-title">
                                    <code class="plugin-name">secrets</code>
                                    <span class="plugin-badge">{{ secrets.length }} key(s)</span>
                                    <span class="plugin-badge">host</span>
                                </span>
                            </button>
                        </header>
                        <div v-show="isOpen(SECRETS_KEY)" class="plugin-card-body">
                            <p class="plugin-description">
                                Stored in ~/.xml-agent/secrets.json. Values are write-only here —
                                plugins read them through ctx.secrets when they declare the
                                secrets:read permission.
                            </p>
                            <div class="plugin-row plugin-config-row">
                                <span class="plugin-row-label">Keys</span>
                                <div class="plugin-fields">
                                    <div
                                        v-for="secret in secrets"
                                        :key="secret.key"
                                        class="plugin-field secret-row"
                                    >
                                        <code class="secret-key">{{ secret.key }}</code>
                                        <span class="secret-meta">{{ secret.length }} chars</span>
                                        <button
                                            type="button"
                                            class="btn secret-delete"
                                            :disabled="busy"
                                            @click="removeSecret(secret.key)"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                    <p v-if="!secrets.length" class="plugin-row-none">
                                        No secrets stored
                                    </p>
                                    <label class="plugin-field">
                                        <span class="plugin-field-label">Add / replace</span>
                                        <input
                                            v-model="newSecretKey"
                                            type="text"
                                            placeholder="API_KEY"
                                            spellcheck="false"
                                            :disabled="busy"
                                        />
                                        <input
                                            v-model="newSecretValue"
                                            type="password"
                                            placeholder="value"
                                            :disabled="busy"
                                            @keyup.enter="addSecret"
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        class="btn"
                                        :disabled="busy || !newSecretKey.trim() || !newSecretValue"
                                        @click="addSecret"
                                    >
                                        Save secret
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>
                    <article
                        v-for="plugin in plugins"
                        :key="plugin.name"
                        class="plugin-card"
                        :class="{
                            'is-error': plugin.status === 'error',
                            'is-off': !plugin.enabled,
                            'is-open': isOpen(plugin.name),
                        }"
                    >
                        <header class="plugin-card-header">
                            <button
                                type="button"
                                class="plugin-card-toggle"
                                :aria-expanded="isOpen(plugin.name) ? 'true' : 'false'"
                                @click="toggleCard(plugin.name)"
                            >
                                <span class="plugin-chevron" aria-hidden="true"></span>
                                <span class="plugin-title">
                                    <code class="plugin-name">{{ plugin.name }}</code>
                                    <span class="plugin-badge">v{{ plugin.version }}</span>
                                    <span class="plugin-badge">{{ plugin.kind }}</span>
                                    <span class="plugin-badge" :class="'source-' + plugin.source">
                                        {{ plugin.source }}
                                    </span>
                                    <span class="plugin-badge" :class="'state-' + plugin.status">
                                        {{ plugin.status }}
                                    </span>
                                    <!-- 收起时用一行摘要替代展开后的明细 -->
                                    <span v-if="!isOpen(plugin.name)" class="plugin-meta">
                                        {{ metaOf(plugin) }}
                                    </span>
                                </span>
                            </button>
                            <label class="plugin-toggle">
                                <input
                                    type="checkbox"
                                    :checked="plugin.enabled"
                                    :disabled="busy"
                                    @change="toggleEnabled(plugin, $event)"
                                />
                                <span>{{ plugin.enabled ? "Enabled" : "Disabled" }}</span>
                            </label>
                        </header>
                        <p v-if="plugin.error" class="plugin-card-error">{{ plugin.error }}</p>
                        <div v-show="isOpen(plugin.name)" class="plugin-card-body">
                            <p v-if="plugin.description" class="plugin-description">
                                {{ plugin.description }}
                            </p>
                            <div v-if="plugin.actions.length" class="plugin-row">
                                <span class="plugin-row-label">Actions</span>
                                <div class="plugin-chips">
                                    <code
                                        v-for="name in plugin.actions"
                                        :key="name"
                                        class="plugin-chip"
                                    >
                                        &lt;{{ name }}/&gt;
                                    </code>
                                </div>
                            </div>
                            <div v-if="plugin.effectivePermissions.length" class="plugin-row">
                                <span class="plugin-row-label">Permissions</span>
                                <div class="plugin-permissions">
                                    <div
                                        v-for="permission in plugin.effectivePermissions"
                                        :key="permission.scope"
                                        class="plugin-permission"
                                    >
                                        <code>{{ permission.scope }}</code>
                                        <select
                                            :value="permission.policy"
                                            :disabled="busy"
                                            :aria-label="'Policy for ' + permission.scope"
                                            @change="changePolicy(permission.scope, $event)"
                                        >
                                            <option value="allow">allow</option>
                                            <option value="ask">ask</option>
                                            <option value="deny">deny</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            <div v-else class="plugin-row">
                                <span class="plugin-row-label">Permissions</span>
                                <span class="plugin-row-none">None requested</span>
                            </div>
                            <div v-if="hasConfig(plugin)" class="plugin-row plugin-config-row">
                                <span class="plugin-row-label">Configuration</span>
                                <div class="plugin-fields">
                                    <label
                                        v-for="field in configFields(plugin)"
                                        :key="field.key"
                                        class="plugin-field"
                                    >
                                        <span class="plugin-field-label">{{ field.key }}</span>
                                        <input
                                            v-if="field.type === 'boolean'"
                                            v-model="drafts[plugin.name][field.key]"
                                            type="checkbox"
                                            :disabled="busy"
                                        />
                                        <input
                                            v-else-if="
                                                field.type === 'integer' || field.type === 'number'
                                            "
                                            v-model="drafts[plugin.name][field.key]"
                                            type="number"
                                            :disabled="busy"
                                        />
                                        <textarea
                                            v-else-if="field.type === 'array'"
                                            v-model="drafts[plugin.name][field.key]"
                                            rows="2"
                                            spellcheck="false"
                                            :disabled="busy"
                                        ></textarea>
                                        <input
                                            v-else
                                            v-model="drafts[plugin.name][field.key]"
                                            type="text"
                                            :disabled="busy"
                                        />
                                        <span v-if="field.description" class="plugin-field-hint">
                                            {{ field.description }}
                                        </span>
                                    </label>
                                    <button
                                        type="button"
                                        class="btn"
                                        :disabled="busy"
                                        @click="saveConfig(plugin)"
                                    >
                                        Save configuration
                                    </button>
                                </div>
                            </div>
                        </div>
                    </article>
                    <p class="plugins-hint">
                        Plugins are Node.js code running with the same privileges as the host. Only
                        install plugins you trust. Permissions here override the defaults (builtin
                        plugins declare `allow`, user plugins start as `ask`).
                    </p>
                </template>
            </div>
        </section>
    </div>
</template>

<script setup>
    import { computed, onMounted, reactive, ref } from "vue";
    import PluginPanels from "./PluginPanels.vue";
    import { useCollapse } from "../services/collapse-state.js";
    import {
        deleteSecret,
        getPlugins,
        getSecrets,
        grantPermission,
        reloadPlugins,
        savePluginConfig,
        saveSecret,
        setPluginEnabled,
    } from "../services/agent-api.js";

    defineEmits(["close"]);

    // 折叠状态：按卡片名存，secrets 卡片用保留键
    const SECRETS_KEY = "__secrets__";
    const COLLAPSE_STORAGE_KEY = "xml-agent.plugins.collapsed";

    const plugins = ref([]);
    const enabled = ref(true);
    const loadErrors = ref([]);
    const secrets = ref([]);
    const newSecretKey = ref("");
    const newSecretValue = ref("");
    const isLoading = ref(true);
    const busy = ref(false);
    const notice = ref("");
    const errorMessage = ref("");
    // 每个插件的配置草稿：值统一存成"输入框友好"的字符串/布尔
    const drafts = reactive({});
    // 卡片默认收起（插件通常有四五个，全展开要滑好几屏），展开过的记进 localStorage
    const {
        isOpen,
        toggle: toggleCard,
        toggleAll,
        allOpen,
        restore: restoreCollapsed,
    } = useCollapse(COLLAPSE_STORAGE_KEY, () =>
        [SECRETS_KEY].concat(plugins.value.map((plugin) => plugin.name))
    );

    let noticeTimer = null;

    // 收起时显示的一行摘要，免得为了看一眼有几个动作就得展开
    function metaOf(plugin) {
        const parts = [];
        const actions = plugin.actions ? plugin.actions.length : 0;
        if (actions) {
            parts.push(actions + " action(s)");
        }
        const permissions = plugin.effectivePermissions ? plugin.effectivePermissions.length : 0;
        if (permissions) {
            parts.push(permissions + " permission(s)");
        }
        if (hasConfig(plugin)) {
            parts.push("config");
        }
        return parts.join(" · ");
    }

    const summary = computed(() => {
        if (!enabled.value) {
            return "Disabled by configuration";
        }
        const total = plugins.value.length;
        const loaded = plugins.value.filter((plugin) => plugin.status === "loaded").length;
        const actions = plugins.value.reduce(
            (sum, plugin) => sum + (plugin.actions ? plugin.actions.length : 0),
            0
        );
        if (total === 0) {
            return "No plugins installed";
        }
        return loaded + "/" + total + " loaded · " + actions + " action(s)";
    });

    function showNotice(text) {
        notice.value = text;
        if (noticeTimer) {
            clearTimeout(noticeTimer);
        }
        noticeTimer = setTimeout(() => {
            notice.value = "";
        }, 2600);
    }

    function configFields(plugin) {
        const schema = plugin.configSchema || {};
        return Object.keys(schema).map((key) => ({
            key: key,
            type: (schema[key] && schema[key].type) || "string",
            description: (schema[key] && schema[key].description) || "",
        }));
    }

    function hasConfig(plugin) {
        return configFields(plugin).length > 0;
    }

    function buildDraft(plugin) {
        const draft = {};
        const schema = plugin.configSchema || {};
        const config = plugin.config || {};
        for (const key of Object.keys(schema)) {
            const type = (schema[key] && schema[key].type) || "string";
            const value = config[key];
            if (type === "array") {
                draft[key] = Array.isArray(value) ? value.join(", ") : "";
            } else if (type === "boolean") {
                draft[key] = value === true;
            } else {
                draft[key] = value === undefined || value === null ? "" : String(value);
            }
        }
        return draft;
    }

    function serializeDraft(plugin) {
        const draft = drafts[plugin.name] || {};
        const schema = plugin.configSchema || {};
        const config = {};
        for (const key of Object.keys(schema)) {
            const type = (schema[key] && schema[key].type) || "string";
            const raw = draft[key];
            if (type === "array") {
                config[key] = String(raw === undefined || raw === null ? "" : raw)
                    .split(/[,\n]/)
                    .map((item) => item.trim())
                    .filter(Boolean);
            } else if (type === "boolean") {
                config[key] = raw === true;
            } else if (type === "integer" || type === "number") {
                const number = Number(raw);
                if (Number.isFinite(number) && String(raw).trim() !== "") {
                    config[key] = number;
                }
            } else {
                config[key] = String(raw === undefined || raw === null ? "" : raw);
            }
        }
        return config;
    }

    async function load(message) {
        isLoading.value = true;
        errorMessage.value = "";
        try {
            const data = await getPlugins();
            enabled.value = data.enabled !== false;
            plugins.value = Array.isArray(data.plugins) ? data.plugins : [];
            loadErrors.value = Array.isArray(data.errors) ? data.errors : [];
            // 密钥列表挂在插件系统上，但读失败不该让整个面板打不开
            try {
                secrets.value = await getSecrets();
            } catch (error) {
                secrets.value = [];
            }
            for (const plugin of plugins.value) {
                drafts[plugin.name] = buildDraft(plugin);
            }
            if (message) {
                showNotice(message);
            }
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            isLoading.value = false;
        }
    }

    async function runAction(fn, message) {
        if (busy.value) {
            return;
        }
        busy.value = true;
        errorMessage.value = "";
        try {
            await fn();
            await load(message);
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            busy.value = false;
        }
    }

    function reload() {
        runAction(() => reloadPlugins(), "Plugins reloaded");
    }

    function toggleEnabled(plugin, event) {
        const next = event.target.checked;
        runAction(
            () => setPluginEnabled(plugin.name, next),
            plugin.name + (next ? " enabled" : " disabled")
        );
    }

    function changePolicy(scope, event) {
        const policy = event.target.value;
        runAction(() => grantPermission(scope, policy), scope + " → " + policy);
    }

    function saveConfig(plugin) {
        runAction(
            () => savePluginConfig(plugin.name, serializeDraft(plugin)),
            plugin.name + " configuration saved"
        );
    }

    function addSecret() {
        const key = newSecretKey.value.trim();
        if (!key || !newSecretValue.value) {
            return;
        }
        runAction(
            async () => {
                secrets.value = await saveSecret(key, newSecretValue.value);
                newSecretKey.value = "";
                newSecretValue.value = "";
            },
            "Secret " + key + " saved"
        );
    }

    function removeSecret(key) {
        runAction(
            async () => {
                secrets.value = await deleteSecret(key);
            },
            "Secret " + key + " deleted"
        );
    }

    onMounted(() => {
        restoreCollapsed();
        load();
    });
</script>

<style scoped>
    .plugins-mask {
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
    .plugins-panel {
        display: flex;
        width: min(920px, 100%);
        height: min(820px, calc(100vh - 48px));
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--c-border-strong);
        border-radius: 14px;
        background: var(--c-card-bg);
        box-shadow:
            0 24px 70px var(--c-shadow-strong),
            0 0 0 1px rgb(255 255 255 / 2%);
    }
    .plugins-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--c-border);
        background: var(--c-elevated-bg);
    }
    .plugins-heading {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 12px;
    }
    .plugins-icon {
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
    .plugins-heading strong {
        display: block;
        color: var(--c-text-strong);
        font-size: 14px;
        font-weight: 650;
    }
    .plugins-heading span {
        display: block;
        margin-top: 3px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .plugins-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .plugins-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 18px 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .plugins-loading {
        padding: 40px 0;
        color: var(--c-text-muted);
        font-size: 12px;
        text-align: center;
    }
    .plugins-notice,
    .plugins-alert {
        padding: 9px 12px;
        border: 1px solid var(--c-border-strong);
        border-radius: 8px;
        background: var(--c-raised-bg);
        font-size: 12px;
    }
    .plugins-notice {
        border-color: var(--c-success);
        color: var(--c-success-text);
    }
    .plugins-alert {
        border-color: var(--c-danger);
        color: var(--c-danger-text);
    }
    .plugins-warning {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        border: 1px solid var(--c-required-border);
        border-radius: 8px;
        background: var(--c-required-bg);
        color: var(--c-warning-text);
        font-size: 12px;
    }
    .plugins-load-error {
        color: var(--c-danger-text);
    }
    .plugins-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 48px 0;
        color: var(--c-text-muted);
        font-size: 12px;
        text-align: center;
    }
    .plugins-empty-orb {
        font-size: 26px;
        opacity: 0.5;
    }
    .plugins-empty strong {
        color: var(--c-text-soft);
        font-size: 13px;
    }
    .plugin-card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px 16px;
        border: 1px solid var(--c-border);
        border-radius: 11px;
        background: var(--c-panel-bg);
    }
    .plugin-card.is-error {
        border-color: var(--c-danger);
    }
    .plugin-card.is-off {
        opacity: 0.66;
    }
    .plugin-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    /* 头部整块是折叠按钮：点名字/徽标都能展开收起，右侧开关单独可点 */
    .plugin-card-toggle {
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
    .plugin-card-toggle:focus-visible {
        outline: 2px solid var(--c-accent-blue);
        outline-offset: 3px;
        border-radius: 5px;
    }
    /* 字体里的 ▸ 在这个字族下只有 2px，改用 border 画实心三角，大小与颜色都可控 */
    .plugin-chevron {
        flex: 0 0 auto;
        width: 0;
        height: 0;
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
        border-left: 5px solid var(--c-text-muted);
        transition: transform 120ms ease;
    }
    .plugin-card.is-open .plugin-chevron {
        transform: rotate(90deg);
    }
    .plugin-meta {
        color: var(--c-text-dim);
        font-size: 10px;
        white-space: nowrap;
    }
    .plugin-card-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .plugin-title {
        display: flex;
        min-width: 0;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
    }
    .plugin-name {
        color: var(--c-text-strong);
        font-size: 13px;
        font-weight: 650;
    }
    .plugin-badge {
        padding: 1px 7px;
        border: 1px solid var(--c-border-strong);
        border-radius: 999px;
        color: var(--c-badge-text);
        font-size: 10px;
        letter-spacing: 0.02em;
        text-transform: lowercase;
    }
    .plugin-badge.source-builtin {
        border-color: var(--c-accent-blue);
        color: var(--c-accent);
    }
    .plugin-badge.state-loaded {
        border-color: var(--c-success);
        color: var(--c-success-text);
    }
    .plugin-badge.state-disabled {
        color: var(--c-text-muted);
    }
    .plugin-badge.state-error {
        border-color: var(--c-danger);
        color: var(--c-danger-text);
    }
    .plugin-toggle {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 6px;
        color: var(--c-text-soft);
        font-size: 11px;
        cursor: pointer;
        user-select: none;
    }
    .plugin-toggle input {
        accent-color: var(--c-accent-blue);
    }
    .plugin-description {
        margin: 0;
        color: var(--c-text-body);
        font-size: 12px;
        line-height: 1.55;
    }
    .plugin-card-error {
        margin: 0;
        padding: 7px 10px;
        border: 1px solid var(--c-danger);
        border-radius: 7px;
        background: rgb(248 81 73 / 8%);
        color: var(--c-danger-text);
        font-size: 11px;
        line-height: 1.5;
    }
    .plugin-row {
        display: flex;
        align-items: flex-start;
        gap: 10px;
    }
    .plugin-row-label {
        flex: 0 0 92px;
        padding-top: 3px;
        color: var(--c-text-dim);
        font-size: 11px;
        letter-spacing: 0.02em;
        text-transform: uppercase;
    }
    .plugin-row-none {
        padding-top: 3px;
        color: var(--c-text-dim);
        font-size: 11px;
    }
    .plugin-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    .plugin-chip {
        padding: 2px 7px;
        border: 1px solid var(--c-border-strong);
        border-radius: 6px;
        background: var(--c-input-bg-soft);
        color: var(--c-code);
        font-size: 11px;
    }
    .plugin-permissions {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .plugin-permission {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .plugin-permission code {
        color: var(--c-code);
        font-size: 11px;
    }
    .plugin-permission select {
        padding: 3px 6px;
        border: 1px solid var(--c-border-input);
        border-radius: 6px;
        background: var(--c-input-bg);
        color: var(--c-text);
        font-size: 11px;
    }
    .plugin-config-row {
        align-items: flex-start;
    }
    .plugin-fields {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 10px;
    }
    .plugin-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .plugin-field-label {
        color: var(--c-text-soft);
        font-size: 11px;
    }
    .plugin-field input[type="text"],
    .plugin-field input[type="number"],
    .plugin-field input[type="password"],
    .plugin-field textarea {
        width: 100%;
        padding: 6px 9px;
        border: 1px solid var(--c-border-input);
        border-radius: 7px;
        background: var(--c-input-bg);
        color: var(--c-text);
        font-family: var(--mono, ui-monospace, monospace);
        font-size: 11px;
        resize: vertical;
    }
    .plugin-field input[type="checkbox"] {
        align-self: flex-start;
        accent-color: var(--c-accent-blue);
    }
    .plugin-field-hint {
        color: var(--c-text-dim);
        font-size: 10px;
        line-height: 1.5;
    }
    .plugin-fields > .btn {
        align-self: flex-start;
    }
    .secret-row {
        flex-direction: row;
        align-items: center;
        gap: 10px;
    }
    .secret-key {
        color: var(--c-code);
        font-size: 11px;
    }
    .secret-meta {
        color: var(--c-text-dim);
        font-size: 10px;
    }
    .secret-delete {
        margin-left: auto;
    }
    .plugins-hint {
        margin: 4px 0 0;
        color: var(--c-text-dim);
        font-size: 11px;
        line-height: 1.6;
    }
</style>
