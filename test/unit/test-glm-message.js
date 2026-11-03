/**
GLM 消息 DOM 重建单测（providers/dom/glm-message.js）

GLM 的代码块不是 <pre>，而是 CodeMirror 6：
每行一个 div.cm-line，外层还有语言标签和复制按钮。
这层逻辑一旦退化，模型回复里的代码会变成"语言名 + 裸文本"，
下游 extractXML 与 markdown 渲染都会失真，所以用假 DOM 把契约钉住。

运行：node test/unit/test-glm-message.js
*/

const assert = require("assert");

const { renderGlmMessage } = require("../../providers/dom/glm-message");
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

/** 复刻真实 GLM 消息结构：thinking 折叠块 + 正文 + CodeMirror 代码块。 */
function buildMessage(options = {}) {
    const language = options.language === undefined ? "bash" : options.language;
    const lines = options.lines || ["npm install demo"];

    const cmEditor = build("div.cm-editor", [
        build(
            "div.cm-content",
            lines.map((line) => build("div.cm-line", [text(line)]))
        ),
        build("div.cm-layer.cm-cursorLayer", [build("div.cm-cursor", [])]),
    ]);
    const codeInner = build("div.h-full", [cmEditor]);
    // 无语言时 GLM 不会挂 language-* 类，只有语言标签那一格是空的
    const codeBody = language ? build("div.language-" + language, [codeInner]) : codeInner;

    const codeBlock = build("div.relative.my-2.rounded-xl", [
        build("div.absolute", [text(language)]),
        build("div.sticky", [build("button.copy-code-button", [])]),
        codeBody,
    ]);

    return build("div.chat-assistant", [
        build("div.markdown-prose", [
            build("div.thinking-chain-container", [
                build("button.flex", [build("span.text-sm", [text("思考过程")])]),
            ]),
            build("p", [text(options.head === undefined ? "<write>" : options.head)]),
            codeBlock,
            build("p", [text(options.tail === undefined ? "</write>" : options.tail)]),
        ]),
    ]);
}

async function main() {
    // ------------------------------------------------------------
    // 1. 代码块还原成带语言的围栏
    // ------------------------------------------------------------
    {
        const output = await renderGlmMessage(buildMessage());

        check("输出包含 bash 围栏", output.indexOf(FENCE + "bash") !== -1, output.split("\n")[1]);
        check("围栏成对出现", countFences(output) === 2, "fences=" + countFences(output));
        check(
            "代码正文完整",
            output.indexOf("npm install demo") !== -1,
            JSON.stringify(output.slice(0, 80))
        );
        check(
            "语言标签不再混入正文",
            output.split("\n")[1] === FENCE + "bash",
            JSON.stringify(output.split("\n")[1])
        );
        check("思考过程被移除", output.indexOf("思考过程") === -1);
        check(
            "正文前后内容保留",
            output.indexOf("<write>") !== -1 && output.indexOf("</write>") !== -1
        );
    }

    // ------------------------------------------------------------
    // 2. 多行 + 空行 + 缩进
    // ------------------------------------------------------------
    {
        const output = await renderGlmMessage(
            buildMessage({
                language: "javascript",
                lines: ["function greet(name) {", "", "  return name;", "}"],
            })
        );
        const expected =
            FENCE + "javascript\nfunction greet(name) {\n\n  return name;\n}\n" + FENCE;

        check("多行代码逐行还原", output.indexOf(expected) !== -1, JSON.stringify(output));
        check("缩进未被吃掉", output.indexOf("  return name;") !== -1);
        check("空行被保留", output.indexOf("greet(name) {\n\n  return name;") !== -1);
    }

    // ------------------------------------------------------------
    // 3. 无语言时输出无语言围栏
    // ------------------------------------------------------------
    {
        const output = await renderGlmMessage(buildMessage({ language: "", lines: ["echo hi"] }));

        check(
            "无语言围栏",
            output.indexOf(FENCE + "\necho hi\n" + FENCE) !== -1,
            JSON.stringify(output)
        );
        check("无语言时不残留标签文本", output.split("\n")[1] === FENCE);
    }

    // ------------------------------------------------------------
    // 4. 非代码消息行为不变（不能因为新逻辑破坏普通段落/标题/粗体）
    // ------------------------------------------------------------
    {
        const message = build("div.chat-assistant", [
            build("div.markdown-prose", [
                build("h2", [text("标题")]),
                build("p", [text("正文"), build("strong", [text("加粗")])]),
            ]),
        ]);
        const output = await renderGlmMessage(message);

        check("标题保留", output.indexOf("## 标题") !== -1, JSON.stringify(output));
        check("粗体保留", output.indexOf("**加粗**") !== -1);
        check("普通消息不产生围栏", countFences(output) === 0);
    }

    // ------------------------------------------------------------
    // 6. 列表结构要补回标记
    // ------------------------------------------------------------
    {
        const message = build("div.chat-assistant", [
            build("div.markdown-prose", [
                build("ul", [build("li", [text("项目一")]), build("li", [text("项目二")])]),
                build("ol", [build("li", [text("第一步")]), build("li", [text("第二步")])]),
            ]),
        ]);
        const output = await renderGlmMessage(message);

        check("无序列表补回 - 前缀", output.indexOf("- 项目一") !== -1, JSON.stringify(output));
        check("无序列表第二项", output.indexOf("- 项目二") !== -1);
        check("有序列表用数字前缀", output.indexOf("1. 第一步") !== -1);
        check("有序列表序号递增", output.indexOf("2. 第二步") !== -1);
    }

    // ------------------------------------------------------------
    // 7. 工具调用轨迹不算正文
    // ------------------------------------------------------------
    {
        const message = build("div.chat-assistant", [
            build("div.markdown-prose", [
                build("div.my-4.toolCallTrace", [
                    build("button.flex", [build("span.text-sm", [text("写入 1 次文件")])]),
                    build("div.flex", [
                        build("button.flex", [build("span.px-1", [text("写文件")])]),
                    ]),
                ]),
            ]),
        ]);
        const output = await renderGlmMessage(message);

        check("工具调用轨迹被移除", output === "", JSON.stringify(output));
    }

    // ------------------------------------------------------------
    // 6. 工具轨迹之后仍有正文时，只保留正文
    // ------------------------------------------------------------
    {
        const message = build("div.chat-assistant", [
            build("div.markdown-prose", [
                build("div.my-4.toolCallTrace", [build("span.text-sm", [text("写入 1 次文件")])]),
                build("p", [text("<answer>done</answer>")]),
            ]),
        ]);
        const output = await renderGlmMessage(message);

        check("工具轨迹不污染正文", output === "<answer>done</answer>", JSON.stringify(output));
    }

    // ------------------------------------------------------------
    // 7. 长代码走 CodeMirror 视图对象（DOM 只有可视的几行）
    // ------------------------------------------------------------
    {
        const content = build("div.cm-content", [
            // 虚拟滚动：DOM 里只剩一行，其余在 .cm-gap 里
            build("div.cm-line", [text("visible line only")]),
            build("div.cm-gap", []),
        ]);
        const editor = build("div.cm-editor", [content]);

        content.cmView = {
            rootView: {
                view: {
                    state: {
                        doc: { toString: () => "line1\nline2\nline3" },
                    },
                },
            },
        };

        const message = build("div.chat-assistant", [
            build("div.markdown-prose", [
                build("div.relative.my-2.rounded-xl", [
                    build("div.absolute", [text("javascript")]),
                    editor,
                ]),
            ]),
        ]);
        const output = await renderGlmMessage(message);

        check(
            "优先使用视图对象的完整文档",
            output.indexOf("line1\nline2\nline3") !== -1,
            JSON.stringify(output)
        );
        check("不使用残缺的 DOM 行", output.indexOf("visible line only") === -1);
    }

    // ------------------------------------------------------------
    // 8. 视图对象不可用时回退到 DOM 行
    // ------------------------------------------------------------
    {
        const content = build("div.cm-content", [build("div.cm-line", [text("fallback line")])]);
        const editor = build("div.cm-editor", [content]);

        content.cmView = {
            rootView: {
                view: {
                    state: {
                        doc: {
                            toString: () => {
                                throw new Error("view destroyed");
                            },
                        },
                    },
                },
            },
        };

        const message = build("div.chat-assistant", [
            build("div.markdown-prose", [build("div.relative.my-2.rounded-xl", [editor])]),
        ]);
        const output = await renderGlmMessage(message);

        check(
            "视图取值失败时回退 DOM 行",
            output.indexOf("fallback line") !== -1,
            JSON.stringify(output)
        );
    }

    // ------------------------------------------------------------
    // 9. 多个代码块各自成块
    // ------------------------------------------------------------
    {
        const twoBlocks = build("div.chat-assistant", [
            build("div.markdown-prose", [
                build("div.relative.my-2.rounded-xl", [
                    build("div.absolute", [text("bash")]),
                    build("div.language-bash", [
                        build("div.cm-editor", [build("div.cm-line", [text("one")])]),
                    ]),
                ]),
                build("div.relative.my-2.rounded-xl", [
                    build("div.absolute", [text("python")]),
                    build("div.language-python", [
                        build("div.cm-editor", [build("div.cm-line", [text("two")])]),
                    ]),
                ]),
            ]),
        ]);
        const output = await renderGlmMessage(twoBlocks);

        check("两个代码块都还原", countFences(output) === 4, "fences=" + countFences(output));
        check(
            "两个代码块语言正确",
            output.indexOf(FENCE + "bash") !== -1 && output.indexOf(FENCE + "python") !== -1
        );
        check("两个代码块内容正确", output.indexOf("one") !== -1 && output.indexOf("two") !== -1);
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
