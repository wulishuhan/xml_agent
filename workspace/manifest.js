/**
Workspace Manifest —— 递归扫描工作区目录树

扫描用户指定的 Workspace，产出"工作区里有什么"的清单，拼进首轮提示词，
让模型按需探索大型项目，而不是一上来就盲目 read。

为什么要设条目上限：清单会整段进提示词，而工作区大小不受控。实测 2000 个
文件就产出约 2.6 万字符（≈6.5k token）；5 万个文件的目录能到 16 万 token，
直接把请求撑爆，模型连任务描述都读不完整。超过上限时保留前 N 条并明确写出
"已截断"，让模型知道该用 read / exec 去看，而不是误以为这就是全部。

递归用的是同步 fs：上万文件时会阻塞事件循环（Electron 主进程短暂无响应），
所以上限同时也是这层保护——扫到上限就停，不会走完整个大目录树。
*/

const fs = require("fs");
const path = require("path");

/** 清单条目上限。提示词预算的硬保护，不是"建议值"。 */
const MAX_ENTRIES = 1200;

/** 超限时写进清单的提示行：模型需要知道"这不是全部"。 */
function truncationNote(count) {
    return (
        "... (listing truncated at " +
        count +
        " entries; use read / exec to explore specific directories)"
    );
}

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
    "temp",
    ".electron-builder-cache",
    // 会话记忆摘要（memory-transfer 插件写）：清单里不列，免得占预算；
    // 模型按 task 里给出的相对路径仍可以直接 read 到。
    ".xml-agent-memory",
]);

const ignoredFiles = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function shouldIgnore(name, isDirectory) {
    if (isDirectory) {
        return ignoredDirs.has(name);
    }
    return ignoredFiles.has(name);
}

function buildWorkspaceManifest(
    dir,
    depth = 0,
    maxDepth = 10,
    // 预算对象在递归间共享：count 累计已产出的条目数，truncated 保证提示行只写一次
    budget = { count: 0, max: MAX_ENTRIES, truncated: false }
) {
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
        // 预算用完就停：先补一行说明，再整棵子树都不再扫
        if (budget.count >= budget.max) {
            if (!budget.truncated) {
                budget.truncated = true;
                entries.push(prefix + truncationNote(budget.max));
            }
            break;
        }

        const itemPath = path.join(dir, item.name);
        const isDir = item.isDirectory();

        if (shouldIgnore(item.name, isDir)) {
            continue;
        }

        if (isDir) {
            entries.push(prefix + item.name + "/");
            budget.count++;
            if (depth < maxDepth) {
                const subEntries = buildWorkspaceManifest(itemPath, depth + 1, maxDepth, budget);
                // 逐条追加而不是 push(...subEntries)：后者在子条目超过 ~12 万条时
                // 会抛 RangeError（参数数量上限），大工作区正好会踩到。
                for (const entry of subEntries) {
                    entries.push(entry);
                }
            } else {
                entries.push(prefix + " ... (max depth reached)");
            }
        } else {
            entries.push(prefix + item.name);
            budget.count++;
        }
    }

    return entries;
}

module.exports = {
    buildWorkspaceManifest,
    MAX_ENTRIES,
};
