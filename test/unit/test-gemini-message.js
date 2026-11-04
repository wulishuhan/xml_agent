/**
Gemini 消息 DOM 重建单测（providers/dom/gemini-message.js）

Gemini 的助手回复容器里混了三类"不是回答内容"的东西：
`<model-thoughts>` 思考过程、代码块右上角的语言标签与复制按钮、Google 搜索引用角标。
这层如果退化，取回复要么拿到"正在思考"的噪声，要么把按钮文案当正文，
要么代码块退化成裸文本（XML 解析随之失真）。

运行：node test/unit/test-gemini-message.js
*/

const { renderGeminiMessage } = require("../../providers/dom/gemini-message");
const { build, text } = require("./fake-dom");

const FENCE = String.fromCharCode(96, 96, 96);

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function countFences(value) {
    let count = 0;
    let index = 0;
    while ((index = value.indexOf(FENCE, index)) !== -1) {
        count += 1;
        index += FENCE.length;
    }
    return count;
}

/** 复刻真实 Gemini 消息结构：thinking 面板 + markdown 正文 + code-block。 */
function buildCodeBlock(options = {}) {
    const language = options.language === undefined ? "python" : options.language;
    const code = options.code === undefined ? "print(1)" : options.code;

    const decoration = build(
        "div.code-block-decoration",
        [
            language ? build("span", [text(language)]) : null,
            build("button", [text("复制代码")]),
        ].filter(Boolean)
    );

    const codeElement = language
        ? build("code.language-" + language, [text(code)])
        : build("code", [text(code)]);

    return build("code-block", [
        build("div.code-block", [
            decoration,
            build("div.code-block-content", [build("pre", [codeElement])]),
        ]),
    ]);
}

function buildMessage(options = {}) {
    return build("model-response", [
        build(
            "div.response-container",
            [
                options.thinking === false
                    ? null
                    : build("model-thoughts", [
                          build("div.thoughts", [text("用户在问代码问题，我应该先解释再给例子")]),
                      ]),
                build("message-content.model-response-text", [
                    build("div.markdown.markdown-main-panel", [
                        options.head === undefined ? build("p", [text("这是回答")]) : options.head,
                        options.body === undefined ? buildCodeBlock() : options.body,
                    ]),
                ]),
                build("div.response-footer", [build("button", [text("赞同")])]),
            ].filter(Boolean)
        ),
    ]);
}

async function main() {
    // ------------------------------------------------------------
    // 1. 思考面板与页脚不进正文
    // ------------------------------------------------------------
    {
        const output = await renderGeminiMessage(buildMessage());

        check("正文保留", output.indexOf("这是回答") !== -1, JSON.stringify(output));
        check("思考过程被移除", output.indexOf("用户在问代码问题") === -1);
        check("消息操作栏被移除", output.indexOf("赞同") === -1);
        check("复制按钮文案不进正文", output.indexOf("复制代码") === -1);
    }

    // ------------------------------------------------------------
    // 2. 代码块还原成带语言的围栏
    // ------------------------------------------------------------
    {
        const output = await renderGeminiMessage(buildMessage());

        check(
            "输出包含 python 围栏",
            output.indexOf(FENCE + "python") !== -1,
            JSON.stringify(output)
        );
        check("围栏成对出现", countFences(output) === 2, "fences=" + countFences(output));
        check("代码正文保留", output.indexOf("print(1)") !== -1);
        check(
            "语言标签不混进正文",
            output.split("\n").filter((line) => line === "python").length === 0,
            JSON.stringify(output)
        );
    }

    // ------------------------------------------------------------
    // 3. 语言只在装饰条上（<code> 无 language-* 类）
    // ------------------------------------------------------------
    {
        const block = build("code-block", [
            build("div.code-block", [
                build("div.code-block-decoration", [
                    build("span", [text("javascript")]),
                    build("button", [text("复制代码")]),
                ]),
                build("div.code-block-content", [
                    build("pre", [build("code", [text("let a = 1;")])]),
                ]),
            ]),
        ]);
        const output = await renderGeminiMessage(buildMessage({ body: block }));

        check(
            "装饰条语言被识别",
            output.indexOf(FENCE + "javascript") !== -1,
            JSON.stringify(output)
        );
        check("装饰条文本不进正文", output.indexOf("复制代码") === -1);
    }

    // ------------------------------------------------------------
    // 4. 无语言时输出无语言围栏
    // ------------------------------------------------------------
    {
        const output = await renderGeminiMessage(
            buildMessage({ language: "", body: buildCodeBlock({ language: "", code: "echo hi" }) })
        );

        check(
            "无语言围栏",
            output.indexOf(FENCE + "\necho hi\n" + FENCE) !== -1,
            JSON.stringify(output)
        );
    }

    // ------------------------------------------------------------
    // 5. 只有思考、没有正文 → 空串（上层据此继续等待，而不是当成回复已到）
    // ------------------------------------------------------------
    {
        const thinkingOnly = build("model-response", [
            build("div.response-container", [
                build("model-thoughts", [build("div.thoughts", [text("正在思考…")])]),
            ]),
        ]);
        const output = await renderGeminiMessage(thinkingOnly);

        check("纯思考消息渲染为空", output === "", JSON.stringify(output));
    }

    // ------------------------------------------------------------
    // 6. 标题 / 列表 / 行内代码 / 引用角标
    // ------------------------------------------------------------
    {
        const message = buildMessage({
            head: build("h2", [text("方案")]),
            body: build("div.markdown", [
                build("ul", [build("li", [text("第一步")]), build("li", [text("第二步")])]),
                build("ol", [build("li", [text("甲")]), build("li", [text("乙")])]),
                build("p", [text("用 "), build("code", [text("npm i")]), text(" 安装")]),
                build("source-footnote", [text("1")]),
                build("p", [text("来源说明")]),
            ]),
        });
        const output = await renderGeminiMessage(message);

        check("标题保留", output.indexOf("## 方案") !== -1, JSON.stringify(output));
        check("无序列表补回 - 前缀", output.indexOf("- 第一步") !== -1);
        check(
            "有序列表用数字前缀",
            output.indexOf("1. 甲") !== -1 && output.indexOf("2. 乙") !== -1
        );
        check("行内代码用反引号", output.indexOf("`npm i`") !== -1);
        check("引用角标被移除", output.split("\n").indexOf("1") === -1, JSON.stringify(output));
        check("引用之后的正文保留", output.indexOf("来源说明") !== -1);
    }

    // ------------------------------------------------------------
    // 7. 表格转成 Markdown 管道表
    // ------------------------------------------------------------
    {
        const table = build("table", [
            build("thead", [
                build("tr", [build("th", [text("参数")]), build("th", [text("说明")])]),
            ]),
            build("tbody", [
                build("tr", [build("td", [text("a")]), build("td", [text("第一项")])]),
                build("tr", [build("td", [text("b")]), build("td", [text("第二项")])]),
            ]),
        ]);
        const output = await renderGeminiMessage(buildMessage({ body: table }));

        check("表头保留", output.indexOf("| 参数 | 说明 |") !== -1, JSON.stringify(output));
        check("分隔行生成", output.indexOf("| --- | --- |") !== -1);
        check("数据行保留", output.indexOf("| a | 第一项 |") !== -1);
    }

    // ------------------------------------------------------------
    // 8. 多个代码块各自成块
    // ------------------------------------------------------------
    {
        const body = build("div.markdown", [
            buildCodeBlock({ language: "bash", code: "ls -la" }),
            buildCodeBlock({ language: "python", code: "print(2)" }),
        ]);
        const output = await renderGeminiMessage(buildMessage({ body }));

        check("两个代码块都还原", countFences(output) === 4, "fences=" + countFences(output));
        check(
            "两个代码块语言正确",
            output.indexOf(FENCE + "bash") !== -1 && output.indexOf(FENCE + "python") !== -1
        );
    }

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("FAILED: " + error.message);
    process.exit(1);
});
