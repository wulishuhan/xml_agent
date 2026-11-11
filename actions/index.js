/**
内置动作表

把 read / write / edit / exec / answer / done 六个内置动作统一成"动作定义对象"
（与插件动作同一个形状），从而让：
- runtime.js 只剩"查表 + 执行"，不再有动作的具体实现；
- parse/xml-parse.js 的校验走同一张表，而不是另一份 switch；
- agent-core.js 的终止语义（answer / done）与产物上传（collectImages）由元数据驱动。

顺序为 read, write, edit, exec, answer, done：write 与 edit 相邻（一个建/重写，
一个局部改），其余保持 1.1.0 的相对次序。

> screenshot 自 v1.1.0 起是内置插件（plugins/builtin/screenshot），
> 因此不在这张表里；它通过 plugins/registry 注册，由 Runtime 的插件分支执行。
*/

const sdk = require("../plugins/sdk");

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
内置动作表：Map<name, definition>。
定义对象由 sdk.defineAction 归一化，因此与插件动作共享同一套元数据形状
（prompt / permission / terminal / timeoutMs / summary / collectImages / fastPath）。
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
        // 若某个内置动作自带 parse 层需要的归一化函数，一并带出去
        if (typeof raw.normalizeScreenshotTargets === "function") {
            definition.normalizeScreenshotTargets = raw.normalizeScreenshotTargets;
        }
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
解析层校验：找不到动作时抛 "Unknown XML Action: xxx"（与迁移前一致）。
*/
function validateBuiltinAction(name, node) {
    const definition = getBuiltinAction(name);
    if (!definition) {
        throw new Error("Unknown XML Action: " + name);
    }
    if (typeof definition.validate === "function") {
        definition.validate(node);
    }
}

/**
内置动作的 fastPath 列表（手写快速解析器），按定义顺序返回。
*/
function getBuiltinFastPaths() {
    const result = [];
    for (const definition of getBuiltinActions().values()) {
        if (typeof definition.meta.fastPath === "function") {
            result.push({ action: definition.name, parse: definition.meta.fastPath });
        }
    }
    return result;
}

module.exports = {
    getBuiltinActions,
    getBuiltinAction,
    hasBuiltinAction,
    getBuiltinActionNames,
    validateBuiltinAction,
    getBuiltinFastPaths,
};
