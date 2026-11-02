/**
内置动作：answer

从 runtime.js 迁出（P0 动作定义对象化）。

meta.terminal = "answer"：Agent 编排器不再特判 action === "answer"，
而是根据动作声明的终止语义决定"产出最终答案 + 追加 done 提示"。
*/

const { getText } = require("../parse/xml-text");

module.exports = {
    name: "answer",
    validate(node) {
        if (!getText(node).trim()) {
            throw new Error("answer content cannot be empty");
        }
    },
    run(node) {
        const content = getText(node);
        if (!content.trim()) {
            throw new Error("answer content cannot be empty");
        }
        return {
            ok: true,
            action: "answer",
            content,
        };
    },
    meta: {
        prompt: {
            group: "core",
            usage: "<answer><![CDATA[\n这里是给用户看的最终答案。\n]]></answer>",
            note: "返回给用户的最终答案；answer 之后必须单独再输出 <done/>。",
            priority: 120,
        },
        permission: [],
        terminal: "answer",
        mutating: false,
        timeoutMs: 5000,
        summary: () => "answer",
    },
};
