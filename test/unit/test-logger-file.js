/**
logger.js 文件 sink 的断言测试。

覆盖四类容易出错的地方：
1. 默认必须是关闭的（不能因为引用 logger 就往用户主目录写文件）；
2. 级别过滤对文件同样生效（否则 LOG_LEVEL 形同虚设）；
3. 轮转必须真的删老文件，且总文件数有上限（日志不能变成磁盘黑洞）；
4. 写不进去时只能静默降级，绝不能抛错打断主流程。

注意：logger 是单例，本文件结束时会把状态复原；每个测试文件是独立进程，
所以中途接管 console 不会影响别的测试。
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const logger = require("../../logger");

let passed = 0;
const lines = [];

function check(name, fn) {
    try {
        fn();
        passed++;
        lines.push("PASS - " + name);
    } catch (error) {
        lines.push("FAIL - " + name);
        lines.push("       " + error.message);
        process.exitCode = 1;
    }
}

/** 批量写入测试会产生几百行终端噪声，临时静音 console（logger 照常写文件）。 */
function silenceConsole() {
    const original = console.log;
    console.log = () => {};
    return () => {
        console.log = original;
    };
}

const originalLevel = logger.getLogLevel();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "xa-log-"));

check("默认关闭，不写任何文件", () => {
    assert.strictEqual(logger.getLogFilePath(), null, "未启用时不应有日志路径");
});

const logDir = path.join(root, "logs");
let logPath = null;

check("启用后返回可用路径", () => {
    logPath = logger.enableFileLogging({ dir: logDir, maxBytes: 4096, maxFiles: 2 });
    assert.ok(logPath, "应返回路径");
    assert.ok(fs.existsSync(logDir), "日志目录应被创建");
    // 文件在第一次写入时才落地（不预先写空文件）
    assert.strictEqual(logger.getLogFilePath(), logPath);
});

check("info 带时间戳与级别前缀写入", () => {
    logger.info("hello %s", "world");
    const text = fs.readFileSync(logPath, "utf8");
    assert.ok(text.includes("[INFO] hello world"), "实际内容: " + JSON.stringify(text));
    assert.ok(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text), "行首应有 ISO 时间戳");
});

check("级别过滤对文件同样生效", () => {
    logger.setLogLevel("warn");
    logger.info("should-be-filtered");
    assert.ok(
        !fs.readFileSync(logPath, "utf8").includes("should-be-filtered"),
        "info 在 warn 级别下不该落盘"
    );
    logger.warn("kept-line");
    assert.ok(fs.readFileSync(logPath, "utf8").includes("kept-line"));
    logger.setLogLevel(originalLevel);
});

check("超过 maxBytes 触发轮转", () => {
    const restore = silenceConsole();
    try {
        for (let i = 0; i < 80; i++) {
            logger.info("padding-" + i + " " + "x".repeat(100));
        }
    } finally {
        restore();
    }
    assert.ok(fs.existsSync(path.join(logDir, "xml-agent.1.log")), "应生成 xml-agent.1.log");
});

check("轮转文件数不超过 maxFiles", () => {
    const restore = silenceConsole();
    try {
        for (let i = 0; i < 300; i++) {
            logger.info("more-" + i + " " + "y".repeat(80));
        }
    } finally {
        restore();
    }
    const rotated = fs.readdirSync(logDir).filter((name) => /^xml-agent\.\d+\.log$/.test(name));
    assert.ok(rotated.length <= 2, "轮转文件应 <= 2 个，实际 " + rotated.length);
    // 当前文件必须存在，否则日志断了
    assert.ok(fs.existsSync(path.join(logDir, "xml-agent.log")));
});

check("目录不可用时返回 null 且不抛错", () => {
    const blocked = path.join(root, "blocked-by-file");
    fs.writeFileSync(blocked, "not a directory");
    let result = "sentinel";
    assert.doesNotThrow(() => {
        result = logger.enableFileLogging({ dir: blocked });
    });
    assert.strictEqual(result, null);
    assert.strictEqual(logger.getLogFilePath(), null);
});

check("目录被删除后写入静默降级", () => {
    const vanishDir = path.join(root, "vanish");
    logger.enableFileLogging({ dir: vanishDir });
    fs.rmSync(vanishDir, { recursive: true, force: true });
    // 写不进去只累加失败计数，不抛错
    assert.doesNotThrow(() => logger.info("after dir removed"));
});

check("接管 console 后 console.log 落盘，且 logger 行不重复", () => {
    const consoleDir = path.join(root, "console");
    const consoleLog = logger.enableFileLogging({ dir: consoleDir });
    assert.ok(consoleLog, "应能启用");
    assert.strictEqual(logger.captureConsole(), true, "首次接管应成功");

    console.log("plain-console-line");
    logger.info("via-logger-line");

    const text = fs.readFileSync(consoleLog, "utf8");
    assert.ok(text.includes("plain-console-line"), "console.log 应被镜像进文件");
    const occurrences = text.split("via-logger-line").length - 1;
    assert.strictEqual(occurrences, 1, "logger 行不应重复写入，实际 " + occurrences + " 次");
});

// 复原：关掉文件 sink，避免后续（或人工）调试时残留状态
logger.disableFileLogging();
logger.setLogLevel(originalLevel);

try {
    fs.rmSync(root, { recursive: true, force: true });
} catch (error) {
    // 临时目录删不掉不影响结论
}

lines.forEach((line) => console.log(line));
console.log("\nTotal: " + passed + " passed");
