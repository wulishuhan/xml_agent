/**
插件动作执行、权限拒绝、钩子广播。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const sdk = require("../sdk");

const { runWithTimeout } = require("./shared");

module.exports = {
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
        // 声明式的"会改动 workspace/system"，让 Trace、审计与前端不必再按动作名猜
        result.mutating = entry.def.meta.mutating === true;

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
    },

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
    },

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
            // 先计数再调用：handler 抛错也已经被"通知"过了。
            // 原来的 count += 1 放在 try 末尾，抛错时会被跳过，于是 1 个 handler 抛错
            // 时返回值是 0，日志里看起来像"根本没有插件监听这个事件"。
            count += 1;
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
    },
};
