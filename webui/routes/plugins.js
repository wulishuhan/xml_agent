/**
插件管理 API（Web 版与桌面版共用）

GET  /api/plugins                       插件列表（状态/权限/配置/错误）
POST /api/plugins/reload                重新扫描并加载插件
POST /api/plugins/:name/enabled         启用/禁用插件（{ enabled })
GET  /api/plugins/:name/config          读取插件配置
POST /api/plugins/:name/config          写入插件配置（按 configSchema 校验）
GET  /api/plugins/ui                    声明式 UI 贡献（面板/设置/按钮）
GET  /api/permissions                   权限 scope 与当前策略
POST /api/permissions/grant             授权/禁止某个 scope（{ scope, policy })

v1 的 UI 只做"宿主渲染的声明式面板"，不向前端下发可执行 JS。
*/

function statusForError(error) {
    const code = (error && error.code) || "";
    if (code === "PLUGIN_NOT_FOUND") {
        return 404;
    }
    return 400;
}

function registerPluginRoutes(app, deps = {}) {
    const resolveRegistry =
        deps.getRegistry ||
        function getRegistry() {
            // eslint-disable-next-line global-require
            return require("../../plugins/registry").getRegistry();
        };

    function withRegistry(handler) {
        return async (req, res) => {
            let registry;
            try {
                registry = resolveRegistry();
            } catch (error) {
                return res.status(500).json({ error: error.message });
            }
            try {
                return await handler(registry, req, res);
            } catch (error) {
                return res.status(statusForError(error)).json({
                    error: error.message,
                    code: (error && error.code) || null,
                });
            }
        };
    }

    /**
    插件自定义接口：路径被限定在 /api/plugins/<name>/api/* 之下，
    具体 method + path 由插件自己注册，因此插件之间不会互相串。
    */
    const handlePluginApi = withRegistry(async (registry, req, res) => {
        const name = req.params.name;
        const splat = req.params.splat;
        const segments = Array.isArray(splat) ? splat : splat ? [splat] : [];
        const subPath = "/" + segments.join("/");
        const result = await registry.callPluginApi(name, req.method, subPath, {
            query: req.query,
            body: req.body,
        });
        return res.status(result.status).json(result.body);
    });

    app.all("/api/plugins/:name/api", handlePluginApi);
    app.all("/api/plugins/:name/api/{*splat}", handlePluginApi);

    app.get(
        "/api/plugins",
        withRegistry((registry, req, res) => {
            return res.json({
                enabled: registry.enabled,
                plugins: registry.getStatus(),
                permissions: registry.getPermissions(),
                errors: registry.errors.slice(),
            });
        })
    );

    app.post(
        "/api/plugins/reload",
        withRegistry((registry, req, res) => {
            registry.reload();
            return res.json({
                message: "Plugins reloaded",
                enabled: registry.enabled,
                plugins: registry.getStatus(),
                errors: registry.errors.slice(),
            });
        })
    );

    app.post(
        "/api/plugins/:name/enabled",
        withRegistry((registry, req, res) => {
            if (!registry.getPlugin(req.params.name)) {
                return res.status(404).json({ error: "Plugin not found: " + req.params.name });
            }
            const enabled = !(req.body && req.body.enabled === false);
            const plugin = registry.setEnabled(req.params.name, enabled);
            if (!plugin) {
                return res.status(404).json({ error: "Plugin not found: " + req.params.name });
            }
            return res.json({ message: "Plugin state updated", plugin });
        })
    );

    app.get(
        "/api/plugins/:name/config",
        withRegistry((registry, req, res) => {
            const plugin = registry.getPlugin(req.params.name);
            if (!plugin) {
                return res.status(404).json({ error: "Plugin not found: " + req.params.name });
            }
            return res.json({
                name: plugin.name,
                config: registry.getConfig(plugin.name),
                schema: plugin.manifest.configSchema,
            });
        })
    );

    app.post(
        "/api/plugins/:name/config",
        withRegistry((registry, req, res) => {
            const plugin = registry.getPlugin(req.params.name);
            if (!plugin) {
                return res.status(404).json({ error: "Plugin not found: " + req.params.name });
            }
            const saved = registry.setConfig(plugin.name, (req.body && req.body.config) || {});
            return res.json({ name: plugin.name, config: saved });
        })
    );

    app.get(
        "/api/plugins/ui",
        withRegistry((registry, req, res) => {
            return res.json(registry.getUiManifest());
        })
    );

    app.get(
        "/api/permissions",
        withRegistry((registry, req, res) => {
            return res.json(registry.getPermissions());
        })
    );

    app.post(
        "/api/permissions/grant",
        withRegistry((registry, req, res) => {
            const scope = req.body && req.body.scope;
            const policy = req.body && req.body.policy;
            const permissions = registry.grantPermission(scope, policy);
            return res.json({ message: "Permission updated", permissions });
        })
    );
}

module.exports = {
    registerPluginRoutes,
};
