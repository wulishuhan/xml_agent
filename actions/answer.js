/**
 * 内置动作：answer
 *
 * meta.terminal = "answer"：Agent 编排器不再特判 action === "answer"，
 * 而是根据动作声明的终止语义决定"产出最终答案 + 追加 done 提示"。
 */

const { BUILTIN_ACTION_SCHEMAS } = require("../parse/action-schema");

module.exports = {
    name: "answer",
    schema: BUILTIN_ACTION_SCHEMAS.answer,
    validate(params) {
        if (typeof params?.content !== "string" || !params.content.trim()) {
            throw new Error("answer content cannot be empty");
        }
    },
    run(params) {
        const content = params?.content;
        if (typeof content !== "string" || !content.trim()) {
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
            usage: '{"action":"answer","params":{"content":"这里是给用户看的最终答案。"}}',
            note: "返回给用户的最终答案；answer 之后必须单独再输出 done。",
            priority: 120,
        },
        permission: [],
        terminal: "answer",
        mutating: false,
        timeoutMs: 5000,
        summary: () => "answer",
    },
};
