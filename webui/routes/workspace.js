/**
工作区浏览与新建目录接口（从 server.js 拆出）

GET  /api/workspace/browse?path=   列出目录（Windows 下空路径返回盘符列表）
POST /api/workspace/mkdir          在指定目录下新建单层文件夹（供 WorkspacePicker 使用）
*/

const fs = require("fs");
const path = require("path");

const BACKSLASH = String.fromCharCode(92);

function getWindowsDrives() {
    const drives = [];
    for (let code = 65; code <= 90; code += 1) {
        const letter = String.fromCharCode(code);
        const drive = letter + ":" + BACKSLASH;
        try {
            if (fs.statSync(drive).isDirectory()) {
                drives.push({
                    name: letter + ":",
                    path: drive,
                });
            }
        } catch (error) {
            // Drive is unavailable or inaccessible.
        }
    }
    return drives;
}

function getDirectoryEntries(targetPath) {
    return fs
        .readdirSync(targetPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
            name: entry.name,
            path: path.join(targetPath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function registerWorkspaceRoutes(app) {
    app.get("/api/workspace/browse", (req, res) => {
        const requestedPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
        if (!requestedPath && process.platform === "win32") {
            return res.json({
                path: "",
                displayPath: "This PC",
                parent: null,
                isRootList: true,
                entries: getWindowsDrives(),
            });
        }
        const targetPath = requestedPath
            ? path.resolve(requestedPath)
            : path.parse(process.cwd()).root;
        try {
            const stat = fs.statSync(targetPath);
            if (!stat.isDirectory()) {
                return res.status(400).json({
                    error: "Not a directory: " + targetPath,
                });
            }
            return res.json({
                path: targetPath,
                displayPath: targetPath,
                parent: path.dirname(targetPath) === targetPath ? null : path.dirname(targetPath),
                isRootList: false,
                entries: getDirectoryEntries(targetPath),
            });
        } catch (error) {
            return res.status(400).json({
                error: "Unable to browse path: " + error.message,
            });
        }
    });

    // 在当前浏览目录下新建文件夹，供 WorkspacePicker 的 "New Folder" 按钮使用。
    app.post("/api/workspace/mkdir", (req, res) => {
        const parentPath =
            req.body && typeof req.body.path === "string" ? req.body.path.trim() : "";
        const folderName =
            req.body && typeof req.body.name === "string" ? req.body.name.trim() : "";
        if (!parentPath) {
            return res.status(400).json({
                error: "Parent path is required",
            });
        }
        if (!folderName) {
            return res.status(400).json({
                error: "Folder name is required",
            });
        }
        // 仅允许新建单层文件夹名，禁止路径分隔符与非法字符，避免越权创建。
        if (
            folderName === "." ||
            folderName === ".." ||
            folderName.indexOf("/") !== -1 ||
            folderName.indexOf(BACKSLASH) !== -1 ||
            /[:*?"<>|]/.test(folderName)
        ) {
            return res.status(400).json({
                error: "Invalid folder name: " + folderName,
            });
        }
        const resolvedParent = path.resolve(parentPath);
        try {
            const stat = fs.statSync(resolvedParent);
            if (!stat.isDirectory()) {
                return res.status(400).json({
                    error: "Not a directory: " + resolvedParent,
                });
            }
        } catch (error) {
            return res.status(400).json({
                error: "Unable to access path: " + error.message,
            });
        }
        const targetPath = path.join(resolvedParent, folderName);
        if (fs.existsSync(targetPath)) {
            return res.status(409).json({
                error: "Folder already exists: " + folderName,
            });
        }
        try {
            fs.mkdirSync(targetPath);
            return res.json({
                message: "Folder created",
                name: folderName,
                path: targetPath,
                parent: resolvedParent,
            });
        } catch (error) {
            return res.status(500).json({
                error: "Unable to create folder: " + error.message,
            });
        }
    });
}

module.exports = {
    registerWorkspaceRoutes,
    getWindowsDrives,
    getDirectoryEntries,
};
