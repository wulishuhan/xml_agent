/**
双协议（XML 默认 / JSON 可选）守卫测试

两套协议共用执行层（runtime + actions），区别只在解析与提示词。本文件钉住四件事：
1. 协议名归一化与默认值（非法值一律退回 xml）；
2. XML 解析器把节点归一化成统一的 { action, params } 信封；
3. 提示词按协议路由到 prompts/xml 与 prompts/json 两个文件夹，各自独立；
4. 配置层 agent.protocol 的默认值 / 校验 / 环境变量覆盖。
*/

const assert = require("assert");

const {
    normalizeProtocol,
    extractActionForProtocol,
    SUPPORTED_PROTOCOLS,
    DEFAULT_PROTOCOL,
} = require("../../parse/action");
const { extractXmlAction } = require("../../parse/xml-action");
const {
    getFirstPromptForProtocol,
    getErrorPromptForProtocol,
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
        assert.deepStrictEqual(SUPPORTED_PROTOCOLS, ["xml", "json"]);
    });
    check("合法协议原样保留（含大小写与空白）", () => {
        assert.strictEqual(normalizeProtocol("xml"), "xml");
        assert.strictEqual(normalizeProtocol(" JSON "), "json");
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
    check("agent.protocol 默认 xml，校验只接受 xml/json", () => {
        assert.strictEqual(schema.defaultsForUI().agent.protocol, "xml");
        assert.strictEqual(schema.buildConfig({}).agent.protocol, "xml");
        assert.deepStrictEqual(schema.validatePartial({ agent: { protocol: "json" } }), []);
        assert.ok(schema.validatePartial({ agent: { protocol: "yaml" } }).length > 0);
    });
    check("环境变量 AGENT_ACTION_PROTOCOL 可覆盖，非法值忽略", () => {
        assert.strictEqual(
            schema.buildConfig({ AGENT_ACTION_PROTOCOL: "json" }).agent.protocol,
            "json"
        );
        assert.strictEqual(
            schema.buildConfig({ AGENT_ACTION_PROTOCOL: "bogus" }).agent.protocol,
            "xml"
        );
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
