const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

/**

会话持久化存储。

每个 WebUI 会话保存为一个独立的 JSON 文件，位于用户主目录下的

~/.xml-agent/webui-sessions/<id>.json

而不是项目目录或用户 workspace，避免污染别人的代码仓库。

保存内容：会话元信息 + 输出记录（getInfo + output）。
*/

const STORE_ROOT = path.join(os.homedir(), ".xml-agent", "webui-sessions");

function ensureStoreRoot() {
    fs.mkdirSync(STORE_ROOT, { recursive: true });
    return STORE_ROOT;
}

function sessionFilePath(id) {
    // 会话 id 是内部生成的 uuid，但这里仍然做一次路径安全校验
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(STORE_ROOT, safeId + ".json");
}

function saveSession(session) {
    if (!session || !session.id) {
        return null;
    }

    ensureStoreRoot();

    return atomicWrite(sessionFilePath(session.id), {
        version: 1,
        savedAt: Date.now(),
        info: session.getInfo(),
        output: session.getOutput(),
    });
}

/**
写一条会话记录（不经过 AgentSession 实例）。

"把记忆从一个会话搬到另一个会话"这类操作需要落地一个可能还没被创建过的会话 id，
那时没有实例可以调 saveSession。payload 形状与 saveSession 写盘的一致，
version / savedAt 在这里统一补齐，调用方只需给 info 与 output。

info.id 以参数 id 为准：避免调用方拼错对象导致文件内容和文件名对不上。
*/
function writeRecord(id, payload) {
    const recordId = String(id || "").trim();
    if (!recordId) {
        throw new Error("Session id is required");
    }
    const info = payload && payload.info ? payload.info : null;
    if (!info) {
        throw new Error("Session record requires info");
    }

    ensureStoreRoot();

    return atomicWrite(sessionFilePath(recordId), {
        version: 1,
        savedAt: Date.now(),
        info: Object.assign({}, info, { id: recordId }),
        output: Array.isArray(payload.output) ? payload.output : [],
    });
}

/** 原子写：先写 .tmp 再 rename，避免写一半崩溃留下半个 JSON。 */
function atomicWrite(filePath, payload) {
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
    return filePath;
}

function deleteSession(id) {
    if (!id) {
        return false;
    }

    const filePath = sessionFilePath(id);

    if (!fs.existsSync(filePath)) {
        return false;
    }

    fs.unlinkSync(filePath);
    return true;
}

function listSavedSessions() {
    ensureStoreRoot();

    const files = fs.readdirSync(STORE_ROOT).filter((name) => name.endsWith(".json"));

    const records = [];

    for (const name of files) {
        const filePath = path.join(STORE_ROOT, name);

        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);

            if (parsed && parsed.info) {
                records.push(parsed);
            }
        } catch (error) {
            // 忽略损坏的会话文件，避免阻塞启动
        }
    }

    return records;
}

function loadSession(id) {
    const filePath = sessionFilePath(id);

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
    } catch (error) {
        return null;
    }
}

/**

统计会话存储目录的磁盘占用情况。

返回：

count：会话文件（.json）数量

bytes：所有会话文件的总体积（bytes）

largest：单个最大会话文件的大小与 id

orphanTmpBytes：遗留的 .tmp 临时文件占用（异常中断可能残留）
*/
function getStoreStats() {
    ensureStoreRoot();

    const names = fs.readdirSync(STORE_ROOT);

    let count = 0;
    let bytes = 0;
    let orphanTmpBytes = 0;
    let largest = null;

    for (const name of names) {
        const filePath = path.join(STORE_ROOT, name);

        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (error) {
            continue;
        }

        if (!stat.isFile()) {
            continue;
        }

        if (name.endsWith(".json")) {
            count += 1;
            bytes += stat.size;

            if (!largest || stat.size > largest.bytes) {
                largest = {
                    id: name.replace(/.json$/, ""),
                    bytes: stat.size,
                };
            }
        } else if (name.endsWith(".tmp")) {
            // 遗留的临时文件：写盘中途崩溃才会出现
            orphanTmpBytes += stat.size;
        }
    }

    return {
        root: STORE_ROOT,
        count,
        bytes,
        largest,
        orphanTmpBytes,
    };
}

/**

清理遗留的 .tmp 临时文件（正常写入流程会 rename 掉，不会残留）。

返回清理掉的字节数。
*/
function cleanOrphanTmpFiles() {
    ensureStoreRoot();

    const names = fs.readdirSync(STORE_ROOT);
    let cleaned = 0;

    for (const name of names) {
        if (!name.endsWith(".tmp")) {
            continue;
        }

        const filePath = path.join(STORE_ROOT, name);

        try {
            const stat = fs.statSync(filePath);
            fs.unlinkSync(filePath);
            cleaned += stat.size;
        } catch (error) {
            // 忽略：文件可能已被其它进程删除
        }
    }

    return cleaned;
}

module.exports = {
    STORE_ROOT,
    saveSession,
    writeRecord,
    deleteSession,
    listSavedSessions,
    loadSession,
    getStoreStats,
    cleanOrphanTmpFiles,
};
