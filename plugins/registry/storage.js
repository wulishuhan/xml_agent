/**
注册表持久化：状态 / 配置 / 授权 / 插件私有数据目录。
全部以 registry 实例为 this 调用，方法体与原实现逐字一致。

以 mixin 形式挂到 PluginRegistry.prototype（见 ../registry.js），
方法体内的 this 指向 registry 实例。
*/

const fs = require("fs");
const path = require("path");

const {
    STORAGE_ROOT,
    LEGACY_STORAGE_SEGMENT,
    STATE_FILE,
    CONFIG_FILE,
    PERMISSIONS_FILE,
    SECRETS_FILE,
} = require("./shared");

module.exports = {
    _storePath(name) {
        return path.join(this.storeRoot, name);
    },

    _readJsonFile(filePath, fallback) {
        try {
            if (!fs.existsSync(filePath)) {
                return fallback;
            }
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return fallback;
            }
            return parsed;
        } catch (error) {
            this.logger.warn?.("[plugins] 读取失败 " + filePath + "：" + error.message);
            return fallback;
        }
    },

    /**
    带缓存的读取：这三个文件（状态 / 配置 / 权限）在"每个动作执行"路径上被反复读，
    一次动作原先要读盘解析 3 次 JSON。按 mtime + size 判断失效，
    外部编辑（用户手改 json）同样能立刻生效，缓存不会变陈旧。
    返回的对象是共享引用，调用方需要修改时先浅拷贝。
    */
    _readJsonCached(filePath, fallback) {
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (error) {
            this._fileCache.delete(filePath);
            return fallback;
        }
        const cached = this._fileCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.value;
        }
        const value = this._readJsonFile(filePath, fallback);
        this._fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
        return value;
    },

    _writeJsonFile(filePath, value) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tempPath = filePath + ".tmp";
        fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
        fs.renameSync(tempPath, filePath);
        this._rememberJson(filePath);
    },

    /**
    写盘后直接把内容放回缓存（而不是等下次 stat 比对），
    保证"写 → 读"在同一次调用链里也拿到新值。
    */
    _rememberJson(filePath) {
        try {
            const stat = fs.statSync(filePath);
            const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
            this._fileCache.set(filePath, {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                value,
            });
        } catch (error) {
            this._fileCache.delete(filePath);
        }
    },

    _readState() {
        return this._readJsonCached(this._storePath(STATE_FILE), {});
    },

    _writeState(state) {
        this._writeJsonFile(this._storePath(STATE_FILE), state);
    },

    _readConfigStore() {
        return this._readJsonCached(this._storePath(CONFIG_FILE), {});
    },

    _writeConfigStore(store) {
        this._writeJsonFile(this._storePath(CONFIG_FILE), store);
    },

    _readPermissions() {
        return this._readJsonCached(this._storePath(PERMISSIONS_FILE), {});
    },

    _writePermissions(value) {
        this._writeJsonFile(this._storePath(PERMISSIONS_FILE), value);
    },

    _secretsFile() {
        return this._storePath(SECRETS_FILE);
    },

    _readSecrets() {
        return this._readJsonCached(this._secretsFile(), {});
    },

    /**
    写密钥文件：与其它状态文件不同，这里额外把权限收紧到 0600
    （Windows 上 POSIX mode 不生效，属预期内的降级）。
    */
    _writeSecrets(value) {
        const filePath = this._secretsFile();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tempPath = filePath + ".tmp";
        fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), {
            encoding: "utf8",
            mode: 0o600,
        });
        fs.renameSync(tempPath, filePath);
        this._rememberJson(filePath);
        try {
            fs.chmodSync(filePath, 0o600);
        } catch (error) {
            // 平台不支持（例如 Windows）就保持默认权限
        }
    },

    /**
    插件私有数据目录。

    刻意不放在 <storeRoot>/plugins/<name>/data：那个位置同时是插件安装目录，
    load() 会把它的每个子目录当成一个待加载插件，于是数据目录会被误报成
    "缺少 plugin.json"。数据与安装分离后，插件根下只剩真正的插件。
    */
    storageDir(pluginName) {
        const dir = path.join(this.storeRoot, STORAGE_ROOT, pluginName);
        this._migrateLegacyStorage(pluginName, dir);
        return dir;
    },

    /**
    把旧版（数据放在插件目录下）的存储迁移到新位置。

    旧目录存在就搬，逐文件 rename；遇到同名文件改名成 <name>.migrated 保留，
    既不覆盖新目录的内容，也不把老数据留在原地——老目录只要还留着东西，
    下次启动又会被当成插件扫描，回到"缺少 plugin.json"的老问题。
    搬完后只尝试删除空目录；任何异常都只告警，不能让插件因为迁移失败而加载不了。
    */
    _migrateLegacyStorage(pluginName, target) {
        const legacy = path.join(this.storeRoot, "plugins", pluginName, LEGACY_STORAGE_SEGMENT);
        if (!fs.existsSync(legacy)) {
            return;
        }
        try {
            fs.mkdirSync(target, { recursive: true });
            for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
                const from = path.join(legacy, entry.name);
                let to = path.join(target, entry.name);
                if (fs.existsSync(to)) {
                    to = to + ".migrated";
                }
                fs.renameSync(from, to);
            }
            this._removeIfEmpty(legacy);
            this._removeIfEmpty(path.dirname(legacy));
            this.logger.info?.("[plugins] 已迁移插件数据目录：" + pluginName);
        } catch (error) {
            this.logger.warn?.(
                "[plugins] 迁移插件数据目录失败 " + pluginName + "：" + error.message
            );
        }
    },

    _removeIfEmpty(dir) {
        try {
            fs.rmdirSync(dir);
        } catch (error) {
            // 目录非空或不存在都属于正常情况，保持原样
        }
    },
};
