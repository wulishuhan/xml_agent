/**
插件加载管线：发现 → 校验 → setup → 整体提交。
单个插件失败只标记 status:"error"，不影响其它插件。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const fs = require("fs");
const path = require("path");

const sdk = require("../sdk");

/**
内置 provider 的 id 清单。延迟 require：providers/registry 反向依赖本模块，
模块加载期直接 require 会形成环。取不到就返回空数组（宁可少一道校验，也不要加载失败）。
*/
let cachedBuiltinProviderIds = null;

function builtinProviderIds() {
    if (cachedBuiltinProviderIds) {
        return cachedBuiltinProviderIds;
    }
    try {
        // eslint-disable-next-line global-require
        const registry = require("../../providers/registry");
        const ids = Array.isArray(registry.BUILTIN_PROVIDER_IDS)
            ? registry.BUILTIN_PROVIDER_IDS
            : [];
        cachedBuiltinProviderIds = ids.slice();
    } catch (error) {
        return [];
    }
    return cachedBuiltinProviderIds;
}

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

    /**
    显式卸载：先让每个插件跑完自己的清理，再清空目录表。
    单纯 reload 也会走到这里——插件注册的定时器、监听器、socket 必须由
    ctx.onDispose 或 module.exports.dispose 回收，否则每重载一次泄漏一份。

    卸载后保持 loaded=true：这样后续的查询不会又把插件全量扫回来。
    想要恢复能力，显式调用 reload()。
    */
    unload() {
        this._resetCatalogs();
        this.loaded = true;
        return this;
    },

    _resetCatalogs() {
        this._disposeAll();
        this.plugins.clear();
        this.actions.clear();
        this.hooks.clear();
        this.providers.clear();
        this.eventFormatters.clear();
        this.ui = { panels: [], settings: [], actions: [] };
        this.errors.length = 0;
    },

    /**
    收尾所有已加载插件。清理函数按注册的逆序执行（后申请的先释放），
    单个清理抛错只告警：重载不能因为一个插件的 bug 而中断。
    */
    _disposeAll() {
        for (const record of this.plugins.values()) {
            if (record.status !== "loaded") {
                continue;
            }
            this._disposeRecord(record);
            record.status = "disposed";
        }
    },

    _disposeRecord(record) {
        const disposers = Array.isArray(record.disposers) ? record.disposers.slice().reverse() : [];
        for (const disposer of disposers) {
            this._runDisposer(record, disposer, "注册的清理函数");
        }
        if (typeof record.moduleDispose === "function") {
            this._runDisposer(record, record.moduleDispose, "module.exports.dispose");
        }
        record.disposers = [];
    },

    _runDisposer(record, disposer, label) {
        try {
            const returned = disposer();
            if (returned && typeof returned.then === "function") {
                returned.catch((error) => {
                    this.logger.warn?.(
                        "[plugins] " +
                            record.name +
                            " 的 " +
                            label +
                            " 异步失败：" +
                            ((error && error.message) || error)
                    );
                });
            }
        } catch (error) {
            this.logger.warn?.(
                "[plugins] " +
                    record.name +
                    " 的 " +
                    label +
                    " 失败：" +
                    ((error && error.message) || error)
            );
        }
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
            .filter((entry) => {
                if (entry.isDirectory()) {
                    return true;
                }
                // 开发插件时常把目录软链到 ~/.xml-agent/plugins 下；
                // isDirectory() 对符号链接返回 false，不额外判断就会被静默忽略。
                if (!entry.isSymbolicLink()) {
                    return false;
                }
                try {
                    return fs.statSync(path.join(dir, entry.name)).isDirectory();
                } catch (error) {
                    return false;
                }
            })
            .map((entry) => entry.name)
            .filter((name) => name.charAt(0) !== "." && name !== "node_modules")
            .sort();
        for (const name of names) {
            this._loadPlugin(path.join(dir, name), source);
        }
    },

    _loadPlugin(pluginDir, source) {
        const dirName = path.basename(pluginDir);
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
            record = this._newRecord(manifest, pluginDir, source);
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
            // 重载时要让插件自己的代码重新执行：只删入口不够，被入口 require 的
            // 子模块会继续用旧代码（改了 lib/helper.js 却看不到变化）。
            this._purgeRequireCache(pluginDir);
            // eslint-disable-next-line global-require
            const pluginModule = require(require.resolve(indexPath));
            if (!pluginModule || typeof pluginModule.setup !== "function") {
                throw sdk.createError("ENTRY_INVALID", "插件必须导出 { setup(ctx) }");
            }
            record.moduleDispose =
                typeof pluginModule.dispose === "function" ? pluginModule.dispose : null;

            const staging = {
                actions: [],
                hooks: [],
                providers: [],
                formatters: [],
                ui: [],
                api: [],
                disposers: [],
            };
            pluginModule.setup(this._createSetupContext(record, staging));
            // setup 已经执行，注册的清理函数先挂到记录上：万一后面的冲突校验失败，
            // 这些资源也要立即释放，不能等到下次 reload。
            record.disposers = staging.disposers;
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
            if (record.manifest.deprecated) {
                // 设计里承诺"加载时告警"：动作仍可执行，但不会注入提示词
                this.logger.warn?.(
                    "[plugins] " +
                        record.name +
                        " 已标记 deprecated：动作不会注入提示词，建议尽快迁移"
                );
            }
        } catch (error) {
            const message = (error && error.message) || String(error);
            if (!record) {
                // 清单都没读出来（缺 plugin.json / JSON 坏了）：用目录名建一条占位记录。
                // 否则这个插件只在 errors 数组里出现，前端看不到、也无从修复。
                record = this._brokenRecord(dirName, pluginDir, source, message);
                if (!this.plugins.has(record.name)) {
                    this.plugins.set(record.name, record);
                }
            }
            this.errors.push({
                plugin: record.name,
                dir: pluginDir,
                error: message,
            });
            record.status = "error";
            record.error = message;
            this.logger.warn?.("[plugins] 加载失败 " + dirName + "：" + message);
        }
    },

    _newRecord(manifest, pluginDir, source) {
        return {
            name: manifest.name,
            version: manifest.version,
            kind: manifest.kind,
            manifest,
            dir: pluginDir,
            source,
            status: "error",
            error: null,
            enabled: true,
            broken: false,
            actions: [],
            hooks: [],
            formatters: [],
            apiRoutes: [],
            // 声明式面板非法时只跳过该面板并记录原因，不让整个插件失效
            uiErrors: [],
            disposers: [],
            moduleDispose: null,
        };
    },

    /**
    清单不可读时的占位记录：字段形状与正常记录一致，
    这样 getStatus / getConfig / setEnabled 都不会因为 manifest 缺失而抛错。
    */
    _brokenRecord(name, pluginDir, source, message) {
        const record = this._newRecord(sdk.brokenManifest(name), pluginDir, source);
        record.error = message;
        record.broken = true;
        return record;
    },

    /**
    清掉插件目录下所有模块的 require 缓存（含子模块）。
    只清 realpath 落在该目录里的键，不会碰到宿主自己的模块；
    Windows 路径大小写不敏感，比较时统一小写。
    */
    _purgeRequireCache(pluginDir) {
        let prefix = path.resolve(pluginDir) + path.sep;
        let ignoreCase = process.platform === "win32";
        if (ignoreCase) {
            prefix = prefix.toLowerCase();
        }
        for (const key of Object.keys(require.cache)) {
            const normalized = ignoreCase ? key.toLowerCase() : key;
            if (normalized.indexOf(prefix) === 0) {
                delete require.cache[key];
            }
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
        // 插件 provider：与内置 id 冲突、或与其它插件重名时，providers/registry 会静默丢弃，
        // 插件看起来加载成功但模型永远选不到它 —— 这里直接判失败，让问题在加载期暴露。
        const builtinProviders = builtinProviderIds();
        for (const item of staging.providers) {
            if (!sdk.PLUGIN_NAME_PATTERN.test(item.name)) {
                problems.push("provider id 非法：" + item.name + "（只允许小写字母/数字与 - _ .）");
                continue;
            }
            if (typeof item.factory !== "function") {
                problems.push("provider " + item.name + " 的 factory 不是函数");
                continue;
            }
            if (builtinProviders.indexOf(item.name) !== -1) {
                problems.push("provider id " + item.name + " 与内置 provider 冲突");
                continue;
            }
            if (this.providers.has(item.name)) {
                problems.push(
                    "provider id " +
                        item.name +
                        " 已被插件 " +
                        this.providers.get(item.name).plugin +
                        " 占用"
                );
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
            // 注册被拒 → 插件不会加载，setup 里申请的资源要当场释放
            this._disposeRecord(record);
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
