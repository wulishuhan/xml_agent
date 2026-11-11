/**
首轮提示词的 provider 输出约束单测（prompts/first-prompt.js）

背景：Gemini 的渲染器会把裸 XML 标签整块删掉（DOM 里只剩文本），
所以它通过 `getActionMarkupHint()` 声明"动作必须放进代码块"。
这条约束必须真的拼进首轮提示词，而且要满足两个不变量：
- 没有声明时，提示词与原来逐字一致（不能因为新增钩子改动其它平台的行为）；
- 有声明时，约束出现在系统提示之后、用户任务之前。

另外钉住两条"降风控特征"的不变量（网页平台会把首轮提示词当用户消息读）：
- 不出现本机绝对路径；
- 工作区清单超长时必须截断，不能整段铺进首轮消息。

运行：node test/unit/test-first-prompt.js
*/

const { getFirstPrompt, projectLabel, clampManifest } = require("../../prompts/first-prompt");

const WORKSPACE = "D:/tmp/workspace";
const MANIFEST = ["README.md", "package.json"];

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function main() {
    const base = getFirstPrompt(WORKSPACE, MANIFEST, "做个任务");

    // ------------------------------------------------------------
    // 1. 不声明时必须与原来完全一致
    // ------------------------------------------------------------
    {
        const empty = getFirstPrompt(WORKSPACE, MANIFEST, "做个任务", { providerHint: "" });
        const blank = getFirstPrompt(WORKSPACE, MANIFEST, "做个任务", { providerHint: "   " });
        const missing = getFirstPrompt(WORKSPACE, MANIFEST, "做个任务", {});

        check("空字符串不改变提示词", empty === base);
        check("纯空白不改变提示词", blank === base);
        check("未提供时与旧行为一致", missing === base);
        check("默认提示词不含平台约束段落", base.indexOf("输出格式（本平台强制要求）") === -1);
    }

    // ------------------------------------------------------------
    // 2. 声明后约束必须出现在正确位置
    // ------------------------------------------------------------
    {
        const hint = "所有 XML Action 都要放进代码块。";
        const withHint = getFirstPrompt(WORKSPACE, MANIFEST, "做个任务", { providerHint: hint });

        check("约束文本被写入", withHint.indexOf(hint) !== -1);
        check("约束段落有标题", withHint.indexOf("输出格式（本平台强制要求）") !== -1);
        // "用户任务"在系统提示正文里也出现过一次，这里要看的是后面那个章节标题
        const taskIndex = withHint.lastIndexOf("用户任务");

        check(
            "约束在用户任务之前",
            withHint.indexOf(hint) !== -1 && withHint.indexOf(hint) < taskIndex,
            "hint@" + withHint.indexOf(hint) + " task@" + taskIndex
        );
        check(
            "约束在系统提示之后",
            withHint.indexOf("动作可以这样写") < withHint.indexOf(hint),
            "sys@" + withHint.indexOf("动作可以这样写") + " hint@" + withHint.indexOf(hint)
        );
        check(
            "其余内容不被破坏",
            withHint.indexOf("workspace") !== -1 && withHint.indexOf("做个任务") !== -1
        );
    }

    // ------------------------------------------------------------
    // 3. 不把本机绝对路径发给网页平台
    // ------------------------------------------------------------
    {
        check(
            "项目名取自路径末段",
            projectLabel(WORKSPACE) === "workspace",
            projectLabel(WORKSPACE)
        );
        check("项目名回退到当前目录", projectLabel("") === "当前目录");
        check("首轮提示词不含盘符路径", base.indexOf("D:/tmp") === -1);
        check("首轮提示词用项目名代替绝对路径", base.indexOf("项目：workspace") !== -1);
        const windowsWorkspace = "D:\\code\\back\\nodejs\\xml_agent";
        const windowsPrompt = getFirstPrompt(windowsWorkspace, MANIFEST, "做个任务");
        check("Windows 反斜杠路径同样脱敏", windowsPrompt.indexOf("D:\\code") === -1);
        check("Windows 项目名取末段", windowsPrompt.indexOf("项目：xml_agent") !== -1);
    }

    // ------------------------------------------------------------
    // 4. 清单超长必须截断
    // ------------------------------------------------------------
    {
        const huge = [];
        for (let index = 0; index < 2000; index += 1) {
            huge.push("src/some/deep/directory/file-" + index + ".js");
        }
        const clamped = clampManifest(huge, 1000);
        check("超长清单被截断", clamped.length < 1400, "len=" + clamped.length);
        check("截断处有说明", clamped.indexOf("listing truncated") !== -1);
        check("截断处保留条目总数", clamped.indexOf("2000 entries in total") !== -1);
        check("未超限时原样返回", clampManifest(["a.js", "b.js"], 1000) === "a.js\nb.js");
        const hugePrompt = getFirstPrompt(WORKSPACE, huge, "做个任务");
        check(
            "首轮提示词不会因为清单变大而爆长",
            hugePrompt.length < 12000,
            "len=" + hugePrompt.length
        );
    }

    // ------------------------------------------------------------
    // 5. 首轮提示词不出现宿主细节 / 机器身份设定
    //    （网页平台会把它当"用户消息"读，这些词是自动化特征）
    // ------------------------------------------------------------
    {
        const { SYSTEM_PROMPT } = require("../../prompts/system-prompt");
        const hostSignals = ["D:\\", "C:\\", "remote-debugging", "CDP", "Node.js Runtime"];
        for (const signal of hostSignals) {
            check(
                "首轮提示词不含宿主特征：" + signal,
                base.indexOf(signal) === -1 && SYSTEM_PROMPT.indexOf(signal) === -1
            );
        }
        // 本机地址只约束手写的系统提示词：插件文档里的示例 URL 是正常用法说明
        check(
            "系统提示词不含本机地址",
            SYSTEM_PROMPT.indexOf("127.0.0.1") === -1 && SYSTEM_PROMPT.indexOf("localhost") === -1
        );
        check("不再是角色设定开头", SYSTEM_PROMPT.trimStart().indexOf("你是一个") !== 0);
        check(
            "系统提示词已瘦身（< 2000 字符）",
            SYSTEM_PROMPT.length < 2000,
            "len=" + SYSTEM_PROMPT.length
        );
    }

    // ------------------------------------------------------------
    // 6. 每轮回包保持短小（轮次多，重复文本是主要特征）
    // ------------------------------------------------------------
    {
        const {
            getRuntimeOkPrompt,
            getRuntimeErrorPrompt,
        } = require("../../prompts/runtime-prompt");
        const small = { ok: true, action: "read", path: "a.js", content: "hello" };
        const okPrompt = getRuntimeOkPrompt(small);
        check("成功轮次提示词 < 600 字符", okPrompt.length < 600, "len=" + okPrompt.length);
        check(
            "失败轮次提示词 < 400 字符",
            getRuntimeErrorPrompt({ ok: false, action: "exec", error: "boom" }).length < 400
        );
        check("结果用紧凑 JSON（单行）", okPrompt.indexOf('{"ok":true') !== -1);
        // 陈旧写法会把 20000 字符的响应体整段铺进提示词
        const big = { ok: true, action: "fetch", body: "x".repeat(20000) };
        const bigPrompt = getRuntimeOkPrompt(big);
        check("超长结果被截断", bigPrompt.length < 6000, "len=" + bigPrompt.length);
        check("截断处有标注", bigPrompt.indexOf("truncated") !== -1);
        const many = { ok: true, action: "read", entries: new Array(1000).fill("f.js") };
        const manyPrompt = getRuntimeOkPrompt(many);
        check("超长数组被截断", manyPrompt.indexOf("1000 items in total") !== -1);
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exit(1);
    }
}

main();
