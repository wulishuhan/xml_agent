/**
插件自定义 HTTP 接口的分发与执行。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const capabilities = require("../capabilities");
const { createSessionMemory } = require("../session-memory");

const { createScopedLogger, createDigestWriter, runWithTimeout } = require("./shared");

module.exports = {
    /**
    清单声明了该 scope 且策略放行，才算拿到这个能力。
    与 context.js 里动作路径的判据保持一致（那边靠 invoke 先做校验，这里要自己判）。
    */
    _hasPluginScope(record, scope) {
        if (!record || !record.manifest) {
            return false;
        }
        if (record.manifest.permissions.indexOf(scope) === -1) {
            return false;
        }
        return this.getPolicy(scope, record) === "allow";
    },

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
        // 读一次配置：ctx 与 sessions 门面都要用，重复读盘没必要
        const pluginConfig = this.getConfig(record.name);
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
        const controller = new AbortController();
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
            config: pluginConfig,
            logger: createScopedLogger(this.logger, record.name),
            storage: capabilities.createStorage({ dir: this.storageDir(record.name) }),
            // 接口调用不经过 invoke 的权限校验，这里要自己判：清单声明 + 策略 allow。
            // 否则只要知道插件接口路径，就能绕过权限直接搬会话记录。
            sessions: createSessionMemory({
                manager: this.hostSessions,
                canRead: this._hasPluginScope(record, "sessions:read"),
                canWrite: this._hasPluginScope(record, "sessions:write"),
                maxRecords: pluginConfig.maxOutputRecords,
                compress: pluginConfig.compress,
                maxChars: pluginConfig.maxChars,
                digest: pluginConfig.digest,
                maxDigestChars: pluginConfig.maxDigestChars,
                // 接口路径没有"当前工作区"（不知道请求来自哪个工作区），
                // 写入口按目标会话自己记录的 workspace 解析（见 shared.createDigestWriter）。
                // 没有 workspace:write 就不给：否则知道接口路径就能往任意工作区落文件。
                writeDigest: this._hasPluginScope(record, "workspace:write")
                    ? createDigestWriter({})
                    : null,
                logger: createScopedLogger(this.logger, record.name),
            }),
            secrets: this._secretsFor(record, this._canReadSecrets(record)),
            // handler 超时会被 abort；用了自定义 I/O 的插件应监听这个信号
            signal: controller.signal,
        };
        let result;
        try {
            result = await runWithTimeout(() => route.handler(ctx), this.apiTimeoutMs, controller);
        } catch (error) {
            const message = (error && error.message) || String(error);
            if (error && error.code === "PLUGIN_TIMEOUT") {
                // 不能把请求一直挂在这里：浏览器面板会永远转圈
                this.logger.warn?.(
                    "[plugins] " +
                        record.name +
                        " 的接口 " +
                        verb +
                        " " +
                        pathText +
                        " 超时（" +
                        this.apiTimeoutMs +
                        "ms）"
                );
                return {
                    status: 504,
                    body: {
                        error: "插件接口超时（" + this.apiTimeoutMs + "ms）",
                        code: "PLUGIN_API_TIMEOUT",
                        plugin: record.name,
                    },
                };
            }
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
        return { status: 200, body: result === undefined ? {} : result };
    },
};
