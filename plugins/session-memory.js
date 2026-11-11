/**
会话记忆能力门面（插件侧 ctx.sessions）

插件不直接碰 ~/.xml-agent/webui-sessions：会话文件格式、落盘时机、内存与磁盘的
同步规则都属于宿主，插件只表达"把哪个会话的记忆搬到哪个会话"。

权限分两档：
- sessions:read  能列会话、读摘要（面板展示用）；
- sessions:write 能执行转移。写隐含读——transfer 内部必须先读源会话，
  只给写不给读没有意义，这里按"任一即放行读"处理。

未授权时返回形状相同的空门面（同 secrets 的处理）：插件读到空列表而不是
抛出 undefined，日志里再看一次 denied 就知道是被权限挡了。
*/

const sdk = require("./sdk");
const memoryTransfer = require("../webui/session/memory-transfer");

function deniedFacade(reason) {
    const deny = (method) => () => {
        throw sdk.createError("SESSIONS_DENIED", reason + "（" + method + "）");
    };
    return {
        denied: true,
        read: false,
        write: false,
        list: () => [],
        describe: () => ({ exists: false, denied: true }),
        transfer: deny("transfer"),
    };
}

/**
创建门面。

options:
    manager      宿主注入的 SessionManager（可为空：CLI 模式只操作磁盘）
    canRead      是否允许列会话 / 读摘要
    canWrite     是否允许转移
    maxRecords   单次搬运的 output 条数上限（插件配置 maxOutputRecords）
    compress     压缩档位 off/auto/light/strong（插件配置 compress）
    maxChars     字符预算（插件配置 maxChars）
    digest       摘要档位 off/auto/always（插件配置 digest）
    maxDigestChars 摘要字符预算（插件配置 maxDigestChars）
    writeDigest  写摘要的回调 (relativePath, markdown) => { path }；不传则摘要只回给调用方
    logger       插件作用域日志
*/
function createSessionMemory(options = {}) {
    const manager = options.manager || null;
    // 宿主可注入 store（单测用内存假件，避免读写真实 ~/.xml-agent/webui-sessions）。
    // 传 undefined 而不是 null：memory-transfer 的默认参数只在 undefined 时生效。
    const store = options.store || undefined;
    const canWrite = options.canWrite === true;
    const canRead = options.canRead === true || canWrite;
    const maxRecords = options.maxRecords;
    const compress = options.compress;
    const maxChars = options.maxChars;
    const digest = options.digest;
    const maxDigestChars = options.maxDigestChars;
    const writeDigest = options.writeDigest;
    const logger = options.logger || null;

    if (!canRead) {
        return deniedFacade("插件未声明或未获授权 sessions:read / sessions:write");
    }

    return {
        denied: false,
        read: true,
        write: canWrite,
        list(limit) {
            return memoryTransfer.listMemories({ manager, store, limit });
        },
        describe(id) {
            return memoryTransfer.describeById(id, { manager, store });
        },
        /** 只读预览：搬之前先看压缩能省多少。 */
        preview(params) {
            return memoryTransfer.previewCompression({
                from: params && params.from,
                compress: (params && params.compress) || compress,
                maxChars: (params && params.maxChars) || maxChars,
                maxRecords,
                manager,
                store,
            });
        },
        /** 只读预览：模型将会读到的那份摘要长什么样。 */
        previewDigest(params) {
            return memoryTransfer.previewDigest({
                from: params && params.from,
                to: params && params.to,
                maxChars: (params && params.maxChars) || maxDigestChars,
                manager,
                store,
            });
        },
        transfer(params) {
            if (!canWrite) {
                throw sdk.createError(
                    "SESSIONS_DENIED",
                    "插件未声明或未获授权 sessions:write，不能写会话记忆"
                );
            }
            const result = memoryTransfer.transfer({
                from: params && params.from,
                to: params && params.to,
                mode: params && params.mode,
                compress: (params && params.compress) || compress,
                maxChars: (params && params.maxChars) || maxChars,
                digest: (params && params.digest) || digest,
                maxDigestChars: (params && params.maxDigestChars) || maxDigestChars,
                writeDigest,
                maxRecords,
                manager,
                store,
            });
            if (logger) {
                logger.info(
                    "记忆转移 " +
                        result.from +
                        " → " +
                        result.to +
                        "（" +
                        result.mode +
                        "，" +
                        result.copied.records +
                        " 条，" +
                        (result.created ? "新建目标" : "覆盖目标") +
                        (result.compression
                            ? "，压缩 " +
                              result.compression.level +
                              " 省 " +
                              result.compression.savedPercent +
                              "%"
                            : "") +
                        (result.digest && result.digest.file
                            ? "，摘要 " + result.digest.file
                            : "") +
                        "）"
                );
            }
            return result;
        },
    };
}

module.exports = {
    createSessionMemory,
};
