/**
Plugin SDK

插件作者唯一需要理解的契约层。这里只放"纯函数"：
清单校验、动作定义校验、属性 schema 校验、权限 scope、版本区间匹配、契约自检。

刻意不在这里 require runtime / fs / http：
- registry.js 依赖本模块；
- 本模块不依赖任何运行期模块，避免循环依赖；
- 能力门面（fs/http/storage/secrets）在 capabilities.js。
*/

const API_VERSION = 1;

// 权限作用域：动作只能申请这些能力，registry 会按清单声明与用户授权做二次校验。
const PERMISSION_SCOPES = [
    "workspace:read",
    "workspace:write",
    "shell:exec",
    "network:http",
    "system:screen",
    "system:window",
    "secrets:read",
];

const PLUGIN_KINDS = ["action", "hook", "provider", "ui"];

// 内置动作名不允许被插件占用：它们的语义（answer / done 的终止语义）
// 由 Agent 编排器依赖，覆盖会直接破坏协议。
// 注意：screenshot 自 v1.1.0 起本身就是内置插件（plugins/builtin/screenshot），
// 因此不在保留名单里；"插件不能覆盖别人已注册的动作名"仍由 registry 保证。
const RESERVED_ACTION_NAMES = ["read", "write", "exec", "answer", "done"];

const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;

const ATTR_PREFIX = "@_";

// 插件可以暴露的 HTTP 方法（挂在自己命名空间 /api/plugins/<name>/api/* 下）
const API_ROUTE_METHODS = ["GET", "POST", "PUT", "DELETE"];

// 声明式 UI（P4）：宿主渲染，插件只提供 JSON，不向浏览器下发可执行代码。
const PANEL_BLOCK_KINDS = ["note", "status", "table", "action"];

function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

// ------------------------------------------------------------
// 版本与引擎区间
// ------------------------------------------------------------

function parseVersion(value) {
    const text = String(value || "")
        .trim()
        .replace(/^v/i, "");
    const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
    if (!match) {
        return null;
    }
    return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersions(a, b) {
    for (let index = 0; index < 3; index += 1) {
        const left = a[index] || 0;
        const right = b[index] || 0;
        if (left !== right) {
            return left < right ? -1 : 1;
        }
    }
    return 0;
}

// 支持 >=1.1.0 / <2.0.0 / ^1.2.3 / ~1.2.3 / 1.2.3，多个条件用空格分隔（全部满足才算通过）。
function satisfiesEngines(range, version) {
    if (range === undefined || range === null || String(range).trim() === "") {
        return true;
    }
    const current = parseVersion(version);
    if (!current) {
        return true;
    }
    const tokens = String(range).trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
        const match = token.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/);
        if (!match) {
            return false;
        }
        const operator = match[1] || "=";
        const target = parseVersion(match[2]);
        if (!target) {
            return false;
        }
        const cmp = compareVersions(current, target);
        if (operator === ">=" && !(cmp >= 0)) {
            return false;
        }
        if (operator === ">" && !(cmp > 0)) {
            return false;
        }
        if (operator === "<=" && !(cmp <= 0)) {
            return false;
        }
        if (operator === "<" && !(cmp < 0)) {
            return false;
        }
        if (operator === "=" && cmp !== 0) {
            return false;
        }
        if (operator === "^") {
            // ^1.2.3 => >=1.2.3 <2.0.0
            if (cmp < 0 || current[0] !== target[0]) {
                return false;
            }
        }
        if (operator === "~") {
            // ~1.2.3 => >=1.2.3 <1.3.0
            if (cmp < 0 || current[0] !== target[0] || current[1] !== target[1]) {
                return false;
            }
        }
    }
    return true;
}

// ------------------------------------------------------------
// 清单校验
// ------------------------------------------------------------

function normalizeManifest(raw, options = {}) {
    const label = options.label || "plugin.json";
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw createError("MANIFEST_INVALID", label + " 必须是一个 JSON 对象");
    }
    const name = String(raw.name || "").trim();
    if (!name) {
        throw createError("MANIFEST_INVALID", label + " 缺少 name");
    }
    if (!PLUGIN_NAME_PATTERN.test(name)) {
        throw createError(
            "MANIFEST_INVALID",
            label + " 的 name 非法（只允许小写字母/数字，以及 - _ . 分隔）：" + name
        );
    }
    const version = String(raw.version || "").trim();
    if (!parseVersion(version)) {
        throw createError("MANIFEST_INVALID", label + " 的 version 非法：" + version);
    }
    const kind = String(raw.kind || "action").trim();
    if (PLUGIN_KINDS.indexOf(kind) === -1) {
        throw createError(
            "MANIFEST_INVALID",
            label + " 的 kind 必须是 " + PLUGIN_KINDS.join(" / ") + "，收到：" + kind
        );
    }
    const apiVersion = Number(raw.apiVersion === undefined ? API_VERSION : raw.apiVersion);
    if (!Number.isInteger(apiVersion) || apiVersion <= 0) {
        throw createError("MANIFEST_INVALID", label + " 的 apiVersion 必须是正整数");
    }
    const permissions = normalizePermissions(raw.permissions, label);
    const activation = normalizeActivation(raw.activation, label);
    const configSchema = normalizeConfigSchema(raw.configSchema, label);
    const engines =
        raw.engines && typeof raw.engines === "object"
            ? { xmlAgent: String(raw.engines.xmlAgent || "") }
            : { xmlAgent: "" };
    return {
        name,
        version,
        kind,
        apiVersion,
        description: String(raw.description || ""),
        author: String(raw.author || ""),
        permissions,
        activation,
        configSchema,
        engines,
        enabledByDefault: raw.enabledByDefault !== false,
        deprecated: raw.deprecated === true,
    };
}

function normalizePermissions(raw, label) {
    if (raw === undefined || raw === null) {
        return [];
    }
    if (!Array.isArray(raw)) {
        throw createError(
            "MANIFEST_INVALID",
            (label || "plugin.json") + " 的 permissions 必须是数组"
        );
    }
    const result = [];
    for (const item of raw) {
        const scope = String(item || "").trim();
        if (PERMISSION_SCOPES.indexOf(scope) === -1) {
            throw createError(
                "MANIFEST_INVALID",
                (label || "plugin.json") + " 声明了未知权限 scope：" + scope
            );
        }
        if (result.indexOf(scope) === -1) {
            result.push(scope);
        }
    }
    return result;
}

function normalizeActivation(raw, label) {
    if (raw === undefined || raw === null || raw === "always") {
        return { mode: "always" };
    }
    if (raw === "manual") {
        return { mode: "manual" };
    }
    if (typeof raw === "object" && Array.isArray(raw.keywords)) {
        const keywords = raw.keywords.map((item) => String(item || "").trim()).filter(Boolean);
        if (keywords.length === 0) {
            return { mode: "always" };
        }
        return { mode: "keywords", keywords };
    }
    throw createError(
        "MANIFEST_INVALID",
        (label || "plugin.json") + " 的 activation 必须是 always / manual / { keywords: [] }"
    );
}

function normalizeConfigSchema(raw, label) {
    if (raw === undefined || raw === null) {
        return {};
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw createError(
            "MANIFEST_INVALID",
            (label || "plugin.json") + " 的 configSchema 必须是对象"
        );
    }
    const schema = {};
    for (const key of Object.keys(raw)) {
        const spec = raw[key];
        if (!spec || typeof spec !== "object") {
            throw createError(
                "MANIFEST_INVALID",
                (label || "plugin.json") + " 的 configSchema." + key + " 必须是对象"
            );
        }
        schema[key] = {
            type: String(spec.type || "string"),
            default: spec.default,
            description: String(spec.description || ""),
            enum: Array.isArray(spec.enum) ? spec.enum.slice() : null,
        };
    }
    return schema;
}

function configDefaults(manifest) {
    const result = {};
    const schema = (manifest && manifest.configSchema) || {};
    for (const key of Object.keys(schema)) {
        if (schema[key].default !== undefined) {
            result[key] = cloneValue(schema[key].default);
        }
    }
    return result;
}

// 用 configSchema 校验并归一化用户配置：未知字段丢弃，类型/枚举不符则报错。
function normalizeConfig(manifest, raw) {
    const schema = (manifest && manifest.configSchema) || {};
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const value = configDefaults(manifest);
    const errors = [];
    for (const key of Object.keys(input)) {
        const spec = schema[key];
        if (!spec) {
            continue;
        }
        const item = input[key];
        if (item === undefined || item === null) {
            continue;
        }
        if (spec.type === "array") {
            if (!Array.isArray(item)) {
                errors.push("config." + key + " 必须是数组");
                continue;
            }
            value[key] = item.map((entry) => String(entry).trim()).filter(Boolean);
            continue;
        }
        if (spec.type === "boolean") {
            value[key] = toBoolean(item);
            continue;
        }
        if (spec.type === "integer" || spec.type === "number") {
            const number = Number(item);
            if (!Number.isFinite(number)) {
                errors.push("config." + key + " 必须是数字");
                continue;
            }
            value[key] = spec.type === "integer" ? Math.trunc(number) : number;
            continue;
        }
        const text = String(item);
        if (spec.enum && spec.enum.length > 0 && spec.enum.indexOf(text) === -1) {
            errors.push("config." + key + " 必须是 " + spec.enum.join(" / "));
            continue;
        }
        value[key] = text;
    }
    return { ok: errors.length === 0, value, errors };
}

function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.slice();
    }
    if (value && typeof value === "object") {
        return JSON.parse(JSON.stringify(value));
    }
    return value;
}

function toBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }
    const text = String(value || "")
        .trim()
        .toLowerCase();
    if (text === "true" || text === "1" || text === "yes" || text === "on") {
        return true;
    }
    return false;
}

// ------------------------------------------------------------
// 动作定义
// ------------------------------------------------------------

/**
定义一个插件的 XML 动作。这是插件作者唯一需要理解的核心结构：
校验（schema）+ 执行（run）+ 模型文档（meta.prompt）+ 可观测（meta.summary）
+ 安全（meta.permission / timeoutMs）。
*/
function defineAction(def, options = {}) {
    const label = options.plugin ? "plugin " + options.plugin + " 的动作" : "动作";
    if (!def || typeof def !== "object") {
        throw createError("ACTION_INVALID", label + "定义必须是对象");
    }
    const name = String(def.name || "").trim();
    if (!ACTION_NAME_PATTERN.test(name)) {
        throw createError(
            "ACTION_INVALID",
            label + " 的 name 非法（只允许小写字母/数字，以及 - _ . 分隔）：" + name
        );
    }
    if (RESERVED_ACTION_NAMES.indexOf(name) !== -1 && options.allowReserved !== true) {
        throw createError(
            "ACTION_INVALID",
            label + " 使用了内置动作名 " + name + "（内置动作不允许被插件覆盖）"
        );
    }
    if (typeof def.run !== "function") {
        throw createError("ACTION_INVALID", label + " " + name + " 缺少 run(node, ctx) 函数");
    }
    const meta = def.meta && typeof def.meta === "object" ? def.meta : {};
    const prompt = meta.prompt && typeof meta.prompt === "object" ? meta.prompt : {};
    const usage = String(prompt.usage || "").trim();
    if (!usage) {
        // 没有用法说明的动作模型永远学不会，直接拒绝比静默失败好。
        throw createError(
            "ACTION_INVALID",
            label + " " + name + " 缺少 meta.prompt.usage（模型侧用法示例）"
        );
    }
    const permission = normalizePermissions(meta.permission || [], label + " " + name);
    const terminal = meta.terminal || null;
    if (terminal !== null && terminal !== "answer" && terminal !== "end") {
        throw createError(
            "ACTION_INVALID",
            label + " " + name + " 的 meta.terminal 只能是 answer / end / null"
        );
    }
    const rawTimeout = Number(meta.timeoutMs);
    const timeoutMs =
        Number.isFinite(rawTimeout) && rawTimeout > 0
            ? Math.min(Math.trunc(rawTimeout), 10 * 60 * 1000)
            : 30000;
    const schema = def.schema && typeof def.schema === "object" ? def.schema : null;
    return {
        name,
        schema,
        validate: typeof def.validate === "function" ? def.validate : null,
        run: def.run,
        meta: {
            prompt: {
                group: String(prompt.group || "plugin").trim() || "plugin",
                usage,
                note: String(prompt.note || "").trim(),
                priority: Number.isFinite(Number(prompt.priority)) ? Number(prompt.priority) : 50,
            },
            terminal,
            permission,
            mutating: meta.mutating === true,
            timeoutMs,
            summary: typeof meta.summary === "function" ? meta.summary : null,
            // 回给模型的精简视图：结果可能很大（例如 HTTP 响应体），
            // 整包 JSON 进下一轮提示词会把上下文撑爆。
            promptResult: typeof meta.promptResult === "function" ? meta.promptResult : null,
            // 声明本动作产出的、需要上传给模型看的图片路径（目前用于 screenshot）。
            // Agent 据此统一上传，不再按动作名特判。
            collectImages: typeof meta.collectImages === "function" ? meta.collectImages : null,
            afterRun: typeof meta.afterRun === "function" ? meta.afterRun : null,
            fastPath: typeof meta.fastPath === "function" ? meta.fastPath : null,
        },
    };
}

// ------------------------------------------------------------
// 属性 schema 校验
// ------------------------------------------------------------

/**
按 schema 归一化 XML 节点的属性。
node 是 fast-xml-parser 解析出的对象，属性前缀为 @_。
返回 { ok, value, error }：value 是已套用默认值并完成类型转换的属性表。
*/
function normalizeAttrs(def, node) {
    const schema = def.schema;
    if (!schema) {
        return { ok: true, value: {} };
    }
    const attrsSpec = schema.attrs || {};
    const input = node && typeof node === "object" ? node : {};
    const value = {};
    const errors = [];
    const known = new Set(Object.keys(attrsSpec));

    if (schema.allowExtra !== true) {
        for (const key of Object.keys(input)) {
            if (key.indexOf(ATTR_PREFIX) !== 0) {
                continue;
            }
            const name = key.substring(ATTR_PREFIX.length);
            if (!known.has(name)) {
                errors.push(
                    "未知属性 " +
                        name +
                        "（允许：" +
                        (known.size ? Array.from(known).join(", ") : "无") +
                        "）"
                );
            }
        }
    }

    for (const name of Object.keys(attrsSpec)) {
        const spec = attrsSpec[name] || {};
        const raw = input[ATTR_PREFIX + name];
        if (raw === undefined || raw === null || raw === "") {
            if (spec.required) {
                errors.push("缺少必填属性 " + name);
                continue;
            }
            if (spec.default !== undefined) {
                value[name] = cloneValue(spec.default);
            }
            continue;
        }
        const coerced = coerceAttr(name, spec, raw);
        if (coerced.ok === false) {
            errors.push(coerced.error);
            continue;
        }
        value[name] = coerced.value;
    }

    if (errors.length > 0) {
        return { ok: false, value, error: errors.join("; ") };
    }
    return { ok: true, value };
}

function coerceAttr(name, spec, raw) {
    const type = spec.type || "string";
    if (type === "integer" || type === "number") {
        const number = Number(raw);
        if (!Number.isFinite(number)) {
            return { ok: false, error: name + " 必须是数字" };
        }
        if (type === "integer" && !Number.isInteger(number)) {
            return { ok: false, error: name + " 必须是整数" };
        }
        if (spec.min !== undefined && number < spec.min) {
            return { ok: false, error: name + " 必须 >= " + spec.min };
        }
        if (spec.max !== undefined && number > spec.max) {
            return { ok: false, error: name + " 必须 <= " + spec.max };
        }
        return { ok: true, value: number };
    }
    if (type === "boolean") {
        return { ok: true, value: toBoolean(raw) };
    }
    if (type === "enum") {
        const text = String(raw).trim();
        const values = Array.isArray(spec.values) ? spec.values : spec.enum || [];
        if (values.indexOf(text) === -1) {
            return { ok: false, error: name + " 必须是 " + values.join(" / ") };
        }
        return { ok: true, value: text };
    }
    const text = String(raw);
    if (spec.nonEmpty && !text.trim()) {
        return { ok: false, error: name + " 不能为空" };
    }
    if (spec.enum && spec.enum.length > 0 && spec.enum.indexOf(text) === -1) {
        return { ok: false, error: name + " 必须是 " + spec.enum.join(" / ") };
    }
    if (spec.maxLength && text.length > spec.maxLength) {
        return { ok: false, error: name + " 长度不能超过 " + spec.maxLength };
    }
    return { ok: true, value: text };
}

// ------------------------------------------------------------
// 插件 HTTP 路由（ctx.api）
// ------------------------------------------------------------

const API_PATH_PATTERN = /^\/[A-Za-z0-9_\-./]*$/;

/**
定义一个插件 HTTP 路由。
路径是**相对插件命名空间**的（"/summary" → /api/plugins/<name>/api/summary），
宿主据此保证插件只能暴露自己的接口，不可能注册到别人的路径上。
*/
function normalizeApiRoute(method, routePath, handler, options = {}) {
    const label = options.plugin ? "plugin " + options.plugin + " 的接口" : "插件接口";
    const verb = String(method || "GET")
        .trim()
        .toUpperCase();
    if (API_ROUTE_METHODS.indexOf(verb) === -1) {
        throw createError(
            "API_ROUTE_INVALID",
            label + " 的方法非法：" + verb + "（支持 " + API_ROUTE_METHODS.join(" / ") + "）"
        );
    }
    const pathText = String(routePath || "").trim();
    if (!pathText.startsWith("/")) {
        throw createError("API_ROUTE_INVALID", label + " 的路径必须以 / 开头：" + pathText);
    }
    if (pathText.length > 200) {
        throw createError("API_ROUTE_INVALID", label + " 的路径过长");
    }
    if (pathText.indexOf("..") !== -1) {
        throw createError("API_ROUTE_INVALID", label + " 的路径不允许包含 ..：" + pathText);
    }
    if (!API_PATH_PATTERN.test(pathText)) {
        throw createError(
            "API_ROUTE_INVALID",
            label + " 的路径只允许字母/数字/下划线/横线/点/斜线：" + pathText
        );
    }
    if (typeof handler !== "function") {
        throw createError(
            "API_ROUTE_INVALID",
            label + " " + verb + " " + pathText + " 缺少处理函数"
        );
    }
    return { method: verb, path: pathText, handler };
}

// ------------------------------------------------------------
// 声明式面板（ctx.ui.registerPanel）
// ------------------------------------------------------------

function normalizeBlock(block, index, label) {
    const where = label + " 的第 " + (index + 1) + " 个 block";
    if (!block || typeof block !== "object") {
        throw createError("PANEL_INVALID", where + " 必须是对象");
    }
    const kind = String(block.kind || "").trim();
    if (PANEL_BLOCK_KINDS.indexOf(kind) === -1) {
        throw createError(
            "PANEL_INVALID",
            where + " 的 kind 必须是 " + PANEL_BLOCK_KINDS.join(" / ") + "，收到：" + kind
        );
    }
    if (kind === "note") {
        const text = String(block.text || "").trim();
        if (!text) {
            throw createError("PANEL_INVALID", where + "（note）缺少 text");
        }
        return { kind: "note", text };
    }
    if (kind === "status") {
        const items = Array.isArray(block.items) ? block.items : [];
        if (items.length === 0) {
            throw createError("PANEL_INVALID", where + "（status）至少需要一个 item");
        }
        return {
            kind: "status",
            title: String(block.title || "").trim(),
            path: normalizeBlockPath(block.path, where),
            items: items.map((item) => ({
                label: String((item && item.label) || (item && item.value) || "?").trim(),
                value: String((item && item.value) || "").trim(),
            })),
        };
    }
    if (kind === "table") {
        const columns = Array.isArray(block.columns) ? block.columns : [];
        if (columns.length === 0) {
            throw createError("PANEL_INVALID", where + "（table）至少需要一列");
        }
        return {
            kind: "table",
            title: String(block.title || "").trim(),
            path: normalizeBlockPath(block.path, where),
            rows: String(block.rows || "rows").trim() || "rows",
            columns: columns.map((column) => ({
                key: String((column && column.key) || "").trim(),
                label: String((column && column.label) || (column && column.key) || "").trim(),
            })),
            empty: String(block.empty || "No data yet").trim(),
        };
    }
    // action
    const actionPath = normalizeBlockPath(block.path, where);
    const actionLabel = String(block.label || "").trim();
    if (!actionLabel) {
        throw createError("PANEL_INVALID", where + "（action）缺少 label");
    }
    const method = String(block.method || "POST")
        .trim()
        .toUpperCase();
    if (API_ROUTE_METHODS.indexOf(method) === -1) {
        throw createError("PANEL_INVALID", where + "（action）的 method 非法：" + method);
    }
    return {
        kind: "action",
        label: actionLabel,
        description: String(block.description || "").trim(),
        method,
        path: actionPath,
        body: block.body && typeof block.body === "object" ? block.body : null,
    };
}

function normalizeBlockPath(value, where) {
    const text = String(value || "").trim();
    if (!text || !text.startsWith("/")) {
        throw createError(
            "PANEL_INVALID",
            where + " 缺少 path（相对插件接口命名空间，需以 / 开头）"
        );
    }
    return text;
}

/**
归一化一个声明式面板：宿主只按 blocks 渲染，插件不提供任何可执行代码。
*/
function normalizePanel(raw, options = {}) {
    const pluginName = options.plugin || "";
    const label = pluginName ? "plugin " + pluginName + " 的面板" : "面板";
    if (!raw || typeof raw !== "object") {
        throw createError("PANEL_INVALID", label + " 必须是对象");
    }
    const id = String(raw.id || pluginName || "panel").trim();
    if (!PLUGIN_NAME_PATTERN.test(id)) {
        throw createError("PANEL_INVALID", label + " 的 id 非法：" + id);
    }
    const title = String(raw.title || id).trim();
    if (!title) {
        throw createError("PANEL_INVALID", label + " 缺少 title");
    }
    const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
    return {
        id,
        title,
        description: String(raw.description || "").trim(),
        blocks: blocks.map((block, index) => normalizeBlock(block, index, label)),
    };
}

// ------------------------------------------------------------
// 契约自检：任何第三方插件都可以用它验证自己是否符合 API
// ------------------------------------------------------------

function assertPluginConformance(plugin) {
    if (!plugin || typeof plugin !== "object") {
        throw createError("CONFORMANCE", "插件必须导出 { setup(ctx) } 对象");
    }
    if (typeof plugin.setup !== "function") {
        throw createError("CONFORMANCE", "插件必须实现 setup(ctx)");
    }
    const registered = {
        actions: [],
        hooks: [],
        formatters: [],
    };
    const ctx = {
        plugin: {
            name: "conformance",
            version: "0.0.0",
            kind: "action",
            dir: "",
            source: "user",
        },
        config: {},
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {},
        },
        actions: {
            register(def) {
                registered.actions.push(defineAction(def, { plugin: "conformance" }));
            },
        },
        hooks: {
            on(event, handler) {
                if (typeof event !== "string" || !event.trim()) {
                    throw createError("CONFORMANCE", "hooks.on(event) 的 event 必须是非空字符串");
                }
                if (typeof handler !== "function") {
                    throw createError(
                        "CONFORMANCE",
                        "hooks.on(event, handler) 的 handler 必须是函数"
                    );
                }
                registered.hooks.push(event);
            },
        },
        eventFormatters: {
            register(type, formatter) {
                if (typeof formatter !== "function") {
                    throw createError("CONFORMANCE", "eventFormatters.register 需要函数");
                }
                registered.formatters.push(type);
            },
        },
        providers: {
            register() {},
        },
        ui: {
            registerPanel() {},
            registerSettings() {},
            registerComposerAction() {},
        },
    };
    plugin.setup(ctx);
    return registered;
}

module.exports = {
    API_VERSION,
    API_ROUTE_METHODS,
    PANEL_BLOCK_KINDS,
    PERMISSION_SCOPES,
    PLUGIN_KINDS,
    RESERVED_ACTION_NAMES,
    ATTR_PREFIX,
    createError,
    parseVersion,
    compareVersions,
    satisfiesEngines,
    normalizeManifest,
    normalizePermissions,
    normalizeConfigSchema,
    normalizeConfig,
    configDefaults,
    defineAction,
    normalizeAttrs,
    normalizeApiRoute,
    normalizePanel,
    toBoolean,
    assertPluginConformance,
};
