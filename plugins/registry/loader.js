/**
插件加载管线：发现 → 校验 → setup → 整体提交。
单个插件失败只标记 status:"error"，不影响其它插件。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const fs = require("fs");
const path = require("path");

const sdk = require("../sdk");

module.exports = {
    load() {
        if (this.loaded) {
            return this;
        }
        this.loaded = true;
        this._resetCatalogs();
        if (!this.enabled) {
            this.logger.warn?.(
                "[plugins] 已禁用（XML_AGENT_PLUGINS=0）：用户插件与内置插件（fetch / screenshot / " +
                    "audit-log）都不会加载 —— screenshot 自 v1.1.0 起是内置插件，因此截图能力也不可用"
            );
            return this;
        }
        const startedAt = Date.now();
        this._loadFromDir(this.builtinDir, "builtin");
        for (const dir of this.userDirs) {
            this._loadFromDir(dir, "user");
        }
        this.logger.info?.(
            "[plugins] 加载完成：" +
                this.listLoaded().length +
                " 个插件 / " +
                this.actions.size +
                " 个动作 / " +
                (Date.now() - startedAt) +
                "ms"
        );
        this.emitHook("plugins.loaded", { plugins: this.getStatus() });
        return this;
    },

    reload() {
        if (!this.enabled) {
            this._resetCatalogs();
            this.loaded = true;
            return this;
        }
        this.loaded = false;
        this._resetCatalogs();
        return this.load();
    },

    _resetCatalogs() {
        this.plugins.clear();
        this.actions.clear();
        this.hooks.clear();
        this.providers.clear();
        this.eventFormatters.clear();
        this.ui = { panels: [], settings: [], actions: [] };
        this.errors.length = 0;
    },

    _loadFromDir(dir, source) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            // 目录不存在是正常情况（用户可能一个插件都没装）
            return;
        }
        const names = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => name.charAt(0) !== "." && name !== "node_modules")
            .sort();
        for (const name of names) {
            this._loadPlugin(path.join(dir, name), source);
        }
    },

    _loadPlugin(pluginDir, source) {
        let record = null;
        try {
            const manifestPath = path.join(pluginDir, "plugin.json");
            if (!fs.existsSync(manifestPath)) {
                throw sdk.createError("MANIFEST_MISSING", "缺少 plugin.json");
            }
            let raw;
            try {
                raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            } catch (error) {
                throw sdk.createError(
                    "MANIFEST_INVALID",
                    "plugin.json 不是合法 JSON：" + error.message
                );
            }
            const manifest = sdk.normalizeManifest(raw, { label: manifestPath });
            if (this.plugins.has(manifest.name)) {
                throw sdk.createError("DUPLICATE_PLUGIN", "插件名重复：" + manifest.name);
            }

            // 先落一个占位记录，再检查版本：这样"版本不兼容"的插件在
            // /api/plugins 里是可见的 error 状态，而不是凭空消失。
            record = {
                name: manifest.name,
                version: manifest.version,
                kind: manifest.kind,
                manifest,
                dir: pluginDir,
                source,
                status: "error",
                error: null,
                enabled: true,
                actions: [],
                hooks: [],
                formatters: [],
                apiRoutes: [],
                // 声明式面板非法时只跳过该面板并记录原因，不让整个插件失效
                uiErrors: [],
            };
            this.plugins.set(manifest.name, record);

            if (manifest.apiVersion !== sdk.API_VERSION) {
                throw sdk.createError(
                    "API_VERSION_MISMATCH",
                    "插件 apiVersion=" + manifest.apiVersion + "，宿主支持 " + sdk.API_VERSION
                );
            }
            if (!sdk.satisfiesEngines(manifest.engines.xmlAgent, this.agentVersion)) {
                throw sdk.createError(
                    "ENGINE_MISMATCH",
                    "插件要求 xmlAgent " +
                        manifest.engines.xmlAgent +
                        "，当前版本 " +
                        this.agentVersion
                );
            }

            const state = this._readState();
            const saved = state[manifest.name];
            record.enabled =
                saved && saved.enabled !== undefined
                    ? saved.enabled !== false
                    : manifest.enabledByDefault;
            if (!record.enabled) {
                record.status = "disabled";
                return;
            }

            const indexPath = path.join(pluginDir, "index.js");
            if (!fs.existsSync(indexPath)) {
                throw sdk.createError("ENTRY_MISSING", "缺少 index.js");
            }
            // reload 时让插件入口重新执行（子模块可能仍被 require 缓存）
            const resolvedEntry = require.resolve(indexPath);
            delete require.cache[resolvedEntry];
            // eslint-disable-next-line global-require
            const pluginModule = require(resolvedEntry);
            if (!pluginModule || typeof pluginModule.setup !== "function") {
                throw sdk.createError("ENTRY_INVALID", "插件必须导出 { setup(ctx) }");
            }

            const staging = {
                actions: [],
                hooks: [],
                providers: [],
                formatters: [],
                ui: [],
                api: [],
            };
            pluginModule.setup(this._createSetupContext(record, staging));
            // 先整体校验，再整体提交：setup 中途抛错时不会留下半注册状态
            this._commit(record, staging);
            record.status = "loaded";
            this.logger.info?.(
                "[plugins] " +
                    record.name +
                    "@" +
                    record.version +
                    " (" +
                    record.source +
                    ") 已加载，贡献 " +
                    record.actions.length +
                    " 个动作"
            );
        } catch (error) {
            const message = (error && error.message) || String(error);
            this.errors.push({
                plugin: record ? record.name : path.basename(pluginDir),
                dir: pluginDir,
                error: message,
            });
            if (record) {
                record.status = "error";
                record.error = message;
            }
            this.logger.warn?.("[plugins] 加载失败 " + path.basename(pluginDir) + "：" + message);
        }
    },

    _commit(record, staging) {
        const problems = [];
        for (const def of staging.actions) {
            if (sdk.RESERVED_ACTION_NAMES.indexOf(def.name) !== -1) {
                problems.push("动作名 " + def.name + " 与内置动作冲突");
                continue;
            }
            if (this.actions.has(def.name)) {
                problems.push(
                    "动作名 " +
                        def.name +
                        " 已被插件 " +
                        this.actions.get(def.name).plugin +
                        " 占用"
                );
            }
            for (const scope of def.meta.permission) {
                if (record.manifest.permissions.indexOf(scope) === -1) {
                    problems.push("动作 " + def.name + " 申请了未在清单声明的权限 " + scope);
                }
            }
        }
        for (const item of staging.hooks) {
            if (typeof item.handler !== "function") {
                problems.push("hooks.on(" + item.event + ") 的 handler 不是函数");
            }
        }
        for (const item of staging.formatters) {
            if (this.eventFormatters.has(item.type)) {
                problems.push("事件格式器 " + item.type + " 已被占用");
            }
        }
        // 插件 HTTP 路由：同一插件内 method+path 不允许重复
        const seenRoutes = new Set();
        for (const route of staging.api) {
            const key = route.method + " " + route.path;
            if (seenRoutes.has(key)) {
                problems.push("插件接口重复注册：" + key);
                continue;
            }
            seenRoutes.add(key);
        }
        if (problems.length > 0) {
            throw sdk.createError("REGISTRATION_CONFLICT", problems.join("; "));
        }

        for (const def of staging.actions) {
            this.actions.set(def.name, { name: def.name, def, plugin: record.name });
            record.actions.push(def.name);
        }
        for (const item of staging.hooks) {
            if (!this.hooks.has(item.event)) {
                this.hooks.set(item.event, []);
            }
            this.hooks.get(item.event).push({ plugin: record.name, handler: item.handler });
            if (record.hooks.indexOf(item.event) === -1) {
                record.hooks.push(item.event);
            }
        }
        for (const item of staging.providers) {
            if (this.providers.has(item.name)) {
                continue;
            }
            this.providers.set(item.name, {
                name: item.name,
                factory: item.factory,
                meta: item.meta || {},
                plugin: record.name,
            });
        }
        for (const item of staging.formatters) {
            this.eventFormatters.set(item.type, { plugin: record.name, formatter: item.formatter });
            record.formatters.push(item.type);
        }
        for (const route of staging.api) {
            record.apiRoutes.push(route);
        }
        for (const item of staging.ui) {
            if (item.kind === "panel") {
                // 面板非法只记录并跳过，不影响该插件其它能力
                try {
                    const panel = sdk.normalizePanel(item.value, { plugin: record.name });
                    this.ui.panels.push({ plugin: record.name, panel });
                } catch (error) {
                    record.uiErrors.push(error.message);
                    this.logger.warn?.(
                        "[plugins] " + record.name + " 的声明式面板被跳过：" + error.message
                    );
                }
            } else if (item.kind === "settings") {
                this.ui.settings.push({ plugin: record.name, settings: item.value });
            } else if (item.kind === "action") {
                this.ui.actions.push({ plugin: record.name, action: item.value });
            }
        }
    },
};
