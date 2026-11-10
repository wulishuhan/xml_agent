/**

Simple logger with log level control, plus an optional file sink.

Levels: error, warn, info, debug, trace (default: info)
Set LOG_LEVEL environment variable to control, or call setLogLevel() at runtime.

为什么需要落盘：桌面端打包后没有终端，console 输出全部蒸发。而所有关键路径
本来就打了日志（执行了什么命令、provider 关没关上、子进程杀没杀），用户报障时
却只能凭记忆描述现象——缺的不是日志，是一个落点。

写入策略（刻意保守）：
- 默认关闭。只有入口（electron/main.js、webui/server.js）显式调用
  enableFileLogging() 才写文件，单测与 CLI 不该往用户主目录塞文件。
- 同步 append。日志量小（info 级、单条 KB 以内），换来的是进程崩溃前最后
  几行一定在盘上；异步队列反而会把最关键的现场丢掉。
- 硬上限 2MB × 3 个文件。日志绝不能变成新的磁盘黑洞，尤其当系统盘已经
  所剩无几的时候。
- 写入失败只累加计数，连续失败到阈值就自己关掉，绝不因为写日志抛错打断主流程。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");

const levels = ["error", "warn", "info", "debug", "trace"];

const DEFAULT_LOG_DIR = path.join(os.homedir(), ".xml-agent", "logs");
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
// 连续这么多次写不进去就放弃（磁盘满 / 目录被删 / 权限变化）
const MAX_CONSECUTIVE_FAILURES = 10;

/** 当前日志级别。运行期读缓存，改级别走 setLogLevel()，不必每次碰 process.env。 */
let levelIndex = readLevelFromEnv();

function readLevelFromEnv() {
    const env = (process.env.LOG_LEVEL || "info").toLowerCase();
    const index = levels.indexOf(env);
    return index >= 0 ? index : 2; // default info
}

function setLogLevel(name) {
    const index = levels.indexOf(String(name || "").toLowerCase());
    if (index < 0) {
        return levels[levelIndex];
    }
    levelIndex = index;
    return levels[levelIndex];
}

function shouldLog(level) {
    const index = levels.indexOf(level);
    return index >= 0 && index <= levelIndex;
}

function formatMessage(level, args) {
    const timestamp = new Date().toISOString();
    const prefix = "[" + timestamp + "] [" + level.toUpperCase() + "]";
    // 先合并成一条字符串再加前缀：如果直接把 prefix 放在最前面当格式串，
    // logger.info("%s 完成", name) 里的 %s 会原样打出来（格式串变成前缀了）。
    return [prefix, util.format(...args)];
}

// ---------------------------------------------------------------
// 文件 sink
// ---------------------------------------------------------------

const fileSink = {
    enabled: false,
    dir: "",
    file: "",
    maxBytes: DEFAULT_MAX_BYTES,
    maxFiles: DEFAULT_MAX_FILES,
    size: 0,
    failures: 0,
};

function positiveInt(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function activeLogName() {
    return "xml-agent.log";
}

function rotatedLogName(index) {
    return "xml-agent." + index + ".log";
}

/**
 * 打开文件 sink。返回当前日志文件路径；目录不可用时返回 null（不抛错）。
 * @param {{dir?: string, maxBytes?: number, maxFiles?: number}} [options]
 */
function enableFileLogging(options = {}) {
    const dir = options.dir ? path.resolve(options.dir) : DEFAULT_LOG_DIR;
    fileSink.dir = dir;
    fileSink.file = path.join(dir, activeLogName());
    fileSink.maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES);
    fileSink.maxFiles = positiveInt(options.maxFiles, DEFAULT_MAX_FILES);
    fileSink.failures = 0;

    try {
        fs.mkdirSync(dir, { recursive: true });
        fileSink.size = fs.existsSync(fileSink.file) ? fs.statSync(fileSink.file).size : 0;
        fileSink.enabled = true;
        return fileSink.file;
    } catch (error) {
        fileSink.enabled = false;
        fileSink.file = "";
        return null;
    }
}

function disableFileLogging() {
    const previous = fileSink.file;
    fileSink.enabled = false;
    return previous;
}

function getLogFilePath() {
    return fileSink.enabled ? fileSink.file : null;
}

/** 把当前文件挪到 .1，其余依次后移，最老的删掉。异常由调用方捕获。 */
function rotateLogFiles() {
    const oldest = path.join(fileSink.dir, rotatedLogName(fileSink.maxFiles));
    if (fs.existsSync(oldest)) {
        fs.unlinkSync(oldest);
    }
    for (let i = fileSink.maxFiles - 1; i >= 1; i--) {
        const from = path.join(fileSink.dir, rotatedLogName(i));
        const to = path.join(fileSink.dir, rotatedLogName(i + 1));
        if (fs.existsSync(from)) {
            fs.renameSync(from, to);
        }
    }
    if (fs.existsSync(fileSink.file)) {
        fs.renameSync(fileSink.file, path.join(fileSink.dir, rotatedLogName(1)));
    }
    fileSink.size = 0;
}

function writeToFile(level, args) {
    if (!fileSink.enabled) {
        return;
    }
    // util.format 能安全处理对象、循环引用与 %s 占位符，比手拼字符串稳
    let line;
    try {
        line = util.format(...formatMessage(level, args));
    } catch (error) {
        return;
    }
    appendLine(line);
}

/** 单行上限：一条日志最多 8000 字符，防止有人把整个对象/大段输出直接丢进来。 */
const MAX_LINE_CHARS = 8000;

function appendLine(line) {
    const text =
        line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + " …[line truncated]" : line;
    try {
        const bytes = Buffer.byteLength(text, "utf8") + 1;
        if (fileSink.size + bytes > fileSink.maxBytes) {
            rotateLogFiles();
        }
        fs.appendFileSync(fileSink.file, text + "\n", "utf8");
        fileSink.size += bytes;
        fileSink.failures = 0;
    } catch (error) {
        fileSink.failures++;
        if (fileSink.failures >= MAX_CONSECUTIVE_FAILURES) {
            fileSink.enabled = false;
        }
    }
}

// ---------------------------------------------------------------
// console 镜像（可选）
// ---------------------------------------------------------------

const originals = {};
let consoleCaptured = false;

/**
把 console.* 的输出同时镜像进日志文件。

为什么需要：electron/main.js 与 webui/* 里还有 40 处 console 调用（启动、
端口、关闭、路由错误），逐个改成 logger 收益不大、改动面却很广。接管 console
之后这些既有输出自动落盘，新代码用 logger 则能享受级别过滤。

logger 自己走 originals 输出，所以同一条日志不会被写两次。重复调用幂等。
*/
function captureConsole() {
    if (consoleCaptured) {
        return false;
    }
    const mapping = {
        log: "info",
        info: "info",
        debug: "debug",
        warn: "warn",
        error: "error",
    };
    for (const method of Object.keys(mapping)) {
        const original = console[method];
        if (typeof original !== "function") {
            continue;
        }
        originals[method] = original.bind(console);
        console[method] = function (...args) {
            originals[method](...args);
            writeToFile(mapping[method], args);
        };
    }
    consoleCaptured = true;
    return true;
}

// ---------------------------------------------------------------

function createLogger() {
    const logger = {};

    levels.forEach((level) => {
        logger[level] = function (...args) {
            if (!shouldLog(level)) return;
            writeToFile(level, args);
            const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
            // console 被接管后仍用原始引用输出，否则会再进一次 writeToFile
            const output = originals[method] || console[method].bind(console);
            output(...formatMessage(level, args));
        };
    });

    // Alias for convenience
    logger.log = logger.info;

    return logger;
}

const logger = createLogger();

// 写盘能力挂在同一个对象上，调用方按 logger.enableFileLogging() 使用
logger.enableFileLogging = enableFileLogging;
logger.disableFileLogging = disableFileLogging;
logger.getLogFilePath = getLogFilePath;
logger.setLogLevel = setLogLevel;
logger.getLogLevel = () => levels[levelIndex];
logger.captureConsole = captureConsole;

module.exports = logger;
