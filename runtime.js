const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { XMLParser } = require("fast-xml-parser");

/**
 * ============================================================
 * Workspace
 * ============================================================
 *
 * Workspace 必须由 Agent 启动时显式设置。
 *
 * 例如：
 *
 * setWorkspace("D:/project/my-project");
 *
 * Runtime 不再使用：
 *
 * process.cwd()
 *
 * 也不再固定使用：
 *
 * __dirname/workspace
 */

let WORKSPACE = null;

/**
 * 设置 Workspace
 */
function setWorkspace(workspace) {
  if (!workspace || typeof workspace !== "string") {
    throw new Error("Workspace path is required");
  }

  const resolved = path.resolve(workspace);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Workspace does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);

  if (!stat.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${resolved}`);
  }

  WORKSPACE = resolved;

  return WORKSPACE;
}

/**
 * 获取 Workspace
 */
function getWorkspace() {
  if (!WORKSPACE) {
    throw new Error("Workspace has not been configured");
  }

  return WORKSPACE;
}

const MAX_FILE_SIZE = 1024 * 1024 * 5; // 5MB
const MAX_READ_SIZE = 1024 * 1024 * 2; // 2MB
const MAX_EXEC_TIMEOUT = 120000; // 120秒

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
});

/**
 * ============================================================
 * 获取 XML 节点文本
 * ============================================================
 */
function getText(node) {
  if (node === undefined || node === null) {
    return "";
  }

  if (typeof node === "string") {
    return node;
  }

  if (typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }

  if (typeof node === "object") {
    if (node["#text"] !== undefined) {
      return String(node["#text"]);
    }
  }

  return "";
}

/**
 * ============================================================
 * Resolve Path
 * ============================================================
 *
 * 所有 XML Action 中的 path 都必须是 Workspace 相对路径。
 *
 * 例如：
 *
 * <read path="package.json"/>
 *
 * 实际：
 *
 * D:/project/my-project/package.json
 *
 * 同时禁止：
 *
 * ../../xxx
 *
 * C:/xxx
 *
 * ============================================================
 */
function resolvePath(filePath) {
  const workspace = getWorkspace();

  if (!filePath || typeof filePath !== "string") {
    throw new Error("Path is required");
  }

  if (path.isAbsolute(filePath)) {
    throw new Error("Absolute paths are not allowed");
  }

  const fullPath = path.resolve(workspace, filePath);

  const workspacePrefix = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;

  if (fullPath !== workspace && !fullPath.startsWith(workspacePrefix)) {
    throw new Error("Path escapes workspace");
  }

  return fullPath;
}

/**
 * ============================================================
 * read
 * ============================================================
 *
 * <read path="package.json"/>
 *
 * <read path="src"/>
 */
function read(node) {
  const filePath = node?.["@_path"];

  if (!filePath) {
    throw new Error("read requires path");
  }

  const fullPath = resolvePath(filePath);

  if (!fs.existsSync(fullPath)) {
    return {
      ok: false,
      action: "read",
      path: filePath,
      error: "File or directory does not exist",
    };
  }

  const stat = fs.statSync(fullPath);

  /**
   * Directory
   */
  if (stat.isDirectory()) {
    const entries = fs
      .readdirSync(fullPath, {
        withFileTypes: true,
      })
      .map((entry) => {
        return entry.name + (entry.isDirectory() ? "/" : "");
      })
      .sort();

    return {
      ok: true,
      action: "read",
      path: filePath,
      type: "directory",
      entries,
    };
  }

  /**
   * File
   */
  if (stat.size > MAX_READ_SIZE) {
    return {
      ok: false,
      action: "read",
      path: filePath,
      error: `File too large to read. Size: ${stat.size} bytes`,
    };
  }

  const content = fs.readFileSync(fullPath, "utf8");

  return {
    ok: true,
    action: "read",
    path: filePath,
    type: "file",
    size: stat.size,
    content,
  };
}

/**
 * ============================================================
 * write
 * ============================================================
 *
 * <write path="src/test.js"><![CDATA[
 * console.log("hello");
 * ]]></write>
 */
function write(node) {
  const filePath = node?.["@_path"];

  if (!filePath) {
    throw new Error("write requires path");
  }

  const fullPath = resolvePath(filePath);

  const content = getText(node);

  if (Buffer.byteLength(content, "utf8") > MAX_FILE_SIZE) {
    return {
      ok: false,
      action: "write",
      path: filePath,
      error: "File too large",
    };
  }

  fs.mkdirSync(path.dirname(fullPath), {
    recursive: true,
  });

  fs.writeFileSync(fullPath, content, "utf8");

  return {
    ok: true,
    action: "write",
    path: filePath,
    size: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * ============================================================
 * exec
 * ============================================================
 *
 * <exec command="npm test"/>
 */
function execute(node) {
  const workspace = getWorkspace();

  const command = node?.["@_command"];

  if (!command) {
    throw new Error("exec requires command");
  }

  console.log("");
  console.log("Executing command:");
  console.log(command);

  try {
    const output = execSync(command, {
      cwd: workspace,
      encoding: "utf8",
      timeout: MAX_EXEC_TIMEOUT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false,
    });

    return {
      ok: true,
      action: "exec",
      command,
      output,
    };
  } catch (error) {
    return {
      ok: false,
      action: "exec",
      command,
      exitCode: error.status ?? null,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      error: error.message,
    };
  }
}

/**
 * ============================================================
 * answer
 * ============================================================
 */
function answer(node) {
  const content = getText(node);

  if (!content.trim()) {
    throw new Error("answer content cannot be empty");
  }

  return {
    ok: true,
    action: "answer",
    content,
  };
}

/**
 * ============================================================
 * done
 * ============================================================
 */
function done() {
  return {
    ok: true,
    action: "done",
  };
}

/**
 * ============================================================
 * Run XML Action
 * ============================================================
 */
function run(xml) {
  if (!xml || typeof xml !== "string") {
    throw new Error("XML is empty");
  }

  /**
   * 确保 Workspace 已经配置
   */
  getWorkspace();

  const parsed = parser.parse(xml);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid XML");
  }

  const actionNames = Object.keys(parsed);

  if (actionNames.length === 0) {
    throw new Error("No XML action found");
  }

  const action = actionNames[0];

  const node = parsed[action];

  console.log("");
  console.log("================================");
  console.log("Runtime Action:", action);
  console.log("================================");

  switch (action) {
    case "read":
      return read(node);

    case "write":
      return write(node);

    case "exec":
      return execute(node);

    case "answer":
      return answer(node);

    case "done":
      return done(node);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * ============================================================
 * Exports
 * ============================================================
 */
module.exports = {
  run,
  setWorkspace,
  getWorkspace,
};
