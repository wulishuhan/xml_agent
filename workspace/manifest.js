const fs = require("fs");
/**
 * ============================================================
 * Workspace Manifest
 * ============================================================
 *
 * 注意：
 *
 * Manifest 扫描的是用户指定的 Workspace，
 * 而不是 Agent 自己所在的目录。
 *
 * 这里仍然只扫描第一层。
 *
 * 大型项目通过 <read> 按需探索。
 */

function buildWorkspaceManifest(dir) {
  const entries = [];

  const ignoredDirs = new Set(["node_modules", ".git", ".agent", "browser-profile", "browser_data", "chrome-profile", "chrome_data"]);

  let items;

  try {
    items = fs.readdirSync(dir, {
      withFileTypes: true,
    });
  } catch (error) {
    return entries;
  }

  items.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of items) {
    if (item.isDirectory() && ignoredDirs.has(item.name)) {
      continue;
    }

    if (item.isDirectory()) {
      entries.push(`${item.name}/`);
    } else {
      entries.push(item.name);
    }
  }

  return entries;
}

module.exports = {
  buildWorkspaceManifest,
};
