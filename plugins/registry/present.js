/**
对外展示：状态总览、UI 清单、事件格式器。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

module.exports = {
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
    },

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
    },

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
    },
};
