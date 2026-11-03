/**
GLM 助手消息的 DOM → Markdown 重建。

为什么单独一个文件：
1. 这个函数会被序列化送进页面执行（`message.evaluate(renderGlmMessage)`），
   所以它必须**自包含**：不能 require 任何模块，也不能引用文件级变量。
2. 抽出来之后可以用假 DOM 单独单测，不必启动浏览器。

GLM 和别的平台有两处不一样，都在这里消化：

**代码块不是 `<pre>`**。它用 CodeMirror 6 渲染：语言标签、复制按钮、
每行一个 `div.cm-line`，语言标在 `language-*` 类上。不归一化的话，
代码块会退化成"语言名 + 裸文本"，markdown 与 XML 解析都会失真。

**长代码会被虚拟滚动裁掉**。CM6 只渲染视口内的几十行，中间用
`div.cm-gap` 占位。只读 `.cm-line` 拿到的是残缺代码，缺的正好是中段。
好在 CM6 会把视图对象挂在 `.cm-content` 的 `cmView` 上，
顺着它能拿到**完整文档**——这也比"滚动取样再拼接"可靠得多
（`.cm-gap` 高度是估算值，滚动时会漂移，拼出来的行序会错）。
*/
function renderGlmMessage(element) {
    // DOM 节点类型常量：页面里有全局 Node，Node.js 单测里没有，所以写字面量。
    const TEXT_NODE = 3;
    const ELEMENT_NODE = 1;

    // 克隆树是 detached 的，建节点需要原始文档
    const doc = element.ownerDocument || null;

    function classOf(node) {
        if (!node || !node.getAttribute) {
            return "";
        }
        const raw = node.className;
        if (typeof raw === "string") {
            return raw;
        }
        // SVG 元素的 className 是 SVGAnimatedString，不是字符串
        if (raw && typeof raw.baseVal === "string") {
            return raw.baseVal;
        }
        return node.getAttribute("class") || "";
    }

    function normalizeText(value) {
        return String(value || "").replace(/\u00a0/g, " ");
    }

    // ------------------------------------------------------------
    // 代码正文
    // ------------------------------------------------------------

    /**
    从 CodeMirror 的视图对象里取完整文档。

    CM6 把 `cmView` 挂在 `.cm-content` 上，`rootView.view.state.doc`
    就是整份源码（与是否渲染无关）。取不到就返回 null，交给 DOM 兜底。
    */
    function readCodeMirrorDocument(content) {
        const cmView = content && content.cmView;

        if (!cmView) {
            return null;
        }

        const candidates = [cmView.rootView, cmView.rootView && cmView.rootView.view, cmView.view];

        for (const view of candidates) {
            const state = view && view.state;
            const source = state && state.doc;

            if (!source || typeof source.toString !== "function") {
                continue;
            }

            try {
                const text = source.toString();

                if (typeof text === "string" && text) {
                    return text;
                }
            } catch (error) {
                // 视图已销毁，换下一个候选
            }
        }

        return null;
    }

    /** 代码正文：优先拿完整文档，其次按 .cm-line 逐行读（可能因虚拟滚动不全）。 */
    function readCode(editor) {
        const content = editor.querySelector(".cm-content") || editor;
        const full = readCodeMirrorDocument(content);

        if (full !== null) {
            return full;
        }

        const lines = Array.from(content.querySelectorAll(".cm-line")).map((line) =>
            normalizeText(line.textContent)
        );

        if (lines.length) {
            return lines.join("\n");
        }

        // 结构变了，退回整块文本
        return normalizeText(editor.textContent);
    }

    // ------------------------------------------------------------
    // 代码块替换成 <pre data-lang>
    // ------------------------------------------------------------

    /** 从 CodeMirror 容器里读出语言；读不到就返回空串（等价于无语言围栏）。 */
    function detectLanguage(block, editor) {
        let node = editor;

        while (node) {
            const matched = classOf(node).match(/language-([a-zA-Z0-9+#._-]+)/);

            if (matched) {
                return matched[1];
            }

            if (node === block) {
                break;
            }

            node = node.parentElement;
        }

        // 兜底：代码块容器左上角的语言标签（例如 "bash"）。
        // 只有短标识符才当语言，避免结构变化时把正文误判成语言。
        const head = block.firstElementChild;

        if (head) {
            const label = normalizeText(head.textContent).trim();

            if (/^[a-zA-Z0-9+#._-]{1,20}$/.test(label)) {
                return label;
            }
        }

        return "";
    }

    /**
    把每个 CodeMirror 代码块整体换成 `<pre data-lang>`。
    codeTexts 是从**原始节点**读出的代码：CM6 的视图对象挂在节点属性上，
    cloneNode 不会复制它，所以在 clone 上读不到完整文档。
    整块替换可以顺带吞掉语言标签、复制按钮和光标层，
    它们本来就不属于回答内容。
    */
    function liftCodeMirrorBlocks(root, codeTexts) {
        if (!doc) {
            return;
        }

        const editors = Array.from(root.querySelectorAll(".cm-editor"));

        editors.forEach((editor, index) => {
            // 已经被前一个 editor 一起替换掉了
            if (!editor.parentElement) {
                return;
            }

            // 向上找到最外层的代码块容器（带 rounded-xl / language-* 的那层）
            let block = editor;
            let probe = editor;

            while (probe.parentElement && probe.parentElement !== root) {
                probe = probe.parentElement;

                if (/(^|\s)(rounded-xl|language-[\w+#.-]+)/.test(classOf(probe))) {
                    block = probe;
                }
            }

            const pre = doc.createElement("pre");
            const language = detectLanguage(block, editor);

            if (language) {
                pre.setAttribute("data-lang", language);
            }

            pre.textContent = codeTexts[index] || "";
            block.replaceWith(pre);
        });
    }

    // ------------------------------------------------------------
    // 正文渲染
    // ------------------------------------------------------------

    // 先在原始 DOM 上把代码读出来（视图对象只在原始节点上）
    const codeTexts = Array.from(element.querySelectorAll(".cm-editor")).map((editor) =>
        readCode(editor)
    );

    const clone = element.cloneNode(true);

    /**
    GLM 把下面这些"页面状态"也放在正文容器里，它们都不是回答内容：
    - `.thinking-chain-container` / `.thinking-block`：思考过程折叠块
    - `.toolCallTrace`：内置工具调用轨迹（"写入 1 次文件 / 写文件"）

    工具轨迹尤其危险：模型如果只调了工具、还没给出正文，
    整条消息的可读内容就只剩这几个字，会被误当成"回复已到"。
    所以整块移除，让上层继续等真正的正文。
    */
    clone
        .querySelectorAll(".thinking-chain-container, .thinking-block, .toolCallTrace")
        .forEach((node) => node.remove());

    liftCodeMirrorBlocks(clone, codeTexts);

    function render(node) {
        if (!node) {
            return "";
        }

        if (node.nodeType === TEXT_NODE) {
            return normalizeText(node.nodeValue);
        }

        if (node.nodeType !== ELEMENT_NODE) {
            return "";
        }

        const tag = node.tagName.toLowerCase();

        if (tag === "script" || tag === "style") {
            return "";
        }

        if (tag === "br") {
            return "\n";
        }

        if (tag === "pre") {
            // CodeMirror 已在上面归一化为 <pre data-lang>；.view-line 兼容旧结构。
            const viewLines = Array.from(node.querySelectorAll(".view-line")).map((line) =>
                normalizeText(line.textContent)
            );
            const code = viewLines.length
                ? viewLines.join("\n")
                : normalizeText(node.textContent).replace(/^\n+|\n+$/g, "");
            const language = (node.getAttribute("data-lang") || "").trim();

            return "```" + language + "\n" + code + "\n```\n";
        }

        const children = Array.from(node.childNodes).map(render).join("");

        if (tag === "h1" || tag === "h2" || tag === "h3") {
            return "\n" + "#".repeat(Number(tag.slice(1))) + " " + children.trim() + "\n";
        }

        if (tag === "strong" || tag === "b") {
            return "**" + children + "**";
        }

        if (tag === "em" || tag === "i") {
            return "*" + children + "*";
        }

        if (tag === "code") {
            return "`" + children + "`";
        }

        if (tag === "li") {
            // GLM 的 li 不带任何标记，直接拼文本会退化成普通段落，
            // 下游 markdown 渲染就丢掉列表结构，所以这里补回列表符号。
            const parent = node.parentElement;
            const parentTag = parent && parent.tagName ? parent.tagName.toLowerCase() : "";
            const siblings = parent && parent.children ? Array.from(parent.children) : [];
            const index = siblings.indexOf(node) + 1;
            const marker = parentTag === "ol" && index > 0 ? index + ". " : "- ";

            return marker + children.trim() + "\n";
        }

        if (tag === "p" || tag === "div") {
            return children + "\n";
        }

        return children;
    }

    return render(clone)
        .replace(/\n{4,}/g, "\n\n")
        .trim();
}

module.exports = {
    renderGlmMessage,
};
