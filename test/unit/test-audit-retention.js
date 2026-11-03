/**
audit-log 保留策略单测

原来的实现只在日志里打印"保留 14 天（不自动删除）"——配置形同虚设，
插件私有目录只会一直长。这里验证：超出 keepDays 的整日日志文件真的被删掉，
窗口内的文件和无关文件都不动。

用的是真实 storage 门面 + 临时目录，所以断言看到的是磁盘结果。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStorage } = require("../../plugins/capabilities");
const auditLog = require("../../plugins/builtin/audit-log/index.js");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function dayStamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
}

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "audit-retention-"));
}

function daysAgo(days) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - days);
    return date;
}

/** 造一批日志文件，返回文件名列表。 */
function seedFiles(dir, offsets) {
    fs.mkdirSync(dir, { recursive: true });
    const names = offsets.map((days) => "audit-" + dayStamp(daysAgo(days)) + ".jsonl");
    for (const name of names) {
        fs.writeFileSync(path.join(dir, name), '{"event":"runtime.result"}\n', "utf8");
    }
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me", "utf8");
    return names;
}

/** 最小可用插件 ctx：只实现 audit-log 会用到的那几项。 */
function makeContext(dir, keepDays) {
    const logs = [];
    const logger = {
        info: (message) => logs.push("info:" + message),
        warn: (message) => logs.push("warn:" + message),
        error: (message) => logs.push("error:" + message),
        debug: () => {},
    };
    return {
        logs,
        config: { keepDays },
        logger,
        storage: createStorage({ dir }),
        hooks: { on() {} },
        api: { get() {} },
        ui: { registerPanel() {} },
    };
}

function readDir(dir) {
    return fs.readdirSync(dir).sort();
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function main() {
    // 1. keepDays = 14：删掉 20 天前与 14 天前，保留 13 天前及更新
    const dir = makeTempDir();
    const names = seedFiles(dir, [20, 14, 13, 1, 0]);
    const ctx = makeContext(dir, 14);
    auditLog.setup(ctx);
    const left = readDir(dir);
    check("20 天前的日志被删除", !left.includes(names[0]), names[0]);
    check("14 天前的日志被删除（窗口是含今天共 14 天）", !left.includes(names[1]), names[1]);
    check("13 天前的日志保留", left.includes(names[2]), names[2]);
    check("昨天的日志保留", left.includes(names[3]), names[3]);
    check("今天的日志保留", left.includes(names[4]), names[4]);
    check("无关文件不被误删", left.includes("notes.txt"));
    check(
        "清理动作写进日志",
        ctx.logs.some((line) => line.indexOf("已清理 2 个") !== -1),
        ctx.logs.join(" | ")
    );
    cleanup(dir);

    // 2. keepDays = 0：明确表示"不清理"
    const dir2 = makeTempDir();
    const names2 = seedFiles(dir2, [200, 30]);
    const ctx2 = makeContext(dir2, 0);
    auditLog.setup(ctx2);
    const left2 = readDir(dir2);
    check(
        "keepDays=0 时一个都不删",
        names2.every((name) => left2.includes(name)),
        left2.join(",")
    );
    cleanup(dir2);

    // 3. 目录不存在时不应抛错（首次启动就是这个状态）
    const dir3 = path.join(makeTempDir(), "not-created-yet");
    const ctx3 = makeContext(dir3, 14);
    let threw = false;
    try {
        auditLog.setup(ctx3);
    } catch (error) {
        threw = true;
    }
    check("存储目录不存在时不抛错", threw === false);
    cleanup(path.dirname(dir3));

    // 4. storage.remove 对不存在的文件返回 false，而不是抛错
    const dir4 = makeTempDir();
    const storage = createStorage({ dir: dir4 });
    check("remove 不存在的文件返回 false", storage.remove("audit-19990101.jsonl") === false);
    check("list 空目录返回空数组", Array.isArray(storage.list()) && storage.list().length === 0);
    cleanup(dir4);

    console.log("");
    console.log("total " + total + ", pass " + pass + ", fail " + (total - pass));
    if (pass !== total) {
        process.exitCode = 1;
    }
}

main();
