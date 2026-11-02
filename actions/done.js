/**
内置动作：done

从 runtime.js 迁出（P0 动作定义对象化）。

meta.terminal = "end"：Agent 编排器据此结束循环，
不再特判 action === "done"。
*/

module.exports = {
    name: "done",
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
            usage: "<done/>",
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
