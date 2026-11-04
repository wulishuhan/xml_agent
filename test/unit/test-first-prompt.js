/**
首轮提示词的 provider 输出约束单测（prompts/first-prompt.js）

背景：Gemini 的渲染器会把裸 XML 标签整块删掉（DOM 里只剩文本），
所以它通过 `getActionMarkupHint()` 声明"动作必须放进代码块"。
这条约束必须真的拼进首轮提示词，而且要满足两个不变量：
- 没有声明时，提示词与原来逐字一致（不能因为新增钩子改动其它平台的行为）；
- 有声明时，约束出现在系统提示之后、用户任务之前。

运行：node test/unit/test-first-prompt.js
*/

const { getFirstPrompt } = require("../../prompts/first-prompt");

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
            withHint.indexOf("可用 XML Action") < withHint.indexOf(hint),
            "sys@" + withHint.indexOf("可用 XML Action") + " hint@" + withHint.indexOf(hint)
        );
        check(
            "其余内容不被破坏",
            withHint.indexOf(WORKSPACE) !== -1 && withHint.indexOf("做个任务") !== -1
        );
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exit(1);
    }
}

main();
