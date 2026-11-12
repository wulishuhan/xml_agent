/**
只读查询：动作表、插件记录、模型提示词贡献。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const sdk = require("../sdk");

module.exports = {
    listPlugins() {
        this.load();
        return Array.from(this.plugins.values());
    },

    listLoaded() {
        return this.listPlugins().filter((record) => record.status === "loaded");
    },

    getPlugin(name) {
        this.load();
        return this.plugins.get(String(name || "")) || null;
    },

    hasAction(name) {
        this.load();
        return this.actions.has(String(name || ""));
    },

    /**
    当前注册的全部插件动作名。

    provider 判断「这条回复里有没有 Action」时需要一份完整清单；
    插件动作是开放集合，任何手写清单都会漂移，只能从这里派生。
    */
    listActionNames() {
        this.load();
        return Array.from(this.actions.keys());
    },

    getActionDefinition(name) {
        this.load();
        const entry = this.actions.get(String(name || ""));
        return entry ? entry.def : null;
    },

    getActionPluginName(name) {
        this.load();
        const entry = this.actions.get(String(name || ""));
        return entry ? entry.plugin : null;
    },

    getFastPaths() {
        this.load();
        const result = [];
        for (const entry of this.actions.values()) {
            if (entry.def.meta.fastPath) {
                result.push({ action: entry.name, parse: entry.def.meta.fastPath });
            }
        }
        return result;
    },

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
    },

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
    },
};
