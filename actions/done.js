/**
 * 内置动作：done
 *
 * meta.terminal = "end"：Agent 编排器据此结束循环，
 * 不再特判 action === "done"。
 */

const { BUILTIN_ACTION_SCHEMAS } = require("../parse/action-schema");

module.exports = {
    name: "done",
    schema: BUILTIN_ACTION_SCHEMAS.done,
    validate() {
        // done 不需要任何参数
    },
    run() {
        return {
            ok: true,
            action: "done",
        };
    },
    meta: {
        prompt: {
            group: "core",
            usage: '{"action":"done","params":{}}',
            note: "结束 Agent 生命周期；不能代替 answer。",
            priority: 115,
        },
        permission: [],
        terminal: "end",
        mutating: false,
        timeoutMs: 5000,
        summary: () => "done",
    },
};
