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
GET  /api/plugins/secrets               密钥键名清单（只回键名与长度，不回值）
PUT  /api/plugins/secrets/:key          写入/覆盖一个密钥（{ value })
DELETE /api/plugins/secrets/:key        删除一个密钥

v1 的 UI 只做"宿主渲染的声明式面板"，不向前端下发可执行 JS。
*/

function statusForError(error) {
    const code = (error && error.code) || "";
    if (code === "PLUGIN_NOT_FOUND") {
        return 404;
    }
    return 400;
}

/**
路径解码：非法编码保持原样（不因为一个坏字符让整个请求 400）。
*/
function decodePath(value) {
    try {
        return decodeURIComponent(String(value));
    } catch (error) {
        return String(value);
    }
}

function registerPluginRoutes(app, deps = {}) {
    const resolveRegistry =
        deps.getRegistry ||
        function getRegistry() {
            // eslint-disable-next-line global-require
            return require("../../plugins/registry").getRegistry();
        };

    /**
    把处理器包一层：解析 registry + 统一错误响应。
    label 会写进函数名，这样 Express 把一个 app.use 挂载注册成中间件层之后，
    路由表测试仍然能按名字认出它是谁（否则只能看到一个 <anonymous>）。
    */
    function withRegistry(handler, label) {
        const wrapped = async (req, res) => {
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
        if (label) {
            Object.defineProperty(wrapped, "name", { value: label });
        }
        return wrapped;
    }

    /**
    插件自定义接口：路径被限定在 /api/plugins/<name>/api/* 之下，
    具体 method + path 由插件自己注册，因此插件之间不会互相串。

    这里用 app.use 挂在前缀上，而不是 app.all 的通配路由：
    "/api/plugins/:name/api/{*splat}" 是 Express 5 的语法，落到 Express 4
    上不报错、只是永远匹配不上，于是插件接口会静默变成 404（前端面板空白）。
    挂在 mount 路径上时，Express 4/5 都会先剥掉前缀、把剩下的部分留在 req.path，
    两个版本行为一致，插件路由本身不需要关心宿主的版本。
    */
    const handlePluginApi = withRegistry(async (registry, req, res) => {
        const name = req.params.name;
        // 挂载后剩下的是插件自己的路径；解码是为了和旧的 req.params 语义一致
        // （插件路由只允许 ASCII 字符，解码不会引入穿越风险，只是字符串比较）。
        const subPath = decodePath(req.path || "/");
        const result = await registry.callPluginApi(name, req.method, subPath, {
            query: req.query,
            body: req.body,
        });
        return res.status(result.status).json(result.body);
    }, "pluginApi");

    app.use("/api/plugins/:name/api", handlePluginApi);

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

    // ---- 密钥管理：只回键名与长度，值只进不出 ----
    app.get(
        "/api/plugins/secrets",
        withRegistry((registry, req, res) => {
            return res.json({ secrets: registry.listSecrets() });
        })
    );

    app.put(
        "/api/plugins/secrets/:key",
        withRegistry((registry, req, res) => {
            const value = req.body && req.body.value;
            const secrets = registry.setSecret(req.params.key, value);
            return res.json({ message: "Secret saved", secrets });
        })
    );

    app.delete(
        "/api/plugins/secrets/:key",
        withRegistry((registry, req, res) => {
            const result = registry.deleteSecret(req.params.key);
            return res.json(
                Object.assign(
                    { message: result.removed ? "Secret deleted" : "Secret not found" },
                    result
                )
            );
        })
    );
}

module.exports = {
    registerPluginRoutes,
};
