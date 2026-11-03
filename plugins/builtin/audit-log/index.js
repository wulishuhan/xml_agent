/**
内置插件：audit-log（hook + api + 声明式面板）

演示三件事：
1. hook：观察 Agent 事件，把摘要写成 JSONL（不改变主流程）；
2. api：用 ctx.api.get 暴露只读接口 /api/plugins/audit-log/api/summary；
3. ui：用 ctx.ui.registerPanel 声明一个面板，宿主前端按 blocks 渲染
   （插件不向浏览器下发任何可执行代码）。

日志落在插件私有目录
（~/.xml-agent/plugin-data/audit-log/audit-YYYYMMDD.jsonl），不会污染用户 workspace。
刻意只记录摘要：runtime.result 里可能带文件内容，整包写盘会让日志迅速膨胀。

保留策略：按文件名里的日期判断，超出 keepDays 的整日日志会被删除。
不删的话这个目录只会一直长，用户也找不到该在哪里清。
*/

const fs = require("fs");

const EVENTS = ["runtime.result", "action.denied", "agent.error", "session.finished"];
const RECENT_LIMIT = 20;
const FILE_PATTERN = /^audit-(\d{4})(\d{2})(\d{2})\.jsonl$/;

function pad(value) {
    return String(value).padStart(2, "0");
}

function dayStamp(date) {
    return (
        date.getFullYear() +
        "-" +
        pad(date.getMonth() + 1) +
        "-" +
        pad(date.getDate())
    ).replace(/-/g, "");
}

function truncate(value, maxLength) {
    const text = String(value === undefined || value === null ? "" : value);
    if (text.length <= maxLength) {
        return text;
    }
    return text.substring(0, maxLength) + "...(truncated)";
}

function summarize(eventName, payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    if (eventName === "runtime.result") {
        const result = data.result && typeof data.result === "object" ? data.result : {};
        return {
            step: data.step,
            action: data.action || result.action,
            ok: result.ok !== false,
            plugin: result.plugin || null,
            durationMs: result.durationMs,
            path: result.path,
            command: truncate(result.command, 200),
            error: truncate(result.error, 500) || null,
        };
    }
    if (eventName === "action.denied") {
        return {
            action: data.action,
            plugin: data.plugin,
            scope: data.scope,
            policy: data.policy,
            reason: truncate(data.reason, 500),
        };
    }
    if (eventName === "agent.error") {
        return { error: truncate(data.error, 500) };
    }
    if (eventName === "session.finished") {
        return {
            sessionId: data.id,
            status: data.status,
            provider: data.provider,
            runCount: data.runCount,
        };
    }
    return { payload: truncate(JSON.stringify(data), 500) };
}

/**
汇总审计日志：声明式面板与 /summary 接口共用同一份实现。
只读，且对损坏的行/文件保持容错（日志不应该把界面弄崩）。
*/
function readSummary(storage) {
    const result = { files: 0, total: 0, byEvent: {}, recent: [] };
    let names = [];
    try {
        names = fs
            .readdirSync(storage.dir)
            .filter((name) => name.indexOf("audit-") === 0 && name.endsWith(".jsonl"))
            .sort();
    } catch (error) {
        return result;
    }
    result.files = names.length;
    const entries = [];
    for (const name of names) {
        let text = "";
        try {
            text = storage.readText(name, "");
        } catch (error) {
            continue;
        }
        for (const line of text.split("\n")) {
            if (!line.trim()) {
                continue;
            }
            let entry;
            try {
                entry = JSON.parse(line);
            } catch (error) {
                continue;
            }
            result.total += 1;
            const eventName = String(entry.event || "unknown");
            result.byEvent[eventName] = (result.byEvent[eventName] || 0) + 1;
            entries.push(entry);
        }
    }
    entries.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    result.recent = entries.slice(0, RECENT_LIMIT);
    return result;
}

function setup(ctx) {
    const keepDays = Number(ctx.config && ctx.config.keepDays);
    // 上次执行清理的日期戳：同一天内不必反复扫目录，跨天后再清一次
    let prunedStamp = null;

    /**
     * 按保留策略删除过期日志，返回删掉的文件数。
     * "保留 N 天"包含今天，即最多留下今天 + 前 N-1 天，避免刚启动就删掉昨天的日志。
     */
    function prune() {
        if (!(keepDays > 0)) {
            return 0;
        }
        const today = new Date();
        const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        cutoff.setDate(cutoff.getDate() - (keepDays - 1));
        let removed = 0;
        for (const name of ctx.storage.list()) {
            const match = FILE_PATTERN.exec(name);
            if (!match) {
                continue;
            }
            const fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
            if (Number.isNaN(fileDate.getTime()) || fileDate >= cutoff) {
                continue;
            }
            try {
                if (ctx.storage.remove(name)) {
                    removed += 1;
                }
            } catch (error) {
                // 删不掉不能影响插件加载：下一轮还会再试
                ctx.logger.warn("审计日志清理失败 " + name + "：" + error.message);
            }
        }
        if (removed > 0) {
            ctx.logger.info(
                "审计日志已清理 " + removed + " 个过期文件（保留 " + keepDays + " 天）"
            );
        }
        return removed;
    }

    if (keepDays > 0) {
        prune();
        // 记下已清理的日期，避免当天第一条日志再白扫一次目录
        prunedStamp = dayStamp(new Date());
        ctx.logger.info("审计日志保留 " + keepDays + " 天（超出自动删除）");
    }

    // 1) hook：记录关键事件
    for (const eventName of EVENTS) {
        ctx.hooks.on(eventName, (payload) => {
            const now = new Date();
            const stamp = dayStamp(now);
            // 跨天后顺手清一次：长时间不重启也不会无限增长
            if (stamp !== prunedStamp) {
                prunedStamp = stamp;
                prune();
            }
            const line = JSON.stringify(
                Object.assign(
                    { ts: now.toISOString(), event: eventName },
                    summarize(eventName, payload)
                )
            );
            ctx.storage.appendLine("audit-" + stamp + ".jsonl", line);
        });
    }

    // 2) api：声明式面板的数据来源（只读）
    ctx.api.get("/summary", (request) => readSummary(request.storage));

    // 3) 声明式面板：宿主前端按 blocks 渲染，插件零 JS 进浏览器
    ctx.ui.registerPanel({
        id: "audit-log",
        title: "Audit Log",
        description: "动作执行、权限拒绝与任务结束的结构化审计记录",
        blocks: [
            {
                kind: "status",
                title: "Overview",
                path: "/summary",
                items: [
                    { label: "Files", value: "files" },
                    { label: "Entries", value: "total" },
                    { label: "Last entry", value: "recent.0.ts" },
                ],
            },
            {
                kind: "table",
                title: "Recent entries",
                path: "/summary",
                rows: "recent",
                columns: [
                    { key: "ts", label: "Time" },
                    { key: "event", label: "Event" },
                    { key: "action", label: "Action" },
                    { key: "status", label: "Status" },
                ],
                empty: "No audit entries yet — run a task first.",
            },
            {
                kind: "note",
                text:
                    "日志保存在插件私有目录（~/.xml-agent/plugin-data/audit-log/），不会写入用户 workspace。" +
                    (keepDays > 0
                        ? "按配置保留 " + keepDays + " 天，更早的文件在启动或跨天时自动删除。"
                        : "当前未设置保留天数，日志会一直累积。"),
            },
        ],
    });
}

module.exports = {
    setup,
};
