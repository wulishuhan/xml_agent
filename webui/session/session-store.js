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

    const payload = {
        version: 1,
        savedAt: Date.now(),
        info: session.getInfo(),
        output: session.getOutput(),
    };

    const filePath = sessionFilePath(session.id);
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

module.exports = {
    STORE_ROOT,
    saveSession,
    deleteSession,
    listSavedSessions,
    loadSession,
};
