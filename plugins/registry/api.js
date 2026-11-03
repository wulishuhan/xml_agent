/**
插件自定义 HTTP 接口的分发与执行。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const sdk = require("../sdk");
const capabilities = require("../capabilities");

const { createScopedLogger } = require("./shared");

module.exports = {
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
            storage: capabilities.createStorage({ dir: this.storageDir(record.name) }),
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
    },
};
