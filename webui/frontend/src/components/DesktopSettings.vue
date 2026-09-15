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
                        <strong id="settings-title">Desktop Settings</strong>
                        <span>Chrome / CDP configuration for this computer</span>
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
                    <label>Chrome executable path</label>
                    <div class="settings-row">
                        <input
                            v-model="chromePath"
                            type="text"
                            placeholder="Leave empty to auto-detect Chrome on this machine"
                        />
                        <button type="button" class="btn" @click="pickChrome">Browse</button>
                    </div>
                    <div class="settings-hint">
                        <span v-if="detectedChrome"
                            >Detected: <code>{{ detectedChrome }}</code></span
                        >
                        <span v-else>Not found automatically. Please set the path manually.</span>
                    </div>
                </div>
                <div class="settings-field">
                    <label>CDP URL</label>
                    <input v-model="cdpUrl" type="text" placeholder="http://127.0.0.1:9222" />
                    <div class="settings-hint">
                        Chrome DevTools Protocol endpoint. Usually http://127.0.0.1:9222
                    </div>
                </div>
                <div class="settings-field settings-field-inline">
                    <label>
                        <input v-model="autoStartChrome" type="checkbox" /> Auto-start Chrome with
                        remote debugging on launch
                    </label>
                </div>
                <div class="settings-status">
                    <div><strong>CDP running:</strong> {{ cdpRunning ? "yes" : "no" }}</div>
                    <div><strong>Chrome path:</strong> {{ chromePath || "auto" }}</div>
                    <div>
                        <strong>Settings file:</strong> <code>{{ settingsPath }}</code>
                    </div>
                </div>
                <div v-if="message" class="settings-message">{{ message }}</div>
            </div>
            <footer class="settings-footer">
                <button type="button" class="btn" @click="refreshStatus">Refresh status</button>
                <button type="button" class="btn" @click="launchChrome">Start Chrome now</button>
                <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
                    {{ saving ? "Saving..." : "Save" }}
                </button>
            </footer>
        </section>
    </div>
</template>
<script setup>
    import { onMounted, ref } from "vue";

    const emit = defineEmits(["close", "saved"]);

    const desktop = typeof window !== "undefined" ? window.xmlAgentDesktop : null;
    const isElectron = !!(desktop && desktop.isElectron);

    const loading = ref(true);
    const saving = ref(false);
    const chromePath = ref("");
    const cdpUrl = ref("http://127.0.0.1:9222");
    const autoStartChrome = ref(true);
    const detectedChrome = ref("");
    const cdpRunning = ref(false);
    const settingsPath = ref("");
    const message = ref("");

    async function load() {
        if (!isElectron) {
            loading.value = false;
            message.value = "This panel is only available in the desktop app.";
            return;
        }

        try {
            const [settings, status, path] = await Promise.all([
                desktop.settings.read(),
                desktop.chrome.status(),
                desktop.settings.path(),
            ]);

            chromePath.value = settings.chromePath || "";
            cdpUrl.value = settings.cdpUrl || "http://127.0.0.1:9222";
            autoStartChrome.value = settings.autoStartChrome !== false;

            cdpRunning.value = status.cdpRunning === true;
            detectedChrome.value = status.chromePath || "";
            settingsPath.value = path || "";
        } catch (error) {
            message.value = error.message;
        } finally {
            loading.value = false;
        }
    }

    async function refreshStatus() {
        if (!isElectron) return;

        try {
            const status = await desktop.chrome.status();
            cdpRunning.value = status.cdpRunning === true;
            detectedChrome.value = status.chromePath || "";
            message.value = "Status refreshed.";
        } catch (error) {
            message.value = error.message;
        }
    }

    async function pickChrome() {
        if (!isElectron) return;

        try {
            const picked = await desktop.chrome.pickFile();

            if (picked) {
                chromePath.value = picked;
            }
        } catch (error) {
            message.value = error.message;
        }
    }

    async function launchChrome() {
        if (!isElectron) return;

        message.value = "Starting Chrome...";

        try {
            const result = await desktop.chrome.launch();
            message.value = result.message;

            const status = await desktop.chrome.status();
            cdpRunning.value = status.cdpRunning === true;
        } catch (error) {
            message.value = error.message;
        }
    }

    async function save() {
        if (!isElectron) return;

        saving.value = true;
        message.value = "";

        try {
            await desktop.settings.write({
                chromePath: chromePath.value.trim(),
                cdpUrl: cdpUrl.value.trim() || "http://127.0.0.1:9222",
                autoStartChrome: autoStartChrome.value === true,
            });

            message.value = "Saved. New sessions will use the updated settings.";
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
