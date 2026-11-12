/**
Action 标签识别。

"这条回复里有没有 XML Action"是四个 provider 都要回答的问题，
此前 qwen / deepseek / glm 各自写了一份，标签清单也随之漂移
（有的漏了 screenshot，导致只回 `<screenshot/>` 的回复被当成普通文本）。

但清单本身不能写死：插件动作是开放集合（browse-nav / wechat-read / …），
装一个插件就多几个名字，手写数组永远追不上。所以这里改成
"内置动作 + 注册表里当前注册的插件动作"，注册表不可用时退回内置清单。

漏判的代价不只是"没认出动作"：provider 会以为最后一条回复里没有动作，
转去合并最近几条消息，把上一轮同样的 XML 又拼一遍，解析器随即报
"Exactly one XML Action is required, but received 2"。
*/

/** 内置动作名。与 `parse/xml-parse.js` 的 validateAction 保持一致。 */
const BUILTIN_ACTION_TAG_NAMES = ["write", "edit", "read", "exec", "screenshot", "answer", "done"];

// 只接受规整的名字再拼进正则，避免注册表里的异常值污染模式
const SAFE_ACTION_NAME = /^[a-z][a-z0-9-]*$/i;

let cachedNames = BUILTIN_ACTION_TAG_NAMES.slice();
let cachedSignature = null;
let cachedRegex = null;

/** 读注册表里的插件动作名。任何异常都当"没有插件动作"，不能让主流程崩。 */
function getPluginActionNames() {
    try {
        // eslint-disable-next-line global-require
        const registry = require("../plugins/registry").getRegistrySafe();

        if (!registry || typeof registry.listActionNames !== "function") {
            return [];
        }

        return registry
            .listActionNames()
            .map((name) => String(name || ""))
            .filter((name) => SAFE_ACTION_NAME.test(name));
    } catch (error) {
        return [];
    }
}

/**
当前生效的动作名清单（内置 ∪ 插件）。注册表内容变化时自动重建缓存。
@returns {string[]}
*/
function getActionTagNames() {
    const extra = getPluginActionNames();
    const signature = extra.join(",");

    if (signature === cachedSignature) {
        return cachedNames;
    }

    const names = new Set(BUILTIN_ACTION_TAG_NAMES);
    for (const name of extra) {
        names.add(name);
    }

    cachedSignature = signature;
    cachedNames = Array.from(names);
    cachedRegex = null;

    return cachedNames;
}

/**
动作起始标签的匹配模式。

名字后面必须跟空白 / `/` / `>` 或结尾，否则 `<read` 会命中 `<readdir`。
*/
function getActionTagRegex() {
    getActionTagNames();

    if (!cachedRegex) {
        cachedRegex = new RegExp("<(?:" + cachedNames.join("|") + ")(?=[\\s/>]|$)");
    }

    return cachedRegex;
}

/**
判断文本中是否出现任一 Action 起始标签。
@param {string} value
@returns {boolean}
*/
function containsActionTag(value) {
    if (typeof value !== "string") {
        return false;
    }

    return getActionTagRegex().test(value);
}

module.exports = {
    // 兼容旧名：只含内置动作，不含插件动作
    ACTION_TAG_NAMES: BUILTIN_ACTION_TAG_NAMES,
    getActionTagNames,
    getActionTagRegex,
    containsActionTag,
};
