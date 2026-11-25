/**
 * 内置动作表回归测试（P0：动作定义对象化）
 *
 * 这组用例的作用是锁死 JSON Action 迁移后的行为：
 * 1. 动作表由 actions/ 派生，名字与顺序保持稳定；
 * 2. 每个内置动作的校验错误文案逐字节冻结；
 * 3. 解析层只返回 {action, params, plugin?}，不再泄漏 XML 节点结构；
 * 4. Runtime 执行结果结构不变（read/write/edit/exec/answer/done）；
 * 5. 终止语义（meta.terminal）与产物声明（meta.collectImages）接对了线；
 * 6. SYSTEM_PROMPT 指纹冻结，同时验证首轮提示词内嵌 JSON Schema 与示例。
 *
 * 运行：node test/test-builtin-actions.js
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { extractAction } = require("../parse/json-action");
const { ACTION_SCHEMA, MAX_READ_CHARS, validateParams } = require("../parse/action-schema");
const { getBuiltinActions, getBuiltinAction, getBuiltinActionNames } = require("../actions");
const { createRuntime } = require("../runtime");
const { Agent } = require("../agent-core");
const { SYSTEM_PROMPT } = require("../prompts/system-prompt");
const { getFirstPrompt } = require("../prompts/first-prompt");
const { getRuntimeOkPrompt } = require("../prompts/runtime-prompt");

// 内置动作表顺序（screenshot 自 v1.1.0 起迁到内置插件，不再在这里）
// edit 是新增的：write 负责新建/整体重写，edit 负责局部替换。
const EXPECTED_NAMES = ["read", "write", "edit", "exec", "answer", "done"];

// JSON Action 迁移后的系统提示词指纹。
// 改动 SYSTEM_PROMPT 时必须重新评估模型行为、更新此值，并保留下方的 Schema/示例校验。
const SYSTEM_PROMPT_SHA1 = "8ace1ff01136ca3dbb287284a8126819b899b05d";

function actionJson(action, params) {
    return JSON.stringify({ action, params });
}

// 迁移后的校验错误文案（逐字节冻结）。
// screenshot 的用例仍然保留 —— 它们验证协议层校验，规则来自内置插件。
const VALIDATION_CASES = [
    { action: "read", params: {}, message: "params must have required property 'path'" },
    {
        action: "read",
        params: { path: "" },
        message: "/path must NOT have fewer than 1 characters",
    },
    { action: "read", params: { path: "x" }, message: null },
    {
        action: "write",
        params: { path: "a.txt" },
        message: "params must have required property 'content'",
    },
    {
        action: "write",
        params: { path: "a.txt", content: "" },
        message: "/content must NOT have fewer than 1 characters",
    },
    {
        action: "write",
        params: { path: "a.txt", content: "   " },
        message: "write content cannot be empty",
    },
    {
        action: "edit",
        params: { path: "a.txt" },
        message: "params must have required property 'changes'",
    },
    {
        action: "edit",
        params: { path: "a.txt", changes: [{ old: "x" }] },
        message: "/changes/0 must have required property 'new'",
    },
    {
        action: "edit",
        params: { path: "a.txt", changes: [{ old: "", new: "y" }] },
        message: "/changes/0/old must NOT have fewer than 1 characters",
    },
    {
        action: "edit",
        params: { path: "a.txt", changes: [{ old: "a", new: "b" }] },
        message: null,
    },
    { action: "exec", params: {}, message: "params must have required property 'command'" },
    {
        action: "exec",
        params: { command: "" },
        message: "/command must NOT have fewer than 1 characters",
    },
    {
        action: "screenshot",
        params: {},
        message: "params must have required property 'targets'",
    },
    {
        action: "screenshot",
        params: { targets: [{ source: "window" }] },
        message:
            "/targets/0 must have required property 'windowTitle'; /targets/0 must have required property 'title'; /targets/0 must match a schema in anyOf; /targets/0 must match \"then\" schema",
    },
    {
        action: "screenshot",
        params: { targets: [{ source: "desktop" }] },
        message: "/targets/0/source must be equal to one of the allowed values",
    },
    {
        action: "answer",
        params: { content: "" },
        message: "/content must NOT have fewer than 1 characters",
    },
    { action: "answer", params: { content: "   " }, message: "answer content cannot be empty" },
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
            "动作名与顺序保持稳定",
            JSON.stringify(names) === JSON.stringify(EXPECTED_NAMES),
            names.join(",")
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
            // read / write / edit / exec 需要 scope；answer / done 不需要
            definitions.filter((def) => def.meta.permission.length > 0).length >= 3,
            definitions.map((def) => def.name + ":" + def.meta.permission.join("|")).join(" , ")
        );

        console.log("\n=== 2. 终止语义（meta.terminal） ===");
        check("answer 声明 terminal=answer", getBuiltinAction("answer").meta.terminal === "answer");
        check("done 声明 terminal=end", getBuiltinAction("done").meta.terminal === "end");
        const nonTerminal = ["read", "write", "edit", "exec"].filter(
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
            const response = actionJson(item.action, item.params);
            const message = captureError(() => extractAction(response));
            if (item.message === null) {
                check("合法用例通过：" + response, message === null, String(message));
                continue;
            }
            check(
                "文案一致：" + response,
                message === item.message,
                "got=" + JSON.stringify(message)
            );
        }
        check(
            "未知动作仍报 Unknown action",
            captureError(() => extractAction(actionJson("nope", {}))) === "Unknown action: nope"
        );
        check(
            "多动作被拒绝",
            captureError(() =>
                extractAction(actionJson("read", { path: "a.js" }) + "\n" + actionJson("done", {}))
            ) === "Exactly one JSON action is required, but received 2"
        );

        console.log("\n=== 4. 解析层结构 ===");
        const writeParsed = extractAction(
            actionJson("write", { path: "a.txt", content: 'hello "world"\n{"x":1}' })
        );
        check(
            "write 返回扁平 params 并保留转义内容",
            writeParsed.action === "write" &&
                writeParsed.params.path === "a.txt" &&
                writeParsed.params.content === 'hello "world"\n{"x":1}' &&
                writeParsed.node === undefined,
            JSON.stringify(writeParsed)
        );
        const editParsed = extractAction(
            actionJson("edit", {
                path: "a&b.txt",
                changes: [{ old: "if (a < b) { return 1; }", new: "if (a < b) { return 2; }" }],
            })
        );
        check(
            "edit 保留花括号、< 与路径中的 &",
            editParsed.action === "edit" &&
                editParsed.params.path === "a&b.txt" &&
                editParsed.params.changes[0].old === "if (a < b) { return 1; }" &&
                editParsed.params.all === false,
            JSON.stringify(editParsed.params)
        );
        const shotParsed = extractAction(
            actionJson("screenshot", {
                targets: [
                    { source: "screen", path: "a.png" },
                    { source: "screen", path: "b.png" },
                ],
            })
        );
        check(
            "插件动作返回 plugin 与嵌套 targets",
            shotParsed.action === "screenshot" &&
                shotParsed.plugin === "screenshot" &&
                shotParsed.params.targets.length === 2,
            JSON.stringify(shotParsed)
        );
        const answerParsed = extractAction(actionJson("answer", { content: "最终答案" }));
        check(
            "answer 返回 content",
            answerParsed.action === "answer" && answerParsed.params.content === "最终答案",
            JSON.stringify(answerParsed)
        );

        console.log("\n=== 5. Runtime 执行 ===");
        const runtime = createRuntime(workspace);
        fs.writeFileSync(path.join(workspace, "note.txt"), "hello", "utf8");
        const readResult = await runtime.run({ action: "read", params: { path: "note.txt" } });
        check(
            "read 文件",
            readResult.ok === true &&
                readResult.type === "file" &&
                readResult.content === "hello" &&
                readResult.truncated === false &&
                readResult.nextOffset === null
        );
        const longContent = "技能说明\n" + "0123456789".repeat(1000);
        fs.writeFileSync(path.join(workspace, "long-skill.md"), longContent, "utf8");
        const firstPage = await runtime.run({
            action: "read",
            params: { path: "long-skill.md" },
        });
        check(
            "read 默认返回第一页与续读游标",
            firstPage.ok === true &&
                firstPage.content === longContent.slice(0, MAX_READ_CHARS) &&
                firstPage.returnedChars === MAX_READ_CHARS &&
                firstPage.totalChars === longContent.length &&
                firstPage.truncated === true &&
                firstPage.hasMore === true &&
                firstPage.nextOffset === MAX_READ_CHARS,
            JSON.stringify(firstPage)
        );
        let rebuilt = firstPage.content;
        let nextOffset = firstPage.nextOffset;
        let pages = 1;
        let page = firstPage;
        while (page.truncated && pages < 10) {
            page = await runtime.run({
                action: "read",
                params: { path: "long-skill.md", offset: nextOffset },
            });
            rebuilt += page.content;
            nextOffset = page.nextOffset;
            pages += 1;
        }
        check(
            "按 nextOffset 可完整读完长文件",
            rebuilt === longContent && pages === 3 && page.truncated === false,
            "pages=" + pages + " chars=" + rebuilt.length
        );
        const customPage = await runtime.run({
            action: "read",
            params: { path: "long-skill.md", offset: 123, limit: 2500 },
        });
        check(
            "read 支持自定义 offset/limit",
            customPage.content === longContent.slice(123, 2623) &&
                customPage.offset === 123 &&
                customPage.limit === 2500 &&
                customPage.nextOffset === 2623,
            JSON.stringify(customPage)
        );
        const continuationPrompt = getRuntimeOkPrompt(firstPage);
        check(
            "未读完的回包明确要求按 nextOffset 继续",
            continuationPrompt.includes("文件尚未读完") &&
                continuationPrompt.includes('"nextOffset":4000') &&
                continuationPrompt.includes('"offset":4000') &&
                continuationPrompt.indexOf("chars in total") === -1,
            continuationPrompt
        );
        const readDir = await runtime.run({ action: "read", params: { path: "." } });
        check(
            "read 目录返回 entries",
            readDir.ok === true &&
                readDir.type === "directory" &&
                readDir.entries.indexOf("note.txt") !== -1
        );
        const readMissing = await runtime.run({
            action: "read",
            params: { path: "missing.txt" },
        });
        check(
            "read 不存在的文件返回 ok:false",
            readMissing.ok === false && readMissing.error === "File or directory does not exist"
        );
        const escapeMessage = await runtime
            .run({ action: "read", params: { path: "../evil.txt" } })
            .then(() => null)
            .catch((error) => error.message);
        check("越界路径被拒绝", escapeMessage === "Path escapes workspace", String(escapeMessage));

        const writeResult = await runtime.run({
            action: "write",
            params: { path: "sub/created.txt", content: "written" },
        });
        check(
            "write 自动建目录",
            writeResult.ok === true &&
                fs.readFileSync(path.join(workspace, "sub", "created.txt"), "utf8") === "written"
        );
        const badJson = await runtime.run({
            action: "write",
            params: { path: "bad.json", content: "{not json" },
        });
        check(
            "write 保留 JSON 内容校验",
            badJson.ok === false &&
                String(badJson.error).indexOf("Content validation failed") === 0,
            String(badJson.error)
        );

        fs.writeFileSync(path.join(workspace, "edit-me.txt"), "line1\nline2\nline3\n", "utf8");
        const editResult = await runtime.run({
            action: "edit",
            params: { path: "edit-me.txt", changes: [{ old: "line2", new: "LINE-TWO" }] },
        });
        check(
            "edit 只替换命中片段，其余保持不变",
            editResult.ok === true &&
                fs.readFileSync(path.join(workspace, "edit-me.txt"), "utf8") ===
                    "line1\nLINE-TWO\nline3\n",
            String(editResult.error)
        );
        check(
            "edit 回显 diff 供模型自检",
            typeof editResult.diff === "string" && editResult.diff.indexOf("-line2") !== -1,
            String(editResult.diff)
        );
        const editMissing = await runtime.run({
            action: "edit",
            params: { path: "no-such.txt", changes: [{ old: "a", new: "b" }] },
        });
        check(
            "edit 对不存在的文件给出 write 提示",
            editMissing.ok === false &&
                editMissing.error === "File does not exist; use write to create it"
        );

        // exec 依赖真实子进程；本机沙箱可能禁止 spawn，此时只验证"失败被结构化"
        let execOk = false;
        let execDetail = "";
        try {
            const execResult = await runtime.run({
                action: "exec",
                params: { command: "echo hello-runtime" },
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
            params: { content: "最终答案" },
        });
        check("answer 返回内容", answerResult.ok === true && answerResult.content === "最终答案");
        const doneResult = await runtime.run({ action: "done", params: {} });
        check("done 返回 ok", doneResult.ok === true && doneResult.action === "done");

        console.log("\n=== 6. 兼容调用面 ===");
        const handlers = runtime.actionHandlers;
        check(
            "actionHandlers 覆盖全部内置动作",
            EXPECTED_NAMES.every((name) => typeof handlers[name] === "function"),
            Object.keys(handlers).join(",")
        );
        const directRead = await runtime.read({ path: "note.txt" });
        check(
            "runtime.read(...) 直接调用仍可用",
            directRead.ok === true && directRead.content === "hello"
        );
        const directShotEscape = await runtime
            .screenshot({ targets: [{ source: "screen", path: "../evil.png" }] })
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

        console.log("\n=== 8. 提示词指纹与首轮 JSON 协议 ===");
        const promptSha1 = crypto.createHash("sha1").update(SYSTEM_PROMPT, "utf8").digest("hex");
        check("SYSTEM_PROMPT 未被意外改动", promptSha1 === SYSTEM_PROMPT_SHA1, promptSha1);
        check("SYSTEM_PROMPT 不再包含 XML 动作示例", SYSTEM_PROMPT.indexOf("<read") === -1);
        check(
            "SYSTEM_PROMPT 明确 read 续读规则",
            SYSTEM_PROMPT.includes("truncated=true") && SYSTEM_PROMPT.includes("nextOffset")
        );
        const promptWithoutPlugins = getFirstPrompt(workspace, "任务", {
            registry: null,
        });
        check("无插件时首轮提示词以系统提示词开头", promptWithoutPlugins.startsWith(SYSTEM_PROMPT));
        check(
            "无插件时首轮提示词不含注入的插件区块",
            promptWithoutPlugins.indexOf("插件能力（Plugin Actions）") === -1
        );
        check(
            "首轮提示词包含项目与用户任务",
            promptWithoutPlugins.indexOf("项目：" + path.basename(workspace)) !== -1 &&
                promptWithoutPlugins.indexOf("用户任务") !== -1 &&
                promptWithoutPlugins.indexOf("动作路径相对它") !== -1
        );

        const schemaMatch = promptWithoutPlugins.match(/```json\n([\s\S]*?)\n```/);
        let promptSchema = null;
        let schemaParseError = null;
        try {
            promptSchema = schemaMatch ? JSON.parse(schemaMatch[1]) : null;
        } catch (error) {
            schemaParseError = error.message;
        }
        check(
            "首轮提示词内嵌可解析的 JSON Schema",
            Boolean(promptSchema) && JSON.stringify(promptSchema) === JSON.stringify(ACTION_SCHEMA),
            schemaParseError || (schemaMatch ? "schema block found" : "schema block missing")
        );
        check(
            "首轮 Schema 要求 action/params 且包含全部内置动作定义",
            Boolean(promptSchema) &&
                JSON.stringify(promptSchema.required) === JSON.stringify(["action", "params"]) &&
                EXPECTED_NAMES.every((name) =>
                    Boolean(promptSchema.$defs && promptSchema.$defs[name])
                ),
            promptSchema ? Object.keys(promptSchema.$defs || {}).join(",") : "none"
        );
        const schemaRead = promptSchema
            ? validateParams(promptSchema, { action: "read", params: { path: "." } })
            : { ok: false };
        check("首轮 Schema 可校验合法 read 动作", schemaRead.ok === true, schemaRead.error);

        const examples = [
            '{"action":"read","params":{"path":"."}}',
            '{"action":"edit","params":{"path":"src/a.js","changes":[{"old":"const port = 3000;","new":"const port = 3001;"}]}}',
            '{"action":"answer","params":{"content":"最终答案"}}',
            '{"action":"done","params":{}}',
        ];
        for (const example of examples) {
            check(
                "首轮提示词包含合法 JSON 示例：" + example,
                promptWithoutPlugins.indexOf(example) !== -1 &&
                    captureError(() => extractAction(example)) === null
            );
        }
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
