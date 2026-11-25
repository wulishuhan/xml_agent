const { getFirstPrompt, projectLabel } = require("../../prompts/first-prompt");
const { SYSTEM_PROMPT } = require("../../prompts/system-prompt");
const { ACTION_SCHEMA } = require("../../parse/action-schema");
const { getRuntimeOkPrompt, getRuntimeErrorPrompt } = require("../../prompts/runtime-prompt");

const WORKSPACE = "D:/tmp/workspace";

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
        console.log("PASS - " + name + (detail ? "  [" + detail + "]" : ""));
        return;
    }
    console.log("FAIL - " + name + (detail ? "  [" + detail + "]" : ""));
}

function main() {
    const base = getFirstPrompt(WORKSPACE, "做个任务");

    check(
        "空 providerHint 不改变提示词",
        getFirstPrompt(WORKSPACE, "做个任务", { providerHint: "" }) === base
    );
    check(
        "纯空白 providerHint 不改变提示词",
        getFirstPrompt(WORKSPACE, "做个任务", { providerHint: "   " }) === base
    );
    check("未提供 options 与空 options 一致", getFirstPrompt(WORKSPACE, "做个任务", {}) === base);
    check("默认提示词不含平台约束段落", base.indexOf("输出格式（本平台要求）") === -1);

    const hint = "只输出裸 JSON，不要代码块。";
    const withHint = getFirstPrompt(WORKSPACE, "做个任务", { providerHint: hint });
    check("provider 约束被写入", withHint.indexOf(hint) !== -1);
    check("provider 约束在用户任务之前", withHint.indexOf(hint) < withHint.lastIndexOf("用户任务"));
    check(
        "provider 约束在动作协议之后",
        withHint.indexOf("动作协议 JSON Schema") < withHint.indexOf(hint)
    );

    check("项目名取自路径末段", projectLabel(WORKSPACE) === "workspace");
    check("项目名回退到当前目录", projectLabel("") === "当前目录");
    check("首轮提示词不含盘符路径", base.indexOf("D:/tmp") === -1);
    check("首轮提示词用项目名代替绝对路径", base.indexOf("项目：workspace") !== -1);
    const windowsWorkspace = "D:\\code\\back\\nodejs\\xml_agent";
    const windowsPrompt = getFirstPrompt(windowsWorkspace, "做个任务");
    check("Windows 反斜杠路径同样脱敏", windowsPrompt.indexOf("D:\\code") === -1);
    check("Windows 项目名取末段", windowsPrompt.indexOf("项目：xml_agent") !== -1);

    check("首轮提示词包含 JSON Schema", base.indexOf(JSON.stringify(ACTION_SCHEMA)) !== -1);
    check("首轮提示词不包含 Workspace Manifest", base.indexOf("Workspace Manifest") === -1);
    check(
        "首轮提示词不包含 XML 动作示例",
        /<(read|write|edit|exec|answer|done)\b/.test(base) === false
    );
    check("首轮提示词要求先 read", base.indexOf("先输出一个 read 动作") !== -1);
    check("首轮提示词包含用户任务", base.indexOf("做个任务") !== -1);

    for (const signal of [
        "D:\\",
        "C:\\",
        "remote-debugging",
        "CDP",
        "Node.js Runtime",
        "127.0.0.1",
        "localhost",
    ]) {
        check(
            "首轮提示词不含宿主特征：" + signal,
            base.indexOf(signal) === -1 && SYSTEM_PROMPT.indexOf(signal) === -1
        );
    }
    check("系统提示词长度受控", SYSTEM_PROMPT.length < 5000, "len=" + SYSTEM_PROMPT.length);
    check("系统提示词包含 read 续读规则", SYSTEM_PROMPT.includes("nextOffset"));

    const small = { ok: true, action: "read", path: "a.js", content: "hello" };
    const okPrompt = getRuntimeOkPrompt(small);
    check("成功回贴 < 600 字符", okPrompt.length < 600, "len=" + okPrompt.length);
    check(
        "失败回贴 < 400 字符",
        getRuntimeErrorPrompt({ ok: false, action: "exec", error: "boom" }).length < 400
    );
    check("结果用紧凑 JSON", okPrompt.indexOf('{"ok":true') !== -1);
    check("回贴要求 JSON 动作", okPrompt.indexOf('"action":"answer"') !== -1);

    const big = { ok: true, action: "fetch", body: "x".repeat(20000) };
    const bigPrompt = getRuntimeOkPrompt(big);
    check("超长结果被截断", bigPrompt.length < 6000 && bigPrompt.indexOf("truncated") !== -1);
    const partialRead = {
        ok: true,
        action: "read",
        path: ".agent/skills/novel-writing/SKILL.md",
        content: "x".repeat(4000),
        truncated: true,
        nextOffset: 4000,
        limit: 4000,
    };
    const readPrompt = getRuntimeOkPrompt(partialRead);
    check(
        "未读完的 read 回包要求继续",
        readPrompt.includes("文件尚未读完") && readPrompt.includes('"offset":4000')
    );
    const many = { ok: true, action: "read", entries: new Array(1000).fill("f.js") };
    check("超长数组被截断", getRuntimeOkPrompt(many).indexOf("1000 items in total") !== -1);

    console.log("");
    console.log("Total: " + pass + "/" + total);
    if (pass !== total) {
        process.exit(1);
    }
}

main();
