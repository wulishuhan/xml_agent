
const fs = require("fs");
const path = require("path");

/**

============================================================

Workspace Manifest - 递归扫描完整项目结构

============================================================

扫描用户指定的 Workspace 完整目录树，

按需探索大型项目。
*/

const ignoredDirs = new Set([
  "node_modules",
  ".git",
  ".agent",
  "browser-profile",
  "browser_data",
  "chrome-profile",
  "chrome_data",
  "chrome-agent-profile",
  ".vscode",
  ".idea",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "tmp",
  "temp"
]);

const ignoredFiles = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini"
]);

function shouldIgnore(name, isDirectory) {
  if (isDirectory) {
    return ignoredDirs.has(name);
  }
  return ignoredFiles.has(name);
}

function buildWorkspaceManifest(dir, depth = 0, maxDepth = 10) {
  const entries = [];
  const prefix = " ".repeat(depth);

  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return entries;
  }

  items.sort((a, b) => {
    // 目录优先
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of items) {
    const itemPath = path.join(dir, item.name);
    const isDir = item.isDirectory();

    if (shouldIgnore(item.name, isDir)) {
      continue;
    }

    if (isDir) {
      entries.push(prefix + item.name + "/");
      if (depth < maxDepth) {
        const subEntries = buildWorkspaceManifest(itemPath, depth + 1, maxDepth);
        entries.push(...subEntries);
      } else {
        entries.push(prefix + " ... (max depth reached)");
      }
    } else {
      entries.push(prefix + item.name);
    }
  }

  return entries;
}

module.exports = {
  buildWorkspaceManifest,
};
