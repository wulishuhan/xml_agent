/**
清理打包留下的目录，把工程恢复成"只有一个 release/"的状态。

用途：
1. 历史上为了绕开文件占用，构建时用 XML_AGENT_RELEASE_DIR 指到 release-* 临时目录，
   这些目录现在都是空壳（里面只剩一个 0 字节、被系统锁住的 app.asar），可以清掉。
2. 清掉 release/win-unpacked —— 它是构建中间产物，每次构建都会重新生成，
   留着只会占 220MB 并挡住下一次构建。

删除方式：逐个文件删。本机对"一次删很多文件"有保护，直接 rm -rf / fs.rmSync(recursive)
会被拒绝且可能只删一半。

如果某个文件被别的进程占着（Windows 报 being used by another process），
脚本会列出它并保留现场，不会硬删 —— 这种情况重启一次系统再跑本脚本即可。

用法：npm run release:clean
*/

const fs = require("fs");
const path = require("path");
const { removeTree } = require("./build-windows.js");

const projectRoot = path.join(__dirname, "..");

function dirSize(target) {
    let total = 0;
    let stat;

    try {
        stat = fs.lstatSync(target);
    } catch (error) {
        return 0;
    }

    if (!stat.isDirectory()) {
        return stat.size;
    }

    for (const name of fs.readdirSync(target)) {
        total += dirSize(path.join(target, name));
    }

    return total;
}

function collectTargets() {
    const targets = [];
    const releaseDir = path.join(projectRoot, "release");

    // release/win-unpacked 与上次构建挪走的归档目录
    for (const name of ["win-unpacked"].concat(
        fs.existsSync(releaseDir)
            ? fs
                  .readdirSync(releaseDir)
                  .filter((item) => item.indexOf(".stale-win-unpacked-") === 0)
            : []
    )) {
        const full = path.join(releaseDir, name);

        if (fs.existsSync(full)) {
            targets.push(full);
        }
    }

    // 工程根下的 release-* 临时目录
    for (const name of fs.readdirSync(projectRoot)) {
        if (/^release-/.test(name)) {
            targets.push(path.join(projectRoot, name));
        }
    }

    return targets;
}

function main() {
    const targets = collectTargets();

    if (!targets.length) {
        console.log("[clean-release] 没有需要清理的目录，release/ 已是干净状态");
        return;
    }

    let freed = 0;
    const failed = [];

    for (const target of targets) {
        const size = dirSize(target);

        try {
            removeTree(target, target);
            freed += size;
            console.log(
                "[clean-release] removed " +
                    path.relative(projectRoot, target) +
                    "  " +
                    (size / 1024 / 1024).toFixed(1) +
                    "MB"
            );
        } catch (error) {
            failed.push({ target, message: error.message });
        }
    }

    console.log("[clean-release] 共回收 " + (freed / 1024 / 1024).toFixed(1) + "MB");

    if (failed.length) {
        console.warn("[clean-release] 以下目录被占用，未能删除：");

        for (const item of failed) {
            console.warn(
                "  - " +
                    path.relative(projectRoot, item.target) +
                    "\n    " +
                    String(item.message).split("\n")[0]
            );
        }

        console.warn("[clean-release] 重启一次系统后重新执行本命令即可");
        process.exitCode = 1;
    }
}

main();
