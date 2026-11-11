/**
setup 与 run 两个上下文的装配。能力（fs / http / storage / secrets）只在这里下发。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const sdk = require("../sdk");
const capabilities = require("../capabilities");
const { createSessionMemory } = require("../session-memory");

const { createScopedLogger, createDigestWriter } = require("./shared");

/**
未授权时的密钥门面：形状与真的一样，但拿不到任何值。
插件作者可以在 setup 里用 ctx.permissions.check("secrets:read") 判断，
或者直接读 ctx.secrets.denied。
*/
function deniedSecretsFacade() {
    return {
        denied: true,
        get: () => null,
        getAll: () => ({}),
    };
}

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
            // 密钥属于能力，不是元数据：清单没声明 secrets:read 或策略未放行时
            // 一律下发空门面。否则插件在 setup 期就能读到全部密钥，绕过权限校验。
            secrets: this._secretsFor(record, this._canReadSecrets(record)),
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
            /**
            setup 期申请的资源（定时器、监听器、socket、子进程）在这里登记清理函数。
            reload / 卸载时按逆序执行，不登记就会每重载一次泄漏一份。
            */
            onDispose(handler) {
                if (typeof handler !== "function") {
                    throw sdk.createError("DISPOSE_INVALID", "onDispose 需要函数");
                }
                staging.disposers.push(handler);
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

    /**
    清单声明了 secrets:read 且策略放行，才算拿到密钥读取能力。
    setup 与 run 都用这一条判据，避免两条路径口径不一致。
    */
    _canReadSecrets(record) {
        if (!record || !record.manifest) {
            return false;
        }
        if (record.manifest.permissions.indexOf("secrets:read") === -1) {
            return false;
        }
        return this.getPolicy("secrets:read", record) === "allow";
    },

    /**
    密钥门面。未授权时返回空门面并告警一次：插件读到 null 会困惑，
    日志里必须说明"为什么是 null"，否则排查成本全落在使用者身上。
    */
    _secretsFor(record, granted) {
        if (granted) {
            return capabilities.createSecrets({ file: this._secretsFile() });
        }
        if (record && !record.secretsDeniedWarned) {
            record.secretsDeniedWarned = true;
            this.logger.warn?.(
                "[plugins] " +
                    (record.name || "?") +
                    " 读取密钥被拒：清单未声明 secrets:read 或权限策略未放行，已返回空值"
            );
        }
        return deniedSecretsFacade();
    },

    _createRunContext({ record, entry, host, attrs, signal }) {
        const config = this.getConfig(record.name);
        const secrets = capabilities.createSecrets({ file: this._secretsFile() });
        // 脱敏始终用全量密钥值（只是把字面量替换成 ***，不向插件暴露任何东西）
        const secretValues = secrets.getAll();
        // 能被插件读到值的，只有自己动作声明并通过权限校验的 secrets:read
        const canReadSecrets = entry.def.meta.permission.indexOf("secrets:read") !== -1;
        const workspace = host.workspace || "";
        const workspaceFs = capabilities.createWorkspaceFs({
            workspace,
            resolvePath: host.resolvePath,
        });
        // 摘要要落到工作区里才读得到，因此写入口也走同一份 fs 能力
        const canWriteWorkspace = entry.def.meta.permission.indexOf("workspace:write") !== -1;
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
            fs: workspaceFs,
            http: capabilities.createHttpClient({
                allowHosts: Array.isArray(config.allowHosts) ? config.allowHosts : [],
                defaultTimeoutMs: config.httpTimeoutMs,
                maxBytes: config.httpMaxBytes,
            }),
            storage: capabilities.createStorage({ dir: this.storageDir(record.name) }),
            // 会话记忆：动作声明了 sessions:* 才会拿到写权限（invoke 已先做过权限校验，
            // 能跑到这里说明清单声明与策略都通过了）
            sessions: createSessionMemory({
                manager: this.hostSessions,
                canRead: entry.def.meta.permission.indexOf("sessions:read") !== -1,
                canWrite: entry.def.meta.permission.indexOf("sessions:write") !== -1,
                maxRecords: config.maxOutputRecords,
                compress: config.compress,
                maxChars: config.maxChars,
                digest: config.digest,
                maxDigestChars: config.maxDigestChars,
                writeDigest: canWriteWorkspace
                    ? createDigestWriter({ workspace, workspaceFs })
                    : null,
                logger: createScopedLogger(this.logger, record.name),
            }),
            secrets: canReadSecrets
                ? {
                      get: (key) => {
                          const name = String(key || "");
                          return Object.prototype.hasOwnProperty.call(secretValues, name)
                              ? secretValues[name]
                              : null;
                      },
                      getAll: () => Object.assign({}, secretValues),
                  }
                : this._secretsFor(record, false),
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
