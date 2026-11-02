/**
Provider 列表 API

GET /api/providers
返回全部可用 provider（内置 + 插件），供前端渲染下拉框、显示默认访问地址、
以及在输入会话 URL 时做前端提示。

前端曾经把 4 个 <option> 和 4 套正则硬编码在 App.vue / agent-api.js 里，
新增一个 provider（尤其是插件 provider）就得改前端。现在只需要读这个接口。
*/

function registerProviderRoutes(app, deps = {}) {
    const resolveProviders =
        deps.providers ||
        function defaultProviders() {
            // eslint-disable-next-line global-require
            return require("../../providers");
        };

    app.get("/api/providers", (req, res) => {
        let api;
        try {
            api = resolveProviders();
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
        try {
            const list = api.listProviders();
            return res.json({
                providers: list,
                defaultId: list.length > 0 ? list[0].id : null,
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    });
}

module.exports = {
    registerProviderRoutes,
};
