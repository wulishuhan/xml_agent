/**
Action 标签识别。

"这条回复里有没有 XML Action"是四个 provider 都要回答的问题，
此前 qwen / deepseek / glm 各自写了一份，标签清单也随之漂移
（有的漏了 screenshot，导致只回 `<screenshot/>` 的回复被当成普通文本）。

标签清单必须与 `parse/xml-parse.js` 的 validateAction 保持一致。
*/

const ACTION_TAG_NAMES = ["write", "edit", "read", "exec", "screenshot", "answer", "done"];

/**
判断文本中是否出现任一 Action 起始标签。
@param {string} value
@returns {boolean}
*/
function containsActionTag(value) {
    if (typeof value !== "string") {
        return false;
    }
    return ACTION_TAG_NAMES.some((name) => value.includes("<" + name));
}

module.exports = {
    ACTION_TAG_NAMES,
    containsActionTag,
};
