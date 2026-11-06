/**
配置与权限：读写插件配置、启停、权限策略。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const sdk = require("../sdk");

const { VALID_POLICIES } = require("./shared");

// 密钥名：允许字母数字与 _ . -，首字符不能是点（避免隐藏文件式怪名）
const SECRET_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
// 原型链上的名字不能当键往里写
const RESERVED_SECRET_KEYS = ["__proto__", "prototype", "constructor"];
const MAX_SECRET_LENGTH = 8192;

function assertSecretKey(key) {
    const name = String(key === undefined || key === null ? "" : key).trim();
    if (!SECRET_KEY_PATTERN.test(name) || RESERVED_SECRET_KEYS.indexOf(name) !== -1) {
        throw sdk.createError(
            "SECRET_INVALID",
            "密钥名非法：" + name + "（只允许字母数字与 _ . -，长度 1~64）"
        );
    }
    return name;
}

module.exports = {
    getConfig(name) {
        const record = this.plugins.get(String(name || ""));
        if (!record) {
            return {};
        }
        const stored = this._readConfigStore()[record.name] || {};
        return sdk.normalizeConfig(record.manifest, stored).value;
    },

    setConfig(name, patch) {
        const record = this.plugins.get(String(name || ""));
        if (!record) {
            throw sdk.createError("PLUGIN_NOT_FOUND", "未知插件：" + name);
        }
        // 缓存里拿到的是共享对象，改动前先浅拷贝，避免污染缓存
        const store = Object.assign({}, this._readConfigStore());
        const merged = Object.assign({}, store[record.name] || {}, patch || {});
        const normalized = sdk.normalizeConfig(record.manifest, merged);
        if (!normalized.ok) {
            throw sdk.createError(
                "CONFIG_INVALID",
                "配置校验失败：" + normalized.errors.join("; ")
            );
        }
        store[record.name] = normalized.value;
        this._writeConfigStore(store);
        return normalized.value;
    },

    setEnabled(name, enabled) {
        const record = this.getPlugin(name);
        if (!record) {
            throw sdk.createError("PLUGIN_NOT_FOUND", "未知插件：" + name);
        }
        const state = Object.assign({}, this._readState());
        state[record.name] = Object.assign({}, state[record.name], {
            enabled: enabled !== false,
            updatedAt: new Date().toISOString(),
        });
        this._writeState(state);
        this.reload();
        const updated = this.getPlugin(name);
        return updated
            ? this.getStatus().filter((item) => item.name === updated.name)[0] || null
            : null;
    },

    /**
    权限策略优先级：用户显式授权 > 内置插件默认 allow > 其它（用户插件）默认 ask。
    "ask" 在 v1 表示"未授权，拒绝执行并提示用户去授权"，不做挂起阻塞式确认。
    */
    getPolicy(scope, record) {
        const name = String(scope || "");
        const file = this._readPermissions();
        if (typeof file[name] === "string" && VALID_POLICIES.indexOf(file[name]) !== -1) {
            return file[name];
        }
        if (record && record.source === "builtin") {
            return "allow";
        }
        return "ask";
    },

    getPermissions() {
        const file = this._readPermissions();
        const policy = {};
        for (const scope of sdk.PERMISSION_SCOPES) {
            policy[scope] = typeof file[scope] === "string" ? file[scope] : null;
        }
        return { scopes: sdk.PERMISSION_SCOPES.slice(), policy };
    },

    grantPermission(scope, policy) {
        const name = String(scope || "");
        if (sdk.PERMISSION_SCOPES.indexOf(name) === -1) {
            throw sdk.createError("PERMISSION_UNKNOWN", "未知权限 scope：" + name);
        }
        const value = String(policy || "allow");
        if (VALID_POLICIES.indexOf(value) === -1) {
            throw sdk.createError("PERMISSION_INVALID", "策略必须是 " + VALID_POLICIES.join(" / "));
        }
        const file = Object.assign({}, this._readPermissions());
        file[name] = value;
        this._writePermissions(file);
        return this.getPermissions();
    },

    /**
    密钥管理：只对外暴露"有哪些键、值多长"，永远不返回值本身。
    值一旦能通过 HTTP 读回来，前端的 XSS 就等于直接拿到所有凭据。
    */
    listSecrets() {
        const all = this._readSecrets();
        return Object.keys(all)
            .sort()
            .map((key) => ({
                key,
                length: typeof all[key] === "string" ? all[key].length : 0,
            }));
    },

    setSecret(key, value) {
        const name = assertSecretKey(key);
        const text = value === undefined || value === null ? "" : String(value);
        // 只拒绝"全是空白"的值；值本身不做 trim，密钥里可能有意义的前后空格
        if (!text.trim()) {
            throw sdk.createError("SECRET_INVALID", "密钥 " + name + " 的值不能为空");
        }
        if (text.length > MAX_SECRET_LENGTH) {
            throw sdk.createError(
                "SECRET_INVALID",
                "密钥 " + name + " 过长（上限 " + MAX_SECRET_LENGTH + " 字符）"
            );
        }
        const all = Object.assign({}, this._readSecrets());
        all[name] = text;
        this._writeSecrets(all);
        return this.listSecrets();
    },

    deleteSecret(key) {
        const name = assertSecretKey(key);
        const all = Object.assign({}, this._readSecrets());
        if (!Object.prototype.hasOwnProperty.call(all, name)) {
            return { removed: false, secrets: this.listSecrets() };
        }
        delete all[name];
        this._writeSecrets(all);
        return { removed: true, secrets: this.listSecrets() };
    },
};
