/**
setup 与 run 两个上下文的装配。能力（fs / http / storage / secrets）只在这里下发。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const sdk = require("../sdk");
const capabilities = require("../capabilities");

const { createScopedLogger } = require("./shared");

module.exports = {
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
            storage: capabilities.createStorage({ dir: this.storageDir(record.name) }),
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
    },

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
            storage: capabilities.createStorage({ dir: this.storageDir(record.name) }),
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
    },
};
