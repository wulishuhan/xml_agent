const fs = require("fs");
const path = require("path");

/**

Build Report

records is optional for backward compatibility with the legacy history

module. New Agent instances should pass their own execution history.
*/
function buildReport(task, workspace, records = []) {
    const lines = [];

    lines.push("# Agent Execution Report");
    lines.push("");
    lines.push("## Workspace");
    lines.push("");
    lines.push(workspace);
    lines.push("");
    lines.push("## 任务");
    lines.push("");
    lines.push(task);
    lines.push("");
    lines.push("## 执行记录");
    lines.push("");

    if (records.length === 0) {
        lines.push("没有执行任何 Action。");
    }

    for (const item of records) {
        const result = item.result || {};

        lines.push(`### Step ${item.step} - ${result.action || "unknown"}`);
        lines.push("");
        lines.push(`时间：${item.timestamp}`);
        lines.push("");
        lines.push("Action：");
        lines.push("");
        lines.push("```action");
        lines.push(JSON.stringify(item.action, null, 2));
        lines.push("```");
        lines.push("");

        if (result.action === "read") {
            if (result.ok) {
                lines.push(`读取成功：\`${result.path}\``);

                if (result.type === "directory") {
                    lines.push("");
                    lines.push("目录内容：");

                    for (const entry of result.entries || []) {
                        lines.push(`- ${entry}`);
                    }
                }
            } else {
                lines.push(`读取失败：${result.error || "unknown error"}`);
            }
        }

        if (result.action === "write") {
            if (result.ok) {
                lines.push(`写入成功：\`${result.path}\``);
            } else {
                lines.push(`写入失败：${result.error || "unknown error"}`);
            }
        }

        if (result.action === "exec") {
            if (result.ok) {
                lines.push(`命令执行成功：\`${result.command}\``);
            } else {
                lines.push(`命令执行失败：\`${result.command}\``);

                if (result.error) {
                    lines.push("");
                    lines.push("错误：");
                    lines.push("");
                    lines.push("```text");
                    lines.push(result.error);
                    lines.push("```");
                }
            }

            if (result.stdout) {
                lines.push("");
                lines.push("stdout：");
                lines.push("");
                lines.push("```text");
                lines.push(result.stdout);
                lines.push("```");
            }

            if (result.stderr) {
                lines.push("");
                lines.push("stderr：");
                lines.push("");
                lines.push("```text");
                lines.push(result.stderr);
                lines.push("```");
            }

            if (result.output) {
                lines.push("");
                lines.push("output：");
                lines.push("");
                lines.push("```text");
                lines.push(result.output);
                lines.push("```");
            }
        }

        if (result.action === "answer") {
            lines.push("");
            lines.push("最终回答：");
            lines.push("");
            lines.push(result.content || "");
        }

        if (result.action === "done") {
            lines.push("Agent 已结束。");
        }

        lines.push("");
    }

    return lines.join("\n");
}

/**

Save Report
*/
function saveReport(task, workspace, records = []) {
    const agentDir = path.join(workspace, ".agent");

    fs.mkdirSync(agentDir, {
        recursive: true,
    });

    const reportPath = path.join(agentDir, "report.md");

    const report = buildReport(task, workspace, records);

    fs.writeFileSync(reportPath, report, "utf8");

    return reportPath;
}

module.exports = {
    buildReport,
    saveReport,
};
