/**
 * 内置动作表
 *
 * 把 read / write / edit / exec / answer / done 六个内置动作统一成"动作定义对象"
 * （与插件动作同一个形状），从而让：
 * - runtime.js 只剩"查表 + 执行"，不再有动作的具体实现；
 * - JSON 动作解析层通过同一张表校验 params；
 * - agent-core.js 的终止语义（answer / done）与产物上传（collectImages）由元数据驱动。
 *
 * 顺序为 read, write, edit, exec, answer, done：write 与 edit 相邻（一个建/重写，
 * 一个局部改），其余保持 1.1.0 的相对次序。
 *
 * > screenshot 自 v1.1.0 起是内置插件（plugins/builtin/screenshot），
 * > 因此不在这张表里；它通过 plugins/registry 注册，由 Runtime 的插件分支执行。
 */

const sdk = require("../plugins/sdk");
const { validateParams } = require("../parse/action-schema");

const DEFINITIONS = [
    require("./read"),
    require("./write"),
    require("./edit"),
    require("./exec"),
    require("./answer"),
    require("./done"),
];

let table = null;

/**
 * 内置动作表：Map<name, definition>。
 * 定义对象由 sdk.defineAction 归一化，因此与插件动作共享同一套元数据形状
 * （prompt / permission / terminal / timeoutMs / summary / collectImages）。
 */
function getBuiltinActions() {
    if (table) {
        return table;
    }
    const map = new Map();
    for (const raw of DEFINITIONS) {
        // allowReserved：内置动作本来就用这些名字，跳过"保留名"检查。
        const definition = sdk.defineAction(raw, { builtin: true, allowReserved: true });
        definition.meta.collectImages =
            raw.meta && typeof raw.meta.collectImages === "function"
                ? raw.meta.collectImages
                : null;
        map.set(definition.name, definition);
    }
    table = map;
    return table;
}

function getBuiltinAction(name) {
    return getBuiltinActions().get(String(name || "")) || null;
}

function hasBuiltinAction(name) {
    return getBuiltinActions().has(String(name || ""));
}

function getBuiltinActionNames() {
    return Array.from(getBuiltinActions().keys());
}

/**
 * 用动作的 JSON Schema 校验 params，再执行语义校验。
 * 返回 { ok, value, error }；value 已应用 Schema 默认值。
 */
function validateBuiltinAction(name, params) {
    const definition = getBuiltinAction(name);
    if (!definition) {
        return { ok: false, error: "Unknown action: " + name };
    }
    const checked = validateParams(definition.schema, params);
    if (!checked.ok) {
        return checked;
    }
    try {
        if (typeof definition.validate === "function") {
            definition.validate(checked.value);
        }
    } catch (error) {
        return {
            ok: false,
            value: checked.value,
            error: error && error.message ? error.message : String(error),
        };
    }
    return checked;
}

module.exports = {
    getBuiltinActions,
    getBuiltinAction,
    hasBuiltinAction,
    getBuiltinActionNames,
    validateBuiltinAction,
};
