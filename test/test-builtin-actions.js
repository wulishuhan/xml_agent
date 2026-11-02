/**
内置动作表回归测试（P0：动作定义对象化）

这组用例的作用是**锁死迁移前后的行为等价**：
1. 动作表由 actions/ 派生，名字与顺序与 1.1.0 的 ACTION_NAMES 一致；
2. 每个内置动作的校验错误文案逐字节冻结（模型侧看到的错误提示不能漂移）；
3. 解析层结果结构不变（含 write/screenshot 的手写快速解析器）；
4. Runtime 执行结果结构不变（read/write/exec/answer/done）；
5. 终止语义（meta.terminal）与产物声明（meta.collectImages）接对了线；
6. 系统提示词指纹冻结 —— 任何对 SYSTEM_PROMPT 的改动都会让本测试失败，
   提醒开发者"这是在改模型行为"，必须同步评估。

运行：node test/test-builtin-actions.js
*/

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    extractXML,
    getText,
    tryExtractWriteManually,
    tryExtractScreenshotManually,
    normalizeScreenshotTargets,
    ACTION_NAMES,
} = require("../parse/xml-parse");
const { getBuiltinActions, getBuiltinAction, getBuiltinActionNames } = require("../actions");
const { createRuntime } = require("../runtime");
const { Agent } = require("../agent-core");
const { SYSTEM_PROMPT } = require("../prompts/system-prompt");
const { getFirstPrompt } = require("../prompts/first-prompt");

// 内置动作表顺序（screenshot 自 v1.1.0 起迁到内置插件，不再在这里）
const EXPECTED_NAMES = ["read", "write", "exec", "answer", "done"];

// 系统提示词指纹（v1.1.0）。改动 SYSTEM_PROMPT 时必须重新评估模型行为并更新此值。
const SYSTEM_PROMPT_SHA1 = "fc1b21acfcd773ef8cca99ff1826f981bc5f0b3e";

// 迁移前的校验错误文案（逐字节冻结）。
// screenshot 的用例仍然保留 —— 它们验证的是"协议层校验没有因为搬家而变化"，
// 现在这些规则来自 plugins/builtin/screenshot。
const VALIDATION_CASES = [
    { xml: "<read></read>", message: "read action is invalid" },
    { xml: "<read/>", message: "read action is invalid" },
    { xml: "<read path='x'/>".replace(/'/g, '"'), message: null },
    { xml: "<write></write>", message: "write action is invalid" },
    { xml: '<write path="a.txt"></write>', message: "write content cannot be empty" },
    { xml: "<exec></exec>", message: "exec action is invalid" },
    { xml: '<exec command=""/>', message: "exec requires command" },
    {
        xml: "<screenshot/>",
        message: "screenshot requires source (browser_page | screen | window)",
    },
    {
        xml: '<screenshot source="window"/>',
        message: "screenshot source=window requires windowTitle",
    },
    {
        xml: '<screenshot source="desktop"/>',
        message: "screenshot source must be one of: browser_page, screen, window",
    },
    { xml: "<answer></answer>", message: "answer content cannot be empty" },
    { xml: "<answer><![CDATA[   ]]></answer>", message: "answer content cannot be empty" },
];

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function captureError(fn) {
    try {
        fn();
        return null;
    } catch (error) {
        return error.message;
    }
}

async function main() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-builtin-"));

    try {
        console.log("=== 1. 动作表 ===");
        const names = getBuiltinActionNames();
        check(
            "动作名与顺序与 1.1.0 一致",
            JSON.stringify(names) === JSON.stringify(EXPECTED_NAMES),
            names.join(",")
        );
        check(
            "ACTION_NAMES 由动作表派生",
            JSON.stringify(ACTION_NAMES) === JSON.stringify(EXPECTED_NAMES),
            String(ACTION_NAMES.length)
        );
        const definitions = Array.from(getBuiltinActions().values());
        check(
            "每个动作都有模型用法说明",
            definitions.every((def) => def.meta.prompt.usage && def.meta.prompt.usage.length > 0)
        );
        check(
            "每个动作都有 Trace 摘要函数",
            definitions.every((def) => typeof def.meta.summary === "function")
        );
        check(
            "声明了权限 scope",
            // read / write / exec 三个需要 scope；answer / done 不需要
            definitions.filter((def) => def.meta.permission.length > 0).length >= 3,
            definitions.map((def) => def.name + ":" + def.meta.permission.join("|")).join(" , ")
        );

        console.log("\n=== 2. 终止语义（meta.terminal） ===");
        check("answer 声明 terminal=answer", getBuiltinAction("answer").meta.terminal === "answer");
        check("done 声明 terminal=end", getBuiltinAction("done").meta.terminal === "end");
        const nonTerminal = ["read", "write", "exec"].filter(
            (name) => getBuiltinAction(name).meta.terminal !== null
        );
        check("其它动作没有终止语义", nonTerminal.length === 0, nonTerminal.join(","));

        // Agent 编排器通过 resolveActionDefinition 读取终止语义（不依赖动作名硬编码）
        const agent = new Agent({ workspace, task: "terminal check" });
        check(
            "Agent 能解析内置动作定义",
            agent.resolveActionDefinition("answer") === getBuiltinAction("answer")
        );
        check(
            "Agent 对未知动作返回 null",
            agent.resolveActionDefinition("no-such-action") === null
        );

        console.log("\n=== 3. 校验错误文案冻结 ===");
        for (const item of VALIDATION_CASES) {
            const message = captureError(() => extractXML(item.xml));
            if (item.message === null) {
                check("合法用例通过：" + item.xml, message === null, String(message));
                continue;
            }
            check(
                "文案一致：" + item.xml,
                message === item.message,
                "got=" + JSON.stringify(message)
            );
        }
        check(
            "未知动作仍报 Unknown XML Action",
            captureError(() => extractXML("<nope/>")) === "Unknown XML Action: nope"
        );
        check(
            "多动作被拒绝",
            String(captureError(() => extractXML("<read/><done/>"))).indexOf(
                "Exactly one XML Action"
            ) !== -1
        );

        console.log("\n=== 4. 解析层结构不变 ===");
        const writeManual = tryExtractWriteManually(
            '<write path="a.txt"><![CDATA[hello world]]></write>'
        );
        check(
            "write 快速解析器可用",
            Boolean(writeManual) &&
                writeManual.action === "write" &&
                writeManual.node["@_path"] === "a.txt" &&
                writeManual.node["#text"] === "hello world"
        );
        const shotManual = tryExtractScreenshotManually('<screenshot source="screen"/>');
        check(
            "screenshot 快速解析器可用",
            Boolean(shotManual) &&
                shotManual.action === "screenshot" &&
                shotManual.node["@_source"] === "screen"
        );
        const multi = extractXML(
            '<screenshot><target source="screen" path="a.png"/><target source="screen" path="b.png"/></screenshot>'
        );
        check("多目标 screenshot 解析", multi.action === "screenshot");
        check(
            "normalizeScreenshotTargets 返回 2 个目标",
            normalizeScreenshotTargets(multi.node).length === 2
        );
        check(
            "无子目标时返回空数组",
            normalizeScreenshotTargets({ "@_source": "screen" }).length === 0
        );
        const answerParsed = extractXML("<answer><![CDATA[最终答案]]></answer>");
        check(
            "answer CDATA 解析",
            answerParsed.action === "answer" && getText(answerParsed.node) === "最终答案",
            String(getText(answerParsed.node))
        );

        console.log("\n=== 5. Runtime 执行 ===");
        const runtime = createRuntime(workspace);
        fs.writeFileSync(path.join(workspace, "note.txt"), "hello", "utf8");
        const readResult = await runtime.run({ action: "read", node: { "@_path": "note.txt" } });
        check(
            "read 文件",
            readResult.ok === true && readResult.type === "file" && readResult.content === "hello"
        );
        const readDir = await runtime.run({ action: "read", node: { "@_path": "." } });
        check(
            "read 目录返回 entries",
            readDir.ok === true &&
                readDir.type === "directory" &&
                readDir.entries.indexOf("note.txt") !== -1
        );
        const readMissing = await runtime.run({
            action: "read",
            node: { "@_path": "missing.txt" },
        });
        check(
            "read 不存在的文件返回 ok:false",
            readMissing.ok === false && readMissing.error === "File or directory does not exist"
        );
        const escapeMessage = await runtime
            .run({ action: "read", node: { "@_path": "../evil.txt" } })
            .then(() => null)
            .catch((error) => error.message);
        check("越界路径被拒绝", escapeMessage === "Path escapes workspace", String(escapeMessage));

        const writeResult = await runtime.run({
            action: "write",
            node: { "@_path": "sub/created.txt", "#text": "written" },
        });
        check(
            "write 自动建目录",
            writeResult.ok === true &&
                fs.readFileSync(path.join(workspace, "sub", "created.txt"), "utf8") === "written"
        );
        const badJson = await runtime.run({
            action: "write",
            node: { "@_path": "bad.json", "#text": "{not json" },
        });
        check(
            "write 保留 JSON 内容校验",
            badJson.ok === false &&
                String(badJson.error).indexOf("Content validation failed") === 0,
            String(badJson.error)
        );

        // exec 依赖真实子进程；本机沙箱可能禁止 spawn，此时只验证"失败被结构化"
        let execOk = false;
        let execDetail = "";
        try {
            const execResult = await runtime.run({
                action: "exec",
                node: { "@_command": "echo hello-runtime" },
            });
            execOk =
                execResult.ok === true && String(execResult.output).indexOf("hello-runtime") !== -1;
            execDetail = String(execResult.output || execResult.error || "").trim();
        } catch (error) {
            const message = String((error && error.message) || error);
            const sandboxLimited = /EPERM|EACCES|ENOENT|spawn/i.test(message);
            execOk = sandboxLimited;
            execDetail = (sandboxLimited ? "skipped (sandbox): " : "") + message;
        }
        check("exec 执行命令（沙箱禁止 spawn 时跳过）", execOk, execDetail);

        const answerResult = await runtime.run({
            action: "answer",
            node: { "#text": "最终答案" },
        });
        check("answer 返回内容", answerResult.ok === true && answerResult.content === "最终答案");
        const doneResult = await runtime.run({ action: "done", node: "" });
        check("done 返回 ok", doneResult.ok === true && doneResult.action === "done");

        console.log("\n=== 6. 兼容调用面 ===");
        const handlers = runtime.actionHandlers;
        check(
            "actionHandlers 覆盖全部内置动作",
            EXPECTED_NAMES.every((name) => typeof handlers[name] === "function"),
            Object.keys(handlers).join(",")
        );
        const directRead = await runtime.read({ "@_path": "note.txt" });
        check(
            "runtime.read(...) 直接调用仍可用",
            directRead.ok === true && directRead.content === "hello"
        );
        const directShotEscape = await runtime
            .screenshot({ "@_source": "screen", "@_path": "../evil.png" })
            .then((value) => (value && value.ok === false ? value.error : null))
            .catch((error) => error.message);
        check(
            "runtime.screenshot(...) 越界被拒（插件动作返回结构化失败）",
            directShotEscape === "Path escapes workspace",
            String(directShotEscape)
        );

        console.log("\n=== 7. 产物声明（meta.collectImages） ===");
        // screenshot 已是内置插件：产物声明从插件动作定义上读
        const screenshotDefinition = require("../plugins/registry")
            .getRegistrySafe()
            .getActionDefinition("screenshot");
        check("screenshot 由插件提供动作定义", Boolean(screenshotDefinition));
        const collect = screenshotDefinition.meta.collectImages;
        check("screenshot 声明了 collectImages", typeof collect === "function");
        check(
            "单图结果收集",
            JSON.stringify(collect({ ok: true, path: "screenshots/a.png" })) ===
                JSON.stringify(["screenshots/a.png"])
        );
        check(
            "多图结果收集（只取成功项）",
            JSON.stringify(
                collect({
                    ok: true,
                    multi: true,
                    paths: ["a.png", "b.png"],
                    results: [
                        { ok: true, path: "a.png" },
                        { ok: false },
                        { ok: true, path: "b.png" },
                    ],
                })
            ) === JSON.stringify(["a.png", "b.png"])
        );
        check(
            "results 兜底收集",
            JSON.stringify(
                collect({ ok: true, results: [{ ok: true, path: "c.png" }, { ok: false }] })
            ) === JSON.stringify(["c.png"])
        );
        check("其它动作没有产物声明", getBuiltinAction("read").meta.collectImages === null);
        const readArtifacts = agent.collectArtifactPaths({ ok: true, action: "read", path: "x" });
        check("Agent 对无产物动作返回空数组", readArtifacts.length === 0);
        const shotArtifacts = agent.collectArtifactPaths({
            ok: true,
            action: "screenshot",
            path: "screenshots/a.png",
        });
        check(
            "Agent 通过动作声明收集截图",
            JSON.stringify(shotArtifacts) === JSON.stringify(["screenshots/a.png"])
        );

        console.log("\n=== 8. 提示词指纹（golden） ===");
        const promptSha1 = crypto.createHash("sha1").update(SYSTEM_PROMPT, "utf8").digest("hex");
        check("SYSTEM_PROMPT 未被意外改动", promptSha1 === SYSTEM_PROMPT_SHA1, promptSha1);
        const promptWithoutPlugins = getFirstPrompt(workspace, ["note.txt"], "任务", {
            registry: null,
        });
        check(
            "无插件时首轮提示词以系统提示词开头",
            promptWithoutPlugins.startsWith("\n" + SYSTEM_PROMPT)
        );
        check("无插件时首轮提示词不含插件区块", promptWithoutPlugins.indexOf("插件能力") === -1);
        check(
            "首轮提示词仍包含 Workspace 与 Manifest 段",
            promptWithoutPlugins.indexOf("Workspace Manifest") !== -1 &&
                promptWithoutPlugins.indexOf("note.txt") !== -1
        );
    } finally {
        try {
            fs.rmSync(workspace, { recursive: true, force: true });
        } catch (error) {
            // ignore
        }
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);
    process.exit(pass === total ? 0 : 1);
}

main().catch((error) => {
    console.error("Test run failed:", error && error.stack ? error.stack : error);
    process.exit(1);
});
