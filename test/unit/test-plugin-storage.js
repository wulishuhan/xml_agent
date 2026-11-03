/**
插件数据目录单测（plugins/registry.js 的 storageDir / 旧目录迁移）

背景：插件数据原本写在 <storeRoot>/plugins/<name>/data，而 <storeRoot>/plugins
同时是"用户插件安装目录"，每次 load() 都会把这个数据目录当成一个待加载插件扫描，
报一条"缺少 plugin.json"的假故障。数据目录现在独立到 <storeRoot>/plugin-data/<name>。

这里锁定三件事：
1. 数据目录不在插件安装目录下；
2. 旧数据会被搬过来，且不覆盖新目录里已有的文件；
3. 迁移失败不能影响插件加载（errors 保持为空）。

运行：node test/unit/test-plugin-storage.js
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRegistry } = require("../../plugins/registry");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function makeStoreRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-storage-"));
}

// ------------------------------------------------------------
// 1. 目录位置
// ------------------------------------------------------------
{
    const storeRoot = makeStoreRoot();
    const registry = createRegistry({
        storeRoot,
        builtinDir: path.join(__dirname, "../../plugins/builtin"),
    });
    const dir = registry.storageDir("demo");

    check(
        "数据目录在 <storeRoot>/plugin-data/<name>",
        dir === path.join(storeRoot, "plugin-data", "demo"),
        dir
    );
    check(
        "数据目录不再是插件安装目录的子目录",
        dir.indexOf(path.join(storeRoot, "plugins") + path.sep) !== 0,
        dir
    );
}

// ------------------------------------------------------------
// 2. 旧目录迁移
// ------------------------------------------------------------
{
    const storeRoot = makeStoreRoot();
    const legacy = path.join(storeRoot, "plugins", "demo", "data");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "audit-20260101.jsonl"), '{"n":1}\n', "utf8");
    fs.writeFileSync(path.join(legacy, "keep.json"), '{"k":"old"}', "utf8");

    const registry = createRegistry({
        storeRoot,
        builtinDir: path.join(__dirname, "../../plugins/builtin"),
    });
    const dir = registry.storageDir("demo");

    check("迁移后文件出现在新目录", fs.existsSync(path.join(dir, "audit-20260101.jsonl")), dir);
    check(
        "迁移保留文件内容",
        fs.readFileSync(path.join(dir, "audit-20260101.jsonl"), "utf8").includes('"n":1'),
        "ok"
    );
    check("旧目录被清空并移除", !fs.existsSync(legacy), legacy);
    check(
        "旧插件目录整体移除（只剩空的安装根）",
        !fs.existsSync(path.join(storeRoot, "plugins", "demo")),
        "removed"
    );
    check("迁移没有产生加载错误", registry.errors.length === 0, String(registry.errors.length));
}

// ------------------------------------------------------------
// 3. 新目录已存在时不覆盖
// ------------------------------------------------------------
{
    const storeRoot = makeStoreRoot();
    const legacy = path.join(storeRoot, "plugins", "demo", "data");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "same.json"), '"legacy"', "utf8");
    fs.writeFileSync(path.join(legacy, "only-legacy.json"), '"legacy"', "utf8");

    const target = path.join(storeRoot, "plugin-data", "demo");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "same.json"), '"current"', "utf8");

    const registry = createRegistry({
        storeRoot,
        builtinDir: path.join(__dirname, "../../plugins/builtin"),
    });
    const dir = registry.storageDir("demo");

    check(
        "同名文件保留新目录内容",
        fs.readFileSync(path.join(dir, "same.json"), "utf8") === '"current"',
        "current"
    );
    check(
        "同名旧文件改名保留，不丢数据",
        fs.readFileSync(path.join(dir, "same.json.migrated"), "utf8") === '"legacy"',
        "migrated"
    );
    check("旧目录独有文件仍被搬入", fs.existsSync(path.join(dir, "only-legacy.json")), "moved");
    check("有冲突时旧目录也会被清空", !fs.existsSync(legacy), legacy);
}

// ------------------------------------------------------------
// 4. 插件根下没有数据目录时不再报"缺少 plugin.json"
// ------------------------------------------------------------
{
    const storeRoot = makeStoreRoot();
    const registry = createRegistry({
        storeRoot,
        builtinDir: path.join(__dirname, "../../plugins/builtin"),
    });
    registry.load();

    const names = registry.errors.map((item) => item.name);
    check("内置插件加载无错误", registry.errors.length === 0, JSON.stringify(names));
    check(
        "不再出现“缺少 plugin.json”的假故障",
        registry.errors.every((item) => String(item.message || "").indexOf("plugin.json") === -1),
        JSON.stringify(names)
    );
    check(
        "插件数据目录与插件安装目录分开",
        registry.storageDir("audit-log") === path.join(storeRoot, "plugin-data", "audit-log"),
        registry.storageDir("audit-log")
    );

    // 再触发一次：迁移是幂等的，重复调用不应报错或移动文件
    const again = registry.storageDir("audit-log");
    check("重复解析目录幂等", again === path.join(storeRoot, "plugin-data", "audit-log"), again);
    check("重复解析不产生错误", registry.errors.length === 0, String(registry.errors.length));
}

console.log("\nTotal: " + pass + "/" + total);
process.exit(pass === total ? 0 : 1);
