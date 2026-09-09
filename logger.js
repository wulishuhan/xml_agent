/**

Simple logger with log level control.

Levels: error, warn, info, debug, trace (default: info)

Set LOG_LEVEL environment variable to control.
*/

const levels = ["error", "warn", "info", "debug", "trace"];

function getLogLevel() {
    const env = process.env.LOG_LEVEL || "info";
    const level = env.toLowerCase();
    const index = levels.indexOf(level);
    return index >= 0 ? index : 2; // default info
}

const currentLevelIndex = getLogLevel();

function shouldLog(level) {
    const levelIndex = levels.indexOf(level);
    return levelIndex >= 0 && levelIndex <= currentLevelIndex;
}

function formatMessage(level, args) {
    const timestamp = new Date().toISOString();
    const prefix = "[" + timestamp + "] [" + level.toUpperCase() + "]";
    return [prefix, ...args];
}

function createLogger() {
    const logger = {};

    levels.forEach((level) => {
        logger[level] = function (...args) {
            if (!shouldLog(level)) return;
            const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
            console[method](...formatMessage(level, args));
        };
    });

    // Alias for convenience
    logger.log = logger.info;

    return logger;
}

const logger = createLogger();

module.exports = logger;
