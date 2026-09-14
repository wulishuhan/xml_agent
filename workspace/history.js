const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

/**
Create an isolated history store for one Agent execution.
Keeping history per execution is important for the reusable Agent core:
multiple sessions must not share a global history array.
*/
function createHistory() {
    return [];
}

/**
Create a History Record.
*/
function createHistoryRecord(step, action, result) {
    return {
        step,
        timestamp: new Date().toISOString(),
        action,
        result,
    };
}

/**

计算某个 workspace 对应的存储目录。

历史记录不再写进用户的 workspace（避免污染别人的代码仓库），

而是写到用户主目录下：

~/.xml-agent/workspaces/<workspace 路径哈希>/

目录中附一个 workspace.txt 保存原始路径，方便排查。
*/
function getWorkspaceStoreDir(workspace) {
    const resolved = path.resolve(workspace || process.cwd());
    const hash = crypto.createHash("sha1").update(resolved).digest("hex").slice(0, 16);
    return path.join(os.homedir(), ".xml-agent", "workspaces", hash);
}

function ensureWorkspaceStoreDir(workspace) {
    const dir = getWorkspaceStoreDir(workspace);

    fs.mkdirSync(dir, { recursive: true });

    const markerPath = path.join(dir, "workspace.txt");

    if (!fs.existsSync(markerPath)) {
        fs.writeFileSync(markerPath, path.resolve(workspace || process.cwd()), "utf8");
    }

    return dir;
}

/**
Save History.
The records argument is optional for backward compatibility with the
original global history API.
*/
function saveHistory(workspace, records = history) {
    const dir = ensureWorkspaceStoreDir(workspace);
    const historyPath = path.join(dir, "history.json");

    fs.writeFileSync(historyPath, JSON.stringify(records, null, 2), "utf8");

    return historyPath;
}

/**
Load History from workspace.
Returns the parsed history array, or null if not found.
*/
function loadHistory(workspace) {
    const historyPath = path.join(getWorkspaceStoreDir(workspace), "history.json");

    if (!fs.existsSync(historyPath)) {
        return null;
    }

    const content = fs.readFileSync(historyPath, "utf8");

    try {
        return JSON.parse(content);
    } catch (e) {
        throw new Error("Failed to parse history.json: " + e.message);
    }
}

/**
Legacy history store.
Existing callers can continue using:
const { history } = require("./history");
New Agent instances should use createHistory() instead.
*/
const history = [];

module.exports = {
    history,
    createHistory,
    createHistoryRecord,
    saveHistory,
    loadHistory,
    getWorkspaceStoreDir,
};
