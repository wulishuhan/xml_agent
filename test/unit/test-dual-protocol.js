/**
双协议（XML 默认 / JSON 可选）守卫测试

两套协议共用执行层（runtime + actions），区别只在解析与提示词。本文件钉住四件事：
1. 协议名归一化与默认值（非法值一律退回 xml）；
2. XML 解析器把节点归一化成统一的 { action, params } 信封；
3. 提示词按协议路由到 prompts/xml 与 prompts/json 两个文件夹，各自独立；
4. 配置层 agent.protocol 的默认值 / 校验 / 环境变量覆盖。
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildPluginPromptSection } = require("../../prompts/plugin-prompt");
const { buildSkillPromptSection } = require("../../prompts/skill-prompt");

const {
    normalizeProtocol,
    extractActionForProtocol,
    SUPPORTED_PROTOCOLS,
    DEFAULT_PROTOCOL,
} = require("../../parse/action");
const { extractXmlAction } = require("../../parse/xml-action");
const { extractWenyanAction } = require("../../parse/wenyan-action");
const {
    getFirstPromptForProtocol,
    getErrorPromptForProtocol,
    getRuntimeOkPromptForProtocol,
    getRuntimeErrorPromptForProtocol,
    getDonePromptForProtocol,
    getSendErrorPromptForProtocol,
    getSystemPromptVariantForProtocol,
    pickSystemPromptVariantForProtocol,
    systemPromptVariantCountFor,
} = require("../../prompts/protocol");
const schema = require("../../config/schema");

let pass = 0;
let total = 0;
function check(name, fn) {
    total += 1;
    try {
        fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

async function main() {
    // ---- 1. 协议归一化 ----
    check("默认协议是 xml", () => {
        assert.strictEqual(DEFAULT_PROTOCOL, "xml");
        assert.deepStrictEqual(SUPPORTED_PROTOCOLS, ["xml", "json", "wenyan"]);
    });
    check("合法协议原样保留（含大小写与空白）", () => {
        assert.strictEqual(normalizeProtocol("xml"), "xml");
        assert.strictEqual(normalizeProtocol(" JSON "), "json");
        assert.strictEqual(normalizeProtocol(" wenyan "), "wenyan");
    });
    check("非法 / 空协议退回 xml", () => {
        for (const value of [undefined, null, "", "yaml", 42]) {
            assert.strictEqual(normalizeProtocol(value), "xml", String(value));
        }
    });

    // ---- 2. XML 解析 → 统一信封 ----
    check("read：属性转 params.path", () => {
        assert.deepStrictEqual(extractXmlAction('<read path="package.json"/>'), {
            action: "read",
            params: { path: "package.json" },
        });
    });
    check("write：CDATA 正文转 params.content，剥掉首换行", () => {
        const action = extractXmlAction('<write path="a.js"><![CDATA[\nconst x = 1;\n]]></write>');
        assert.strictEqual(action.action, "write");
        assert.strictEqual(action.params.path, "a.js");
        assert.strictEqual(action.params.content, "const x = 1;\n");
    });
    check("edit：change 子节点转 params.changes，all 转布尔", () => {
        const action = extractXmlAction(
            '<edit path="a.js" all="true"><change><old>x</old><new>y</new></change></edit>'
        );
        assert.strictEqual(action.action, "edit");
        assert.strictEqual(action.params.all, true);
        assert.deepStrictEqual(action.params.changes, [{ old: "x", new: "y" }]);
    });
    check("answer / done：正文与空信封", () => {
        assert.deepStrictEqual(extractXmlAction("<answer><![CDATA[最终答案]]></answer>"), {
            action: "answer",
            params: { content: "最终答案" },
        });
        assert.deepStrictEqual(extractXmlAction("<done/>"), { action: "done", params: {} });
    });
    check("screenshot：单目标与多目标都归一成 targets 数组", () => {
        const single = extractXmlAction('<screenshot source="screen" path="a.png"/>');
        assert.strictEqual(single.action, "screenshot");
        assert.strictEqual(single.params.targets.length, 1);
        assert.strictEqual(single.params.targets[0].source, "screen");
        const multi = extractXmlAction(
            '<screenshot><target source="screen" path="a.png"/>' +
                '<target source="window" windowTitle="VSCode" path="b.png"/></screenshot>'
        );
        assert.strictEqual(multi.params.targets.length, 2);
        assert.strictEqual(multi.params.targets[1].windowTitle, "VSCode");
    });
    check("XML 参数走同一份 schema：缺 path 被拒", () => {
        assert.throws(() => extractXmlAction("<read/>"), /path/);
    });
    check("多个动作被拒（一轮只一个）", () => {
        // 同名多个 → "Multiple ... found"；不同名多个 → "Exactly one"。
        assert.throws(
            () => extractXmlAction('<read path="a"/><read path="b"/>'),
            /Multiple|only one XML Action/
        );
        assert.throws(
            () => extractXmlAction('<read path="a"/><exec command="x"/>'),
            /Exactly one/
        );
    });
    check("去 markdown 围栏后仍可解析", () => {
        const fenced = "```xml\n<read path=\"a.txt\"/>\n```";
        assert.deepStrictEqual(extractActionForProtocol(fenced, "xml"), {
            action: "read",
            params: { path: "a.txt" },
        });
    });

    // ---- 3. 路由：XML / JSON 各走各的解析器 ----
    check("路由按协议分发：同一 XML 文本只有 xml 能解析", () => {
        const xml = '<read path="a.txt"/>';
        assert.deepStrictEqual(extractActionForProtocol(xml, "xml").action, "read");
        assert.throws(() => extractActionForProtocol(xml, "json"));
    });
    check("路由按协议分发：同一 JSON 文本只有 json 能解析", () => {
        const json = '{"action":"read","params":{"path":"a.txt"}}';
        assert.strictEqual(extractActionForProtocol(json, "json").action, "read");
        assert.throws(() => extractActionForProtocol(json, "xml"));
    });

    // ---- 4. 提示词分文件夹、按协议路由 ----
    check("XML 首提示词不含 JSON Schema，且提示 XML 写法", () => {
        const prompt = getFirstPromptForProtocol("D:/tmp/ws", "做个任务", {}, "xml");
        assert.strictEqual(prompt.includes("动作协议 JSON Schema"), false);
        assert.ok(prompt.includes("<read") || prompt.includes("<write"));
        assert.ok(prompt.length < 2500, "len=" + prompt.length);
    });
    check("JSON 首提示词含 JSON Schema，不含 XML 示例", () => {
        const prompt = getFirstPromptForProtocol("D:/tmp/ws", "做个任务", {}, "json");
        assert.ok(prompt.includes("动作协议 JSON Schema"));
        assert.strictEqual(/<\/?[a-zA-Z][^>]*>|<!\[CDATA\[/.test(prompt), false);
    });
    check("XML 首提示词可选注入 manifest，JSON 忽略", () => {
        const xmlWith = getFirstPromptForProtocol(
            "D:/tmp/ws",
            "t",
            { manifest: ["a.js", "b.js"] },
            "xml"
        );
        assert.ok(xmlWith.includes("Workspace Manifest"));
        const xmlWithout = getFirstPromptForProtocol("D:/tmp/ws", "t", {}, "xml");
        assert.strictEqual(xmlWithout.includes("Workspace Manifest"), false);
        const jsonWith = getFirstPromptForProtocol(
            "D:/tmp/ws",
            "t",
            { manifest: ["a.js"] },
            "json"
        );
        assert.strictEqual(jsonWith.includes("Workspace Manifest"), false);
    });
    check("错误提示词按协议路由：XML 不吐 JSON 术语、JSON 不吐 XML 术语", () => {
        const err = new Error("boom");
        const xml = getErrorPromptForProtocol(err, { variant: 0 }, "xml");
        const json = getErrorPromptForProtocol(err, { variant: 0 }, "json");
        assert.ok(xml.length > 0 && json.length > 0);
        assert.strictEqual(xml.includes("JSON 动作"), false);
        assert.strictEqual(json.includes("XML 动作"), false);
    });
    check("两套协议各有 4 套变体，索引可复现", () => {
        assert.strictEqual(systemPromptVariantCountFor("xml"), 4);
        assert.strictEqual(systemPromptVariantCountFor("json"), 4);
        for (const protocol of ["xml", "json"]) {
            const v = pickSystemPromptVariantForProtocol(protocol);
            assert.strictEqual(
                getSystemPromptVariantForProtocol(v, protocol),
                getSystemPromptVariantForProtocol(v, protocol)
            );
        }
    });

    // ---- 5. 配置层 ----
    check("agent.protocol 默认 xml，校验接受 xml/json/wenyan", () => {
        assert.strictEqual(schema.defaultsForUI().agent.protocol, "xml");
        assert.strictEqual(schema.buildConfig({}).agent.protocol, "xml");
        assert.deepStrictEqual(schema.validatePartial({ agent: { protocol: "json" } }), []);
        assert.deepStrictEqual(schema.validatePartial({ agent: { protocol: "wenyan" } }), []);
        assert.ok(schema.validatePartial({ agent: { protocol: "yaml" } }).length > 0);
    });
    check("环境变量 AGENT_ACTION_PROTOCOL 可覆盖，非法值忽略", () => {
        assert.strictEqual(
            schema.buildConfig({ AGENT_ACTION_PROTOCOL: "json" }).agent.protocol,
            "json"
        );
        assert.strictEqual(
            schema.buildConfig({ AGENT_ACTION_PROTOCOL: "wenyan" }).agent.protocol,
            "wenyan"
        );
        assert.strictEqual(
            schema.buildConfig({ AGENT_ACTION_PROTOCOL: "bogus" }).agent.protocol,
            "xml"
        );
    });

    // ---- 逐轮回贴提示按协议路由（E2E 实测暴露的漏修路径）----
    // 首轮提示词对了不算完：每步结果回贴里若写死"只输出 JSON 动作对象"，
    // XML 会话会在第 2 步被带偏，进而解析失败。这里把两协议的措辞钉死。
    check("XML 成功回贴只讲 XML，不含 JSON 动作指令", () => {
        const prompt = getRuntimeOkPromptForProtocol(
            { ok: true, action: "read", path: ".", entries: [] },
            {},
            "xml"
        );
        assert.ok(!prompt.includes("JSON 动作对象"), "XML 回贴不该出现 JSON 指令");
        assert.ok(prompt.includes("<answer>"), "XML 回贴应给出 <answer> 示例");
        assert.ok(prompt.includes("<done/>"), "XML 回贴应给出 <done/> 示例");
    });

    check("JSON 成功回贴只讲 JSON，不含 XML 动作示例", () => {
        const prompt = getRuntimeOkPromptForProtocol(
            { ok: true, action: "read", path: ".", entries: [] },
            {},
            "json"
        );
        assert.ok(prompt.includes("JSON 动作对象"), "JSON 回贴应给出 JSON 指令");
        assert.ok(!prompt.includes("<answer>"), "JSON 回贴不该出现 XML 示例");
    });

    check("XML 失败回贴只讲 XML，不含 JSON 动作指令", () => {
        const prompt = getRuntimeErrorPromptForProtocol(
            { ok: false, action: "read", error: "not found" },
            {},
            "xml"
        );
        assert.ok(!prompt.includes("JSON 动作对象"), "XML 失败回贴不该出现 JSON 指令");
        assert.ok(prompt.includes("<answer>"), "XML 失败回贴应给出 <answer> 兜底示例");
    });

    check("JSON 失败回贴只讲 JSON", () => {
        const prompt = getRuntimeErrorPromptForProtocol(
            { ok: false, action: "read", error: "not found" },
            {},
            "json"
        );
        assert.ok(prompt.includes("JSON 动作对象"), "JSON 失败回贴应给出 JSON 指令");
    });

    check("XML 分页属性转成整数，能被 schema 接受", () => {
        const action = extractXmlAction('<read path="a.js" offset="4000" limit="2000"/>');
        assert.strictEqual(action.params.offset, 4000);
        assert.strictEqual(action.params.limit, 2000);
    });

    check("XML 分页续读提示给出 XML 动作", () => {
        const prompt = getRuntimeOkPromptForProtocol(
            { ok: true, action: "read", path: "a.js", truncated: true, nextOffset: 4000, limit: 4000 },
            {},
            "xml"
        );
        assert.ok(prompt.includes('<read path="a.js" offset="4000"'), "应给出 XML 续读动作");
        assert.ok(!prompt.includes("JSON 动作对象"), "续读提示不该夹带 JSON 动作指令");
    });

    check("收尾 done 提示按协议路由，XML 不吐 JSON、JSON 不吐 XML", () => {
        const xmlDone = getDonePromptForProtocol("xml");
        const jsonDone = getDonePromptForProtocol("json");
        assert.ok(xmlDone.includes("<done/>"), "XML 收尾应要求 <done/>");
        assert.ok(!xmlDone.includes('"action":"done"'), "XML 收尾不该出现 JSON 动作");
        assert.ok(jsonDone.includes('"action":"done"'), "JSON 收尾应要求 JSON 动作");
        assert.ok(!jsonDone.includes("<done/>"), "JSON 收尾不该出现 XML 动作");
    });

    check("发送失败续接提示按协议路由，XML 不吐 JSON 指令", () => {
        const xmlPrompt = getSendErrorPromptForProtocol(
            Object.assign(new Error("empty response"), { code: "EMPTY_RESPONSE" }),
            { variant: 0 },
            "xml"
        );
        const jsonPrompt = getSendErrorPromptForProtocol(
            Object.assign(new Error("empty response"), { code: "EMPTY_RESPONSE" }),
            { variant: 0 },
            "json"
        );
        assert.ok(!xmlPrompt.includes("JSON 动作对象"), "XML 续接提示不该出现 JSON 指令");
        assert.ok(xmlPrompt.includes("按开头"), "XML 续接提示应指向首条格式");
        assert.ok(jsonPrompt.includes("JSON 动作对象"), "JSON 续接提示应给出 JSON 指令");
    });

    // ---- 6. 插件 / 技能注入内容按协议渲染（审计发现的双向串协议）----
    // 插件 usage 历史上是 JSON 写的，XML 会话会照抄；技能文档里曾有裸 <exec/>，
    // JSON 会话会被带偏。两侧都钉死：注入什么格式，取决于当前协议。
    const fakeContributions = [
        {
            plugin: "fetch",
            action: "fetch",
            group: "network",
            priority: 50,
            note: "抓网页",
            usage: '{"action":"fetch","params":{"url":"http://127.0.0.1:3000/api/health","method":"GET"}}',
        },
        {
            plugin: "screenshot",
            action: "screenshot",
            group: "system",
            priority: 80,
            note: "截图",
            usage: '{"action":"screenshot","params":{"targets":[{"source":"screen","path":"a.png"}]}}',
            usageXml: '<screenshot><target source="screen" path="a.png"/></screenshot>',
        },
    ];
    const fakeRegistry = { listPromptContributions: () => fakeContributions };

    check("插件提示词：XML 协议把简单 JSON 用法折算成 XML 标签", () => {
        const section = buildPluginPromptSection(fakeRegistry, { protocol: "xml" });
        assert.ok(section.includes("<fetch url="), section);
        assert.ok(section.includes("<screenshot><target"), "复杂参数应走 usageXml");
        assert.ok(!section.includes('"action":"fetch"'), "XML 区块不该出现 JSON 示例");
        assert.ok(!section.includes('"action":"screenshot"'), "XML 区块不该出现 JSON 示例");
    });

    check("插件提示词：JSON 协议保持 JSON 用法，不出现 XML 标签", () => {
        const section = buildPluginPromptSection(fakeRegistry, { protocol: "json" });
        assert.ok(section.includes('"action":"fetch"'), section);
        assert.ok(!section.includes("<fetch "), "JSON 区块不该出现 XML 标签");
        assert.ok(!section.includes("<screenshot>"), "JSON 区块不该出现 XML 标签");
    });

    check("首轮提示词注入插件时，XML 协议不夹带 JSON 示例", () => {
        const prompt = getFirstPromptForProtocol(
            "D:/tmp/ws",
            "t",
            { registry: fakeRegistry },
            "xml"
        );
        assert.ok(prompt.includes("<fetch url="), "应折算成 XML 用法");
        assert.ok(!prompt.includes('"action":"fetch"'), "不该夹带 JSON 示例");
    });

    check("插件提示词：老插件的 XML 用法在 JSON 协议下降级，不照抄", () => {
        const legacy = [
            {
                plugin: "legacy",
                action: "legacy-do",
                group: "plugin",
                priority: 50,
                note: "早期插件",
                usage: '<legacy-do path="a.txt"/>',
            },
        ];
        const section = buildPluginPromptSection(
            { listPromptContributions: () => legacy },
            { protocol: "json" }
        );
        assert.ok(!section.includes("<legacy-do"), "JSON 区块不该输出 XML 示例");
        assert.ok(section.includes("首条消息给的 JSON 协议"));
    });

    check("技能段只说按首条消息协议，不写死 XML 动作语法", () => {
        const section = buildSkillPromptSection([
            {
                name: "demo",
                workspacePath: ".agent/skills/demo.md",
                description: "示范",
                enabled: true,
                active: true,
            },
        ]);
        assert.ok(section.includes("首条消息给的协议"));
        assert.ok(!/<(read|write|edit|exec|answer|done)[\s/>]/.test(section));
    });

    check("内置技能文档不含 XML 动作示例（JSON 协议不会被带偏）", () => {
        const file = path.join(__dirname, "../../skills/novel-writing/SKILL.md");
        const text = fs.readFileSync(file, "utf8");
        assert.ok(!/<(read|write|edit|exec|answer|done|screenshot)[\s/>]/.test(text));
    });

    const wenyanSkill = [
        {
            name: "demo",
            workspacePath: ".agent/skills/demo.md",
            description: "示范",
            enabled: true,
            active: true,
        },
    ];
    check("技能段在 wenyan 下文言化，并给出英文动作名映射", () => {
        const section = buildSkillPromptSection(wenyanSkill, { protocol: "wenyan" });
        assert.ok(section.includes("可用之术"), section);
        assert.ok(section.includes("先 阅 其文"), section);
        assert.ok(section.includes("所在：.agent/skills/demo.md"), section);
        assert.ok(section.includes("read / write / edit / exec / answer / done"), section);
        assert.ok(section.includes("阅 / 书 / 改 / 行 / 答 / 毕"), section);
        assert.ok(!section.includes("先用 read"), section);
        assert.ok(!section.includes("路径："), section);
    });

    check("wenyan 首轮提示词注入技能时不夹带 read 动作语法", () => {
        const first = getFirstPromptForProtocol(
            "/tmp/proj",
            "task",
            { skills: wenyanSkill },
            "wenyan"
        );
        assert.ok(first.includes("可用之术"), first);
        assert.ok(!first.includes("先用 read"), first);
        assert.ok(!/<read/.test(first), first);
    });

    // ---- 7. 文言文实验协议（wenyan）----
    check("wenyan：单字动词解析为统一信封", () => {
        assert.deepStrictEqual(extractWenyanAction("阅｜package.json"), {
            action: "read",
            params: { path: "package.json" },
        });
        assert.deepStrictEqual(extractWenyanAction("毕"), { action: "done", params: {} });
    });

    check("wenyan：正文用「」包裹，可含 ｜ 与换行", () => {
        const r = extractWenyanAction('书｜a.js｜「const s = "a|b";\nnext();」');
        assert.strictEqual(r.action, "write");
        assert.strictEqual(r.params.content, 'const s = "a|b";\nnext();');
    });

    check("wenyan：多组 edit 与「全」", () => {
        const r = extractWenyanAction("改｜f.js｜「a()」｜「A()」｜「b()」｜「B()」｜全");
        assert.strictEqual(r.action, "edit");
        assert.strictEqual(r.params.changes.length, 2);
        assert.strictEqual(r.params.all, true);
    });

    check("wenyan：参数经既有 schema 校验（非法 limit 报错）", () => {
        assert.throws(() => extractWenyanAction("阅｜a.js｜0｜xx"), /limit must be integer/);
    });

    check("wenyan：围栏与空格写法容错", () => {
        assert.strictEqual(extractWenyanAction("```wenyan\n阅｜a.js\n```").params.path, "a.js");
        assert.strictEqual(extractWenyanAction("阅 package.json").params.path, "package.json");
    });

    check("wenyan：紧凑写法（空格分隔）与 ｜ 写法等价", () => {
        assert.deepStrictEqual(extractWenyanAction("阅 a.js 100 4000"), {
            action: "read",
            params: { path: "a.js", offset: 100, limit: 4000 },
        });
        assert.deepStrictEqual(extractWenyanAction("阅 a.js 100 4000"), extractWenyanAction("阅｜a.js｜100｜4000"));
        assert.deepStrictEqual(extractWenyanAction("书 a.js「x=1」"), extractWenyanAction("书｜a.js｜「x=1」"));
        assert.deepStrictEqual(extractWenyanAction("改 a.js「旧」「新」 全"), extractWenyanAction("改｜a.js｜「旧」｜「新」｜全"));
        assert.deepStrictEqual(extractWenyanAction("行 npm test"), extractWenyanAction("行｜npm test"));
        assert.deepStrictEqual(extractWenyanAction("摄 screen shot.png"), extractWenyanAction("摄｜screen｜shot.png"));
        assert.deepStrictEqual(extractWenyanAction("答「hi」"), extractWenyanAction("答｜「hi」"));
    });

    check("wenyan 解析走独立路由，xml/json 不受影响", () => {
        assert.strictEqual(extractActionForProtocol("答｜「hi」", "wenyan").action, "answer");
        assert.strictEqual(
            extractActionForProtocol("<answer><![CDATA[hi]]></answer>", "xml").action,
            "answer"
        );
        assert.strictEqual(
            extractActionForProtocol('{"action":"answer","params":{"content":"hi"}}', "json").action,
            "answer"
        );
    });

    check("wenyan 提示词纯文言，无 XML/JSON 串入、无插件示例", () => {
        const first = getFirstPromptForProtocol("/tmp/proj", "task", {}, "wenyan");
        assert.ok(first.includes("阅"));
        assert.ok(!/<read/.test(first));
        assert.ok(!/JSON Schema/.test(first));
        assert.ok(!/fetch/.test(first)); // 插件示例未注入
        for (const fn of [
            getRuntimeOkPromptForProtocol,
            getRuntimeErrorPromptForProtocol,
            getDonePromptForProtocol,
        ]) {
            // 各路由产物非 JSON 信封、非 XML 标签
            const out = fn === getDonePromptForProtocol ? fn("wenyan") : fn({ ok: true }, {}, "wenyan");
            assert.ok(!/\{"action"/.test(out), String(out));
            assert.ok(!/<(read|answer|done)/.test(out), String(out));
        }
    });

    check("wenyan 变体与默认协议隔离", () => {
        assert.strictEqual(systemPromptVariantCountFor("wenyan"), 4);
        const defaultFirst = getFirstPromptForProtocol("/tmp/proj", "task", {}, "xml");
        assert.ok(defaultFirst.includes("<read")); // xml 默认行为未变
    });

    console.log("\nTotal: " + pass + "/" + total);
    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("FATAL", error);
    process.exitCode = 2;
});
