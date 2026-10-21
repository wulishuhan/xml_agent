<template>
    <div class="settings-mask" @click.self="$emit('close')">
        <section
            class="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
        >
            <header class="settings-header">
                <div class="settings-heading">
                    <div class="settings-icon">⚙</div>
                    <div>
                        <strong id="settings-title">{{
                            isElectron ? "Desktop Settings" : "Browser Settings"
                        }}</strong>
                        <span>Choose which browser the agent drives via CDP</span>
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
            <div v-if="loading" class="settings-loading">Loading...</div>
            <div v-else class="settings-body">
                <div class="settings-field">
                    <label>Browser</label>
                    <div class="settings-segmented" role="radiogroup" aria-label="Browser">
                        <button
                            type="button"
                            class="segmented-option"
                            :class="{ active: browserType === 'chrome' }"
                            role="radio"
                            :aria-checked="browserType === 'chrome'"
                            @click="selectBrowserType('chrome')"
                        >
                            <span class="segmented-title">Google Chrome</span>
                            <span class="segmented-sub">{{
                                chromeAvailable ? "detected" : "not found"
                            }}</span>
                        </button>
                        <button
                            type="button"
                            class="segmented-option"
                            :class="{ active: browserType === 'edge' }"
                            role="radio"
                            :aria-checked="browserType === 'edge'"
                            @click="selectBrowserType('edge')"
                        >
                            <span class="segmented-title">Microsoft Edge</span>
                            <span class="segmented-sub">{{
                                edgeAvailable ? "detected" : "not found"
                            }}</span>
                        </button>
                    </div>
                    <div class="settings-hint">
                        Both Chrome and Edge are Chromium-based and expose the same CDP endpoint.
                        The agent will drive the browser you select here.
                    </div>
                </div>
                <div class="settings-field">
                    <label>{{ browserLabel }} executable path</label>
                    <div class="settings-row">
                        <input
                            v-model="chromePath"
                            type="text"
                            :placeholder="'Leave empty to auto-detect ' + browserLabel"
                        />
                        <button v-if="isElectron" type="button" class="btn" @click="pickBrowser">
                            Browse
                        </button>
                    </div>
                    <div class="settings-hint">
                        <span v-if="chromePath"
                            >Using custom path: <code>{{ chromePath }}</code></span
                        >
                        <span v-else-if="detectedBrowser"
                            >Auto-detected: <code>{{ detectedBrowser }}</code></span
                        >
                        <span v-else>Not found automatically. Please set the path manually.</span>
                    </div>
                </div>
                <div class="settings-field">
                    <label>{{ browserLabel }} CDP URL</label>
                    <input v-model="currentCdpUrl" type="text" :placeholder="cdpPlaceholder" />
                    <div class="settings-hint">
                        {{ browserLabel }} DevTools Protocol endpoint. Each browser uses its own
                        port so switching between Chrome and Edge won't conflict.
                    </div>
                </div>
                <div class="settings-field settings-field-inline">
                    <label>
                        <input v-model="autoStartChrome" type="checkbox" /> Auto-start
                        {{ browserLabel }} with remote debugging on launch
                    </label>
                </div>
                <div class="settings-field settings-field-inline">
                    <label>
                        <input v-model="headless" type="checkbox" /> Run {{ browserLabel }} in
                        headless mode (no visible window)
                    </label>
                    <div class="settings-hint">
                        Leave unchecked to see the browser window. Headless mode is useful for
                        unattended runs but makes it harder to log in to providers.
                    </div>
                </div>
                <div v-if="isElectron" class="settings-field settings-field-inline">
                    <label>
                        <input v-model="focusCdpPage" type="checkbox" /> Bring the launched CDP tab
                        to the foreground
                    </label>
                    <div class="settings-hint">
                        When enabled, the agent will switch focus to the provider tab it uses.
                        Uncheck to keep the current window focus.
                    </div>
                </div>
                <div class="settings-status">
                    <div><strong>Selected browser:</strong> {{ browserLabel }}</div>
                    <div><strong>CDP running:</strong> {{ cdpRunning ? "yes" : "no" }}</div>
                    <div>
                        <strong>Connected browser:</strong>
                        {{ connectedBrowser || (cdpRunning ? "unknown" : "none") }}
                        <span v-if="cdpRunning && typeMatches === false" class="settings-warn">
                            (different from selected)
                        </span>
                    </div>
                    <div>
                        <strong>{{ browserLabel }} path:</strong>
                        {{ chromePath || detectedBrowser || "auto" }}
                    </div>
                    <div v-if="settingsPath">
                        <strong>Settings file:</strong> <code>{{ settingsPath }}</code>
                    </div>
                </div>
                <div v-if="message" class="settings-message">{{ message }}</div>
            </div>
            <footer class="settings-footer">
                <button type="button" class="btn" @click="refreshStatus">Refresh status</button>
                <button type="button" class="btn" :disabled="switching" @click="switchBrowserNow">
                    {{ switching ? "Switching..." : "Switch to " + browserLabel + " now" }}
                </button>
                <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
                    {{ saving ? "Saving..." : "Save" }}
                </button>
            </footer>
        </section>
    </div>
</template>
<script setup>
    import { computed, onMounted, ref } from "vue";
    import {
        getBrowserSettings,
        saveBrowserSettings,
        detectBrowser,
        getBrowserStatus,
        switchBrowser as apiSwitchBrowser,
    } from "../services/agent-api.js";
    const emit = defineEmits(["close", "saved"]);
    const desktop = typeof window !== "undefined" ? window.xmlAgentDesktop : null;
    const isElectron = !!(desktop && desktop.isElectron);
    const DEFAULT_CDP_URLS = {
        chrome: "http://127.0.0.1:9222",
        edge: "http://127.0.0.1:9223",
    };
    const loading = ref(true);
    const saving = ref(false);
    const switching = ref(false);
    const browserType = ref("chrome");
    const chromePath = ref("");
    const cdpUrls = ref({
        chrome: DEFAULT_CDP_URLS.chrome,
        edge: DEFAULT_CDP_URLS.edge,
    });
    const autoStartChrome = ref(true);
    const headless = ref(false);
    const focusCdpPage = ref(true);
    const detectedBrowser = ref("");
    const chromeAvailable = ref(false);
    const edgeAvailable = ref(false);
    const cdpRunning = ref(false);
    const connectedBrowser = ref("");
    const typeMatches = ref(null);
    const settingsPath = ref("");
    const message = ref("");
    const browserLabel = computed(() => (browserType.value === "edge" ? "Edge" : "Chrome"));
    const cdpPlaceholder = computed(() => DEFAULT_CDP_URLS[browserType.value]);
    const currentCdpUrl = computed({
        get() {
            return cdpUrls.value[browserType.value] || DEFAULT_CDP_URLS[browserType.value];
        },
        set(value) {
            cdpUrls.value = Object.assign({}, cdpUrls.value, {
                [browserType.value]: value,
            });
        },
    });
    function normalizeBrowserType(value) {
        const text = String(value || "")
            .trim()
            .toLowerCase();
        return text === "edge" ? "edge" : "chrome";
    }
    // ---- 统一后端适配：Electron 用 IPC，Web 用 HTTP ----
    const backend = {
        async readSettings() {
            if (isElectron) {
                return desktop.settings.read();
            }
            return getBrowserSettings();
        },
        async writeSettings(payload) {
            if (isElectron) {
                return desktop.settings.write(payload);
            }
            return saveBrowserSettings(payload);
        },
        async detect(browserTypeValue) {
            if (isElectron) {
                const api = desktop.browser || desktop.chrome;
                return api.detect(browserTypeValue);
            }
            return detectBrowser(browserTypeValue);
        },
        async status() {
            if (isElectron) {
                const api = desktop.browser || desktop.chrome;
                return api.status();
            }
            return getBrowserStatus();
        },
        async switchBrowser(browserTypeValue) {
            if (isElectron) {
                const api = desktop.browser || desktop.chrome;
                if (api && typeof api.switch === "function") {
                    return api.switch(browserTypeValue);
                }
                return { message: "Browser switching is not supported in this build." };
            }
            return apiSwitchBrowser(browserTypeValue);
        },
        async pickFile() {
            if (isElectron && desktop.browser && desktop.browser.pickFile) {
                return desktop.browser.pickFile();
            }
            return "";
        },
    };
    async function detectAvailability() {
        try {
            const [chromeResult, edgeResult] = await Promise.all([
                backend.detect("chrome"),
                backend.detect("edge"),
            ]);
            chromeAvailable.value = !!(chromeResult && chromeResult.found);
            edgeAvailable.value = !!(edgeResult && edgeResult.found);
        } catch (error) {
            // 忽略探测失败，仅影响界面提示
        }
    }
    async function load() {
        try {
            const settings = await backend.readSettings();
            browserType.value = normalizeBrowserType(settings.browserType);
            chromePath.value = settings.chromePath || "";
            const incomingUrls = settings.cdpUrls || {};
            cdpUrls.value = {
                chrome: incomingUrls.chrome || settings.cdpUrl || DEFAULT_CDP_URLS.chrome,
                edge: incomingUrls.edge || DEFAULT_CDP_URLS.edge,
            };
            autoStartChrome.value = settings.autoStartChrome !== false;
            headless.value = settings.headless === true;
            if (typeof settings.focusCdpPage !== "undefined") {
                focusCdpPage.value = settings.focusCdpPage !== false;
            }
            if (isElectron && desktop.settings && desktop.settings.path) {
                try {
                    settingsPath.value = (await desktop.settings.path()) || "";
                } catch (error) {
                    settingsPath.value = "";
                }
            }
            await detectAvailability();
            try {
                const status = await backend.status();
                applyStatus(status);
            } catch (error) {
                // 状态获取失败不影响设置读取
            }
        } catch (error) {
            message.value = error.message;
        } finally {
            loading.value = false;
        }
    }
    function applyStatus(status) {
        if (!status) {
            return;
        }
        cdpRunning.value = status.cdpRunning === true;
        connectedBrowser.value = status.connectedBrowser || "";
        if (typeof status.typeMatches === "boolean") {
            typeMatches.value = status.typeMatches;
        }
        const path = status.browserPath || status.chromePath || "";
        detectedBrowser.value = path;
    }
    function buildSettingsPayload() {
        const urls = {
            chrome: (cdpUrls.value.chrome || DEFAULT_CDP_URLS.chrome).trim(),
            edge: (cdpUrls.value.edge || DEFAULT_CDP_URLS.edge).trim(),
        };
        return {
            browserType: browserType.value,
            chromePath: chromePath.value.trim(),
            cdpUrls: urls,
            cdpUrl: urls[browserType.value],
            autoStartChrome: autoStartChrome.value === true,
            headless: headless.value === true,
            focusCdpPage: focusCdpPage.value === true,
        };
    }
    async function selectBrowserType(nextType) {
        const next = normalizeBrowserType(nextType);
        if (browserType.value === next) {
            return;
        }
        browserType.value = next;
        try {
            const result = await backend.detect(next);
            detectedBrowser.value = (result && result.found) || "";
            chromePath.value = "";
            if (cdpRunning.value && typeMatches.value === false) {
                message.value =
                    "Selected " +
                    (next === "edge" ? "Edge" : "Chrome") +
                    '. Click "Switch to ' +
                    (next === "edge" ? "Edge" : "Chrome") +
                    ' now" to close the current browser and start the selected one.';
            } else {
                message.value = "Selected " + (next === "edge" ? "Edge" : "Chrome") + ".";
            }
        } catch (error) {
            message.value = error.message;
        }
    }
    async function refreshStatus() {
        try {
            const status = await backend.status();
            applyStatus(status);
            message.value = "Status refreshed.";
        } catch (error) {
            message.value = error.message;
        }
    }
    async function pickBrowser() {
        try {
            const picked = await backend.pickFile();
            if (picked) {
                chromePath.value = picked;
            }
        } catch (error) {
            message.value = error.message;
        }
    }
    async function switchBrowserNow() {
        switching.value = true;
        message.value = "Switching to " + browserLabel.value + "...";
        try {
            // 先保存选择，保证后续 session 使用新浏览器
            const saved = await backend.writeSettings(buildSettingsPayload());
            if (saved && saved.browserType) {
                browserType.value = normalizeBrowserType(saved.browserType);
            }
            const result = await backend.switchBrowser(browserType.value);
            message.value = (result && result.message) || "Switched.";
            try {
                const status = await backend.status();
                applyStatus(status);
            } catch (error) {
                // ignore
            }
            emit("saved");
        } catch (error) {
            message.value = error.message;
        } finally {
            switching.value = false;
        }
    }
    async function save() {
        saving.value = true;
        message.value = "";
        try {
            const previous = await backend.readSettings();
            const previousType = normalizeBrowserType(previous.browserType);
            await backend.writeSettings(buildSettingsPayload());
            const nextType = browserType.value;
            if (cdpRunning.value && previousType !== nextType) {
                message.value =
                    "Saved. The running CDP browser is still " +
                    (connectedBrowser.value || "the previous one") +
                    ". To use " +
                    browserLabel.value +
                    ', click "Switch to ' +
                    browserLabel.value +
                    ' now".';
            } else {
                message.value = "Saved. New sessions will use " + browserLabel.value + ".";
            }
            emit("saved");
        } catch (error) {
            message.value = error.message;
        } finally {
            saving.value = false;
        }
    }
    onMounted(load);
</script>
<style scoped>
    .settings-mask {
        position: fixed;
        z-index: 1100;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--c-backdrop);
        backdrop-filter: blur(5px);
    }
    .settings-panel {
        display: flex;
        width: min(680px, 100%);
        max-height: min(760px, calc(100vh - 48px));
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--c-border-strong);
        border-radius: 14px;
        background: var(--c-card-bg);
        box-shadow:
            0 24px 70px var(--c-shadow-strong),
            0 0 0 1px rgb(255 255 255 / 2%);
    }
    .settings-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--c-border);
        background: var(--c-elevated-bg);
    }
    .settings-heading {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 12px;
    }
    .settings-icon {
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
    .settings-heading strong {
        display: block;
        color: var(--c-text-strong);
        font-size: 14px;
        font-weight: 650;
    }
    .settings-heading span {
        display: block;
        margin-top: 3px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .settings-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 18px 8px;
    }
    .settings-loading {
        padding: 24px;
        color: var(--c-text-muted);
        text-align: center;
    }
    .settings-field {
        margin-bottom: 18px;
    }
    .settings-field label {
        display: block;
        margin-bottom: 6px;
        color: var(--c-text-body);
        font-size: 12px;
        font-weight: 600;
    }
    .settings-field input[type="text"] {
        width: 100%;
        padding: 9px 11px;
        border: 1px solid var(--c-border-input);
        border-radius: 8px;
        background: var(--c-input-bg);
        color: var(--c-text);
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 12px;
        outline: none;
    }
    .settings-field input[type="text"]:focus {
        border-color: var(--c-accent-2);
    }
    .settings-segmented {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
    }
    .segmented-option {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 3px;
        padding: 9px 11px;
        border: 1px solid var(--c-border-input);
        border-radius: 8px;
        background: var(--c-input-bg);
        color: var(--c-text-muted);
        text-align: left;
        cursor: pointer;
        transition: all 0.15s ease;
    }
    .segmented-option:hover {
        background: var(--c-hover-bg);
    }
    .segmented-option.active {
        border-color: var(--c-accent-2);
        background: var(--c-elevated-bg);
        color: var(--c-text-strong);
        box-shadow: inset 0 0 0 1px var(--c-accent-2);
    }
    .segmented-title {
        font-size: 12px;
        font-weight: 650;
    }
    .segmented-sub {
        color: var(--c-text-faint);
        font-size: 10px;
    }
    .settings-row {
        display: flex;
        gap: 8px;
    }
    .settings-row input {
        flex: 1;
    }
    .settings-hint {
        margin-top: 6px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .settings-hint code {
        color: var(--c-code);
        font-family: "Cascadia Code", Consolas, monospace;
    }
    .settings-field-inline label {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--c-text-body);
        font-weight: 500;
    }
    .settings-field-inline .settings-hint {
        margin-left: 24px;
    }
    .settings-status {
        margin-top: 6px;
        padding: 10px 12px;
        border: 1px solid var(--c-border-soft);
        border-radius: 8px;
        background: var(--c-panel-bg);
        color: var(--c-text-muted);
        font-size: 11px;
        line-height: 1.7;
    }
    .settings-status code {
        color: var(--c-code);
        font-family: "Cascadia Code", Consolas, monospace;
    }
    .settings-warn {
        color: var(--c-accent-2);
        font-weight: 600;
    }
    .settings-message {
        margin-top: 10px;
        padding: 8px 10px;
        border: 1px solid var(--c-border-strong);
        border-radius: 8px;
        background: var(--c-elevated-bg);
        color: var(--c-text-body);
        font-size: 11px;
        white-space: pre-wrap;
    }
    .settings-footer {
        display: flex;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--c-border-soft);
        background: var(--c-panel-bg);
    }
    .settings-footer .btn-primary {
        margin-left: auto;
    }
    .icon-button {
        width: 32px;
        height: 32px;
        border: 1px solid var(--c-border-strong);
        border-radius: 8px;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
    }
    .icon-button:hover {
        background: var(--c-hover-bg);
    }
</style>
