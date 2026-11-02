/**
Plugin Registry

职责（对应 docs/PLUGIN_DESIGN.md §4.6）：
1. 发现：扫描 plugins/builtin/* 与 ~/.xml-agent/plugins/*；
2. 校验：plugin.json、apiVersion、engines、权限声明、动作名冲突；
3. 加载：调用 setup(ctx)，收集注册项（staging），成功后才提交到全局目录；
4. 隔离：单个插件失败只标记 status:"error"，不影响其它插件与内置动作；
5. 执行：权限检查 → schema 校验 → 超时/取消 → run() → afterRun → 调用记录；
6. 持久化：plugins-state.json（启停）、plugins-config.json（配置）、permissions.json（授权）。

本模块不 require runtime / agent-core / xml-parse，避免循环依赖；
Runtime 在调用时把 workspace 与 resolvePath 通过 host 参数传进来。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const sdk = require("./sdk");
const capabilities = require("./capabilities");

const BUILTIN_DIR = path.join(__dirname, "builtin");
const DEFAULT_STORE_ROOT = path.join(os.homedir(), ".xml-agent");
const STATE_FILE = "plugins-state.json";
const CONFIG_FILE = "plugins-config.json";
const PERMISSIONS_FILE = "permissions.json";
const SECRETS_FILE = "secrets.json";
const DEFAULT_MAX_PROMPT_CHARS = 8000;
const VALID_POLICIES = ["allow", "deny", "ask"];

function readPackageVersion() {
    try {
        // eslint-disable-next-line global-require
        return require("../package.json").version || "0.0.0";
    } catch (error) {
        return "0.0.0";
    }
}

function createScopedLogger(logger, pluginName) {
    const prefix = "[plugin:" + pluginName + "]";
    const base = logger || console;
    return {
        debug: (...args) => {
            if (typeof base.debug === "function") {
                base.debug(prefix, ...args);
            }
        },
        info: (...args) => {
            if (typeof base.info === "function") {
                base.info(prefix, ...args);
            }
        },
        warn: (...args) => {
            if (typeof base.warn === "function") {
                base.warn(prefix, ...args);
            }
        },
        error: (...args) => {
            if (typeof base.error === "function") {
                base.error(prefix, ...args);
            }
        },
    };
}

/**
执行 run() 并强制超时。超时会 abort signal，让插件有机会清理（fetch 会销毁请求）。
*/
function runWithTimeout(factory, timeoutMs, controller) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            const error = sdk.createError("PLUGIN_TIMEOUT", "插件动作超时（" + timeoutMs + "ms）");
            try {
                controller.abort(error);
            } catch (abortError) {
                // ignore
            }
            reject(error);
        }, timeoutMs);
        if (typeof timer.unref === "function") {
            timer.unref();
        }
        Promise.resolve()
            .then(factory)
            .then(
                (value) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            );
    });
}

class PluginRegistry {
    constructor(options = {}) {
        this.storeRoot = options.storeRoot || DEFAULT_STORE_ROOT;
        this.builtinDir = options.builtinDir || BUILTIN_DIR;
        this.extraDirs = Array.isArray(options.dirs) ? options.dirs.filter(Boolean) : [];
        this.agentVersion = options.agentVersion || readPackageVersion();
        this.enabled = options.enabled !== false;
        this.logger = options.logger || console;
        this.maxPromptChars =
            Number.isFinite(Number(options.maxPromptChars)) && Number(options.maxPromptChars) > 0
                ? Math.trunc(Number(options.maxPromptChars))
                : DEFAULT_MAX_PROMPT_CHARS;
        this.loaded = false;
        this.plugins = new Map();
        this.actions = new Map();
        this.hooks = new Map();
        this.providers = new Map();
        this.eventFormatters = new Map();
        this.ui = { panels: [], settings: [], actions: [] };
        this.errors = [];
    }

    // --------------------------------------------------------
    // 路径与持久化
    // --------------------------------------------------------

    get userDirs() {
        return [path.join(this.storeRoot, "plugins")].concat(this.extraDirs);
    }

    _storePath(name) {
        return path.join(this.storeRoot, name);
    }

    _readJsonFile(filePath, fallback) {
        try {
            if (!fs.existsSync(filePath)) {
                return fallback;
            }
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return fallback;
            }
            return parsed;
        } catch (error) {
            this.logger.warn?.("[plugins] 读取失败 " + filePath + "：" + error.message);
            return fallback;
        }
    }

    _writeJsonFile(filePath, value) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tempPath = filePath + ".tmp";
        fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
        fs.renameSync(tempPath, filePath);
    }

    _readState() {
        return this._readJsonFile(this._storePath(STATE_FILE), {});
    }

    _writeState(state) {
        this._writeJsonFile(this._storePath(STATE_FILE), state);
    }

    _readConfigStore() {
        return this._readJsonFile(this._storePath(CONFIG_FILE), {});
    }

    _writeConfigStore(store) {
        this._writeJsonFile(this._storePath(CONFIG_FILE), store);
    }

    _readPermissions() {
        return this._readJsonFile(this._storePath(PERMISSIONS_FILE), {});
    }

    _writePermissions(value) {
        this._writeJsonFile(this._storePath(PERMISSIONS_FILE), value);
    }

    _secretsFile() {
        return this._storePath(SECRETS_FILE);
    }

    _storageDir(pluginName) {
        return path.join(this.storeRoot, "plugins", pluginName, "data");
    }

    // --------------------------------------------------------
    // 加载
    // --------------------------------------------------------

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
    }

    reload() {
        if (!this.enabled) {
            this._resetCatalogs();
            this.loaded = true;
            return this;
        }
        this.loaded = false;
        this._resetCatalogs();
        return this.load();
    }

    _resetCatalogs() {
        this.plugins.clear();
        this.actions.clear();
        this.hooks.clear();
        this.providers.clear();
        this.eventFormatters.clear();
        this.ui = { panels: [], settings: [], actions: [] };
        this.errors.length = 0;
    }

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
    }

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
    }

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
    }

    _createSetupContext(record, staging) {
        const self = this;
        const plugin = {
            name: record.name,
            version: record.version,
            kind: record.kind,
            dir: record.dir,
            source: record.source,
        };
        return {
            plugin,
            config: this.getConfig(record.name),
            logger: createScopedLogger(this.logger, record.name),
            storage: capabilities.createStorage({ dir: this._storageDir(record.name) }),
            secrets: capabilities.createSecrets({ file: this._secretsFile() }),
            env: { agentVersion: this.agentVersion, storeRoot: this.storeRoot },
            actions: {
                register(def) {
                    staging.actions.push(sdk.defineAction(def, { plugin: record.name }));
                },
            },
            hooks: {
                on(event, handler) {
                    const name = String(event || "").trim();
                    if (!name) {
                        throw sdk.createError("HOOK_INVALID", "hooks.on(event) 的 event 不能为空");
                    }
                    if (typeof handler !== "function") {
                        throw sdk.createError("HOOK_INVALID", "hooks.on(" + name + ") 需要函数");
                    }
                    staging.hooks.push({ event: name, handler });
                },
            },
            eventFormatters: {
                register(type, formatter) {
                    const name = String(type || "").trim();
                    if (!name) {
                        throw sdk.createError(
                            "FORMATTER_INVALID",
                            "eventFormatters 的 type 不能为空"
                        );
                    }
                    if (typeof formatter !== "function") {
                        throw sdk.createError("FORMATTER_INVALID", name + " 的格式器需要函数");
                    }
                    staging.formatters.push({ type: name, formatter });
                },
            },
            providers: {
                register(name, factory, meta) {
                    staging.providers.push({
                        name: String(name || ""),
                        factory,
                        meta: meta || {},
                    });
                },
            },
            ui: {
                registerPanel: (panel) => staging.ui.push({ kind: "panel", value: panel }),
                registerSettings: (item) => staging.ui.push({ kind: "settings", value: item }),
                registerComposerAction: (item) => staging.ui.push({ kind: "action", value: item }),
            },
            /**
            声明式面板要读数据，就要有接口。插件只能注册到自己命名空间下：
            ctx.api.get("/summary", handler) → GET /api/plugins/<name>/api/summary
            */
            api: {
                register: (method, routePath, handler) =>
                    staging.api.push(
                        sdk.normalizeApiRoute(method, routePath, handler, { plugin: record.name })
                    ),
                get: (routePath, handler) =>
                    staging.api.push(
                        sdk.normalizeApiRoute("GET", routePath, handler, { plugin: record.name })
                    ),
                post: (routePath, handler) =>
                    staging.api.push(
                        sdk.normalizeApiRoute("POST", routePath, handler, { plugin: record.name })
                    ),
                put: (routePath, handler) =>
                    staging.api.push(
                        sdk.normalizeApiRoute("PUT", routePath, handler, { plugin: record.name })
                    ),
                delete: (routePath, handler) =>
                    staging.api.push(
                        sdk.normalizeApiRoute("DELETE", routePath, handler, { plugin: record.name })
                    ),
            },
            permissions: {
                policy: (scope) => self.getPolicy(scope, record),
                check: (scope) => self.getPolicy(scope, record) === "allow",
            },
            // setup 期不提供 fs / http：能力只在动作执行期、且在权限校验之后下发
        };
    }

    _createRunContext({ record, entry, host, attrs, signal }) {
        const config = this.getConfig(record.name);
        const secrets = capabilities.createSecrets({ file: this._secretsFile() });
        const secretValues = secrets.getAll();
        const workspace = host.workspace || "";
        return {
            plugin: {
                name: record.name,
                version: record.version,
                kind: record.kind,
                source: record.source,
            },
            action: entry.name,
            attrs,
            workspace,
            signal,
            config,
            fs: capabilities.createWorkspaceFs({
                workspace,
                resolvePath: host.resolvePath,
            }),
            http: capabilities.createHttpClient({
                allowHosts: Array.isArray(config.allowHosts) ? config.allowHosts : [],
                defaultTimeoutMs: config.httpTimeoutMs,
                maxBytes: config.httpMaxBytes,
            }),
            storage: capabilities.createStorage({ dir: this._storageDir(record.name) }),
            secrets: {
                get: (key) => {
                    const name = String(key || "");
                    return Object.prototype.hasOwnProperty.call(secretValues, name)
                        ? secretValues[name]
                        : null;
                },
                getAll: () => Object.assign({}, secretValues),
            },
            logger: createScopedLogger(this.logger, record.name),
            permissions: {
                policy: (scope) => this.getPolicy(scope, record),
                check: (scope) => this.getPolicy(scope, record) === "allow",
                granted: entry.def.meta.permission.slice(),
            },
            events: {
                emit: (type, payload) => this.emitHook(String(type), payload || {}),
            },
            redact: (text) => capabilities.redactSecrets(text, secretValues),
            host: { execScope: host.execScope || "workspace" },
        };
    }

    // --------------------------------------------------------
    // 查询
    // --------------------------------------------------------

    listPlugins() {
        this.load();
        return Array.from(this.plugins.values());
    }

    listLoaded() {
        return this.listPlugins().filter((record) => record.status === "loaded");
    }

    getPlugin(name) {
        this.load();
        return this.plugins.get(String(name || "")) || null;
    }

    hasAction(name) {
        this.load();
        return this.actions.has(String(name || ""));
    }

    getActionDefinition(name) {
        this.load();
        const entry = this.actions.get(String(name || ""));
        return entry ? entry.def : null;
    }

    getActionPluginName(name) {
        this.load();
        const entry = this.actions.get(String(name || ""));
        return entry ? entry.plugin : null;
    }

    getFastPaths() {
        this.load();
        const result = [];
        for (const entry of this.actions.values()) {
            if (entry.def.meta.fastPath) {
                result.push({ action: entry.name, parse: entry.def.meta.fastPath });
            }
        }
        return result;
    }

    validateAction(name, node) {
        const entry = this.actions.get(String(name || ""));
        if (!entry) {
            return { ok: false, error: "Unknown action: " + name };
        }
        const attrs = sdk.normalizeAttrs(entry.def, node);
        if (!attrs.ok) {
            return attrs;
        }
        if (entry.def.validate) {
            try {
                entry.def.validate(node);
            } catch (error) {
                return { ok: false, error: error.message };
            }
        }
        return { ok: true };
    }

    /**
    模型提示词用的插件动作清单。task 用于 activation=keywords 的按需激活。
    */
    listPromptContributions(options = {}) {
        this.load();
        const task = String(options.task || "").toLowerCase();
        const result = [];
        for (const entry of this.actions.values()) {
            const record = this.plugins.get(entry.plugin);
            if (!record || record.status !== "loaded" || !record.enabled) {
                continue;
            }
            if (record.manifest.deprecated) {
                continue;
            }
            const activation = record.manifest.activation || { mode: "always" };
            if (activation.mode === "manual") {
                continue;
            }
            if (activation.mode === "keywords") {
                const matched = activation.keywords.some((keyword) =>
                    task.includes(String(keyword).toLowerCase())
                );
                if (!matched) {
                    continue;
                }
            }
            const prompt = entry.def.meta.prompt;
            result.push({
                plugin: entry.plugin,
                action: entry.name,
                group: prompt.group,
                usage: prompt.usage,
                note: prompt.note,
                priority: prompt.priority,
            });
        }
        return result;
    }

    formatEvent(type, event) {
        const entry = this.eventFormatters.get(String(type || ""));
        if (!entry) {
            return null;
        }
        try {
            const text = entry.formatter(event);
            return typeof text === "string" ? text : null;
        } catch (error) {
            this.logger.warn?.(
                "[plugins] 事件格式器 " +
                    type +
                    "（" +
                    entry.plugin +
                    "）执行失败：" +
                    error.message
            );
            return null;
        }
    }

    getStatus() {
        this.load();
        const result = [];
        for (const record of this.plugins.values()) {
            result.push({
                name: record.name,
                version: record.version,
                kind: record.kind,
                source: record.source,
                description: record.manifest.description,
                status: record.status,
                enabled: record.enabled,
                error: record.error,
                dir: record.dir,
                permissions: record.manifest.permissions.slice(),
                effectivePermissions: record.manifest.permissions.map((scope) => ({
                    scope,
                    policy: this.getPolicy(scope, record),
                })),
                actions: record.actions.slice(),
                hooks: record.hooks.slice(),
                apiRoutes: (record.apiRoutes || []).map((item) => item.method + " " + item.path),
                uiErrors: (record.uiErrors || []).slice(),
                config: this.getConfig(record.name),
                configSchema: record.manifest.configSchema,
            });
        }
        return result;
    }

    getUiManifest() {
        this.load();
        const isLoaded = (pluginName) => {
            const record = this.plugins.get(pluginName);
            return Boolean(record && record.status === "loaded");
        };
        return {
            panels: this.ui.panels
                .filter((item) => isLoaded(item.plugin))
                .map((item) =>
                    Object.assign({}, item.panel, {
                        plugin: item.plugin,
                        // 面板里的 path 都是相对这个前缀的
                        basePath: "/api/plugins/" + item.plugin + "/api",
                    })
                ),
            settings: this.ui.settings
                .filter((item) => isLoaded(item.plugin))
                .map((item) => Object.assign({ plugin: item.plugin }, item.settings)),
            actions: this.ui.actions
                .filter((item) => isLoaded(item.plugin))
                .map((item) => Object.assign({ plugin: item.plugin }, item.action)),
        };
    }

    /**
    调用插件注册的 HTTP 接口（声明式面板的数据来源）。
    路由层已把路径限定在 /api/plugins/<name>/api 之下，这里仍按 method + path 精确匹配注册表，
    因此外部路径不可能被穿越到别的插件的接口。
    */
    async callPluginApi(name, method, subPath, options = {}) {
        this.load();
        const record = this.plugins.get(String(name || ""));
        if (!record || record.status !== "loaded") {
            return { status: 404, body: { error: "Plugin API not found: " + name } };
        }
        const verb = String(method || "GET").toUpperCase();
        const pathText = String(subPath || "/") || "/";
        const route = record.apiRoutes.filter(
            (item) => item.method === verb && item.path === pathText
        )[0];
        if (!route) {
            return {
                status: 404,
                body: {
                    error: "Plugin API not found: " + verb + " " + pathText,
                    plugin: record.name,
                },
            };
        }
        const ctx = {
            plugin: {
                name: record.name,
                version: record.version,
                kind: record.kind,
                source: record.source,
            },
            method: verb,
            path: pathText,
            query: options.query || {},
            body: options.body,
            config: this.getConfig(record.name),
            logger: createScopedLogger(this.logger, record.name),
            storage: capabilities.createStorage({ dir: this._storageDir(record.name) }),
        };
        try {
            const result = await route.handler(ctx);
            return { status: 200, body: result === undefined ? {} : result };
        } catch (error) {
            const message = (error && error.message) || String(error);
            this.logger.warn?.(
                "[plugins] " +
                    record.name +
                    " 的接口 " +
                    verb +
                    " " +
                    pathText +
                    " 执行失败：" +
                    message
            );
            return { status: 500, body: { error: message, plugin: record.name } };
        }
    }

    // --------------------------------------------------------
    // 配置与权限
    // --------------------------------------------------------

    getConfig(name) {
        const record = this.plugins.get(String(name || ""));
        if (!record) {
            return {};
        }
        const stored = this._readConfigStore()[record.name] || {};
        return sdk.normalizeConfig(record.manifest, stored).value;
    }

    setConfig(name, patch) {
        const record = this.plugins.get(String(name || ""));
        if (!record) {
            throw sdk.createError("PLUGIN_NOT_FOUND", "未知插件：" + name);
        }
        const store = this._readConfigStore();
        const merged = Object.assign({}, store[record.name] || {}, patch || {});
        const normalized = sdk.normalizeConfig(record.manifest, merged);
        if (!normalized.ok) {
            throw sdk.createError(
                "CONFIG_INVALID",
                "配置校验失败：" + normalized.errors.join("; ")
            );
        }
        store[record.name] = normalized.value;
        this._writeConfigStore(store);
        return normalized.value;
    }

    setEnabled(name, enabled) {
        const record = this.getPlugin(name);
        if (!record) {
            throw sdk.createError("PLUGIN_NOT_FOUND", "未知插件：" + name);
        }
        const state = this._readState();
        state[record.name] = Object.assign({}, state[record.name], {
            enabled: enabled !== false,
            updatedAt: new Date().toISOString(),
        });
        this._writeState(state);
        this.reload();
        const updated = this.getPlugin(name);
        return updated
            ? this.getStatus().filter((item) => item.name === updated.name)[0] || null
            : null;
    }

    /**
    权限策略优先级：用户显式授权 > 内置插件默认 allow > 其它（用户插件）默认 ask。
    "ask" 在 v1 表示"未授权，拒绝执行并提示用户去授权"，不做挂起阻塞式确认。
    */
    getPolicy(scope, record) {
        const name = String(scope || "");
        const file = this._readPermissions();
        if (typeof file[name] === "string" && VALID_POLICIES.indexOf(file[name]) !== -1) {
            return file[name];
        }
        if (record && record.source === "builtin") {
            return "allow";
        }
        return "ask";
    }

    getPermissions() {
        const file = this._readPermissions();
        const policy = {};
        for (const scope of sdk.PERMISSION_SCOPES) {
            policy[scope] = typeof file[scope] === "string" ? file[scope] : null;
        }
        return { scopes: sdk.PERMISSION_SCOPES.slice(), policy };
    }

    grantPermission(scope, policy) {
        const name = String(scope || "");
        if (sdk.PERMISSION_SCOPES.indexOf(name) === -1) {
            throw sdk.createError("PERMISSION_UNKNOWN", "未知权限 scope：" + name);
        }
        const value = String(policy || "allow");
        if (VALID_POLICIES.indexOf(value) === -1) {
            throw sdk.createError("PERMISSION_INVALID", "策略必须是 " + VALID_POLICIES.join(" / "));
        }
        const file = this._readPermissions();
        file[name] = value;
        this._writePermissions(file);
        return this.getPermissions();
    }

    // --------------------------------------------------------
    // 执行与钩子
    // --------------------------------------------------------

    /**
    调用一个插件动作。host 由 Runtime 传入：
    { workspace, resolvePath(target), execScope }
    返回值与内置动作保持一致：{ ok, action, error? , ... }，并附带 plugin / durationMs。
    */
    async invokeAction(name, node, host = {}) {
        this.load();
        const entry = this.actions.get(String(name || ""));
        if (!entry) {
            throw new Error("Unknown action: " + name);
        }
        const record = this.plugins.get(entry.plugin);
        if (!record || record.status !== "loaded") {
            return {
                ok: false,
                action: entry.name,
                plugin: entry.plugin,
                error: "插件 " + entry.plugin + " 未处于已加载状态",
            };
        }

        const denied = this._deniedPermission(entry, record);
        if (denied) {
            this.emitHook("action.denied", {
                action: entry.name,
                plugin: entry.plugin,
                scope: denied.scope,
                policy: denied.policy,
                reason: denied.error,
            });
            return {
                ok: false,
                action: entry.name,
                plugin: entry.plugin,
                permission: denied.scope,
                error: denied.error,
            };
        }

        const attrsResult = sdk.normalizeAttrs(entry.def, node);
        if (!attrsResult.ok) {
            return {
                ok: false,
                action: entry.name,
                plugin: entry.plugin,
                error: attrsResult.error,
            };
        }
        if (entry.def.validate) {
            try {
                entry.def.validate(node);
            } catch (error) {
                return {
                    ok: false,
                    action: entry.name,
                    plugin: entry.plugin,
                    error: error.message,
                };
            }
        }

        const controller = new AbortController();
        const startedAt = Date.now();
        const ctx = this._createRunContext({
            record,
            entry,
            host,
            attrs: attrsResult.value,
            signal: controller.signal,
        });

        let result;
        try {
            result = await runWithTimeout(
                () => entry.def.run(node, ctx),
                entry.def.meta.timeoutMs,
                controller
            );
        } catch (error) {
            result = {
                ok: false,
                error: (error && error.message) || String(error),
                timedOut: Boolean(error && error.code === "PLUGIN_TIMEOUT"),
            };
        }

        if (!result || typeof result !== "object" || Array.isArray(result)) {
            result = { ok: false, error: "插件返回了非法结果（必须是对象）" };
        }
        if (!result.action) {
            result.action = entry.name;
        }

        if (entry.def.meta.afterRun && result.ok) {
            try {
                const next = await entry.def.meta.afterRun(result, ctx);
                if (next && typeof next === "object" && !Array.isArray(next)) {
                    result = next;
                    if (!result.action) {
                        result.action = entry.name;
                    }
                }
            } catch (error) {
                result.afterRunError = (error && error.message) || String(error);
            }
        }

        result.plugin = record.name;
        result.durationMs = Date.now() - startedAt;

        // 给模型看的精简视图（可选）。完整结果仍保留在 Trace / 报告里，
        // 只有回给模型的下一轮提示词使用这个视图，避免大响应体撑爆上下文。
        if (entry.def.meta.promptResult) {
            try {
                const view = entry.def.meta.promptResult(result);
                if (view && typeof view === "object" && !Array.isArray(view)) {
                    result.promptView = view;
                }
            } catch (error) {
                // 视图生成失败不影响动作结果本身
            }
        }

        return result;
    }

    _deniedPermission(entry, record) {
        for (const scope of entry.def.meta.permission) {
            if (record.manifest.permissions.indexOf(scope) === -1) {
                return {
                    scope,
                    policy: "deny",
                    error: "插件 " + record.name + " 未在清单声明权限 " + scope,
                };
            }
            const policy = this.getPolicy(scope, record);
            if (policy !== "allow") {
                return {
                    scope,
                    policy,
                    error:
                        "permission denied: " +
                        scope +
                        (policy === "ask"
                            ? "（未授权，可在 Plugins 设置中授权 " + scope + "）"
                            : "（已被权限策略禁止）"),
                };
            }
        }
        return null;
    }

    /**
    触发钩子。单个 handler 抛错或普通 Promise 拒绝都不会影响其它 handler 与主流程。
    */
    emitHook(event, payload = {}) {
        const handlers = this.hooks.get(String(event || ""));
        if (!handlers || handlers.length === 0) {
            return 0;
        }
        let count = 0;
        for (const item of handlers) {
            try {
                const returned = item.handler(payload);
                if (returned && typeof returned.then === "function") {
                    returned.catch((error) => {
                        this.logger.warn?.(
                            "[plugins] hook " +
                                event +
                                "（" +
                                item.plugin +
                                "）异步失败：" +
                                ((error && error.message) || error)
                        );
                    });
                }
                count += 1;
            } catch (error) {
                this.logger.warn?.(
                    "[plugins] hook " +
                        event +
                        "（" +
                        item.plugin +
                        "）失败：" +
                        ((error && error.message) || error)
                );
            }
        }
        return count;
    }
}

// ------------------------------------------------------------
// 单例
// ------------------------------------------------------------

let singleton = null;

function defaultOptions() {
    let pluginConfig = {};
    try {
        // eslint-disable-next-line global-require
        pluginConfig = require("../config/agent-config").plugins || {};
    } catch (error) {
        pluginConfig = {};
    }
    const env = process.env;
    let enabled = pluginConfig.enabled !== false;
    if (env.XML_AGENT_PLUGINS !== undefined) {
        enabled =
            ["0", "false", "off", "no"].indexOf(String(env.XML_AGENT_PLUGINS).toLowerCase()) === -1;
    }
    const dirs = [];
    if (Array.isArray(pluginConfig.dirs)) {
        dirs.push(...pluginConfig.dirs.filter(Boolean));
    }
    if (env.XML_AGENT_PLUGIN_DIRS) {
        dirs.push(
            ...String(env.XML_AGENT_PLUGIN_DIRS)
                .split(path.delimiter)
                .map((item) => item.trim())
                .filter(Boolean)
        );
    }
    return {
        enabled,
        storeRoot: pluginConfig.storeRoot || DEFAULT_STORE_ROOT,
        dirs,
        maxPromptChars: pluginConfig.maxPromptChars,
    };
}

function createRegistry(options = {}) {
    return new PluginRegistry(options);
}

function getRegistry() {
    if (!singleton) {
        const registry = createRegistry(defaultOptions());
        registry.load();
        singleton = registry;
    }
    return singleton;
}

/**
安全取单例：插件系统出任何意外都不能让 Agent 主流程崩掉。
*/
function getRegistrySafe() {
    try {
        return getRegistry();
    } catch (error) {
        if (typeof console !== "undefined" && console.warn) {
            console.warn("[plugins] registry 初始化失败：" + ((error && error.message) || error));
        }
        return null;
    }
}

function resetRegistry() {
    singleton = null;
}

function setRegistryForTests(registry) {
    singleton = registry;
}

module.exports = {
    PluginRegistry,
    createRegistry,
    getRegistry,
    getRegistrySafe,
    resetRegistry,
    setRegistryForTests,
    defaultOptions,
    BUILTIN_DIR,
    DEFAULT_STORE_ROOT,
    DEFAULT_MAX_PROMPT_CHARS,
    STATE_FILE,
    CONFIG_FILE,
    PERMISSIONS_FILE,
    SECRETS_FILE,
    VALID_POLICIES,
};
