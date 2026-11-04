/**
Gemini 助手消息的 DOM → Markdown 重建。

与 GLM 的 `renderGlmMessage` 同一定位：这个函数会被序列化送进页面执行
（`message.evaluate(renderGeminiMessage)`），所以必须**自包含** —— 不能 require 模块，
也不能引用文件级变量（正则、常量都要在函数体内）。

Gemini 网页版的正文结构比较规整，但有三类"不是回答内容"的东西混在同一个容器里：

1. `<model-thoughts>` 思考过程面板（Gemini 3 的 thinking），正文为空时它可能先出现；
2. 代码块右上角的语言标签 + 复制按钮（`.code-block-decoration`）；
3. Google 搜索引用角标（`<source-footnote>`）与消息操作栏（`.response-footer`）。

这些如果不过滤，取回复时会拿到"正在思考"之类的噪声，或者把按钮文案当成正文。
所以先 prune 掉整块，再做 Markdown 重建；语言标签在 prune 时保留（只丢弃其内部按钮），
因为 `<pre>` 那一层要靠它判断代码语言。
*/
function renderGeminiMessage(element) {
    // 页面里有全局 Node，Node.js 单测里没有，所以写字面量
    const TEXT_NODE = 3;
    const ELEMENT_NODE = 1;

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

    function tagOf(node) {
        return node && node.tagName ? String(node.tagName).toLowerCase() : "";
    }

    function normalizeText(value) {
        return String(value || "").replace(/\u00a0/g, " ");
    }

    // ------------------------------------------------------------
    // 剪除"不是回答内容"的整块
    // ------------------------------------------------------------

    const DROP_TAGS = [
        "script",
        "style",
        "noscript",
        "button",
        "svg",
        "path",
        "mat-icon",
        "mat-progress-spinner",
        "source-footnote",
        "sources-list",
        "copy-button",
        "response-footer",
        "message-actions",
        "user-query",
    ];

    const DROP_CLASS = new RegExp(
        "(^|\\s)(model-thoughts|thoughts|thinking|response-footer|sources-list|source-footnote|avatar|loading|visually-hidden|cdk-visually-hidden|response-container-footer)(\\s|$)"
    );

    const COPY_LABEL = new RegExp("^(复制|复制代码|copy|copy code|download|下载)", "i");

    function shouldDrop(node) {
        if (DROP_TAGS.indexOf(tagOf(node)) !== -1) {
            return true;
        }

        const cls = classOf(node);

        if (cls && DROP_CLASS.test(" " + cls + " ")) {
            return true;
        }

        const aria = node.getAttribute ? node.getAttribute("aria-label") || "" : "";

        return Boolean(aria && COPY_LABEL.test(String(aria).trim()));
    }

    function prune(root) {
        const stack = Array.from(root.childNodes || []);

        while (stack.length) {
            const node = stack.pop();

            if (!node || node.nodeType !== ELEMENT_NODE) {
                continue;
            }

            if (shouldDrop(node)) {
                if (typeof node.remove === "function") {
                    node.remove();
                }
                continue;
            }

            for (const child of Array.from(node.childNodes || [])) {
                stack.push(child);
            }
        }
    }

    // ------------------------------------------------------------
    // 查找与语言识别
    // ------------------------------------------------------------

    function findByClass(root, className) {
        const stack = Array.from(root.childNodes || []);

        while (stack.length) {
            const node = stack.pop();

            if (!node || node.nodeType !== ELEMENT_NODE) {
                continue;
            }

            if (classOf(node).split(/\s+/).indexOf(className) !== -1) {
                return node;
            }

            for (const child of Array.from(node.childNodes || [])) {
                stack.push(child);
            }
        }

        return null;
    }

    function findFirstByTag(root, tagName) {
        const stack = Array.from(root.childNodes || []);

        while (stack.length) {
            const node = stack.pop();

            if (!node || node.nodeType !== ELEMENT_NODE) {
                continue;
            }

            if (tagOf(node) === tagName) {
                return node;
            }

            for (const child of Array.from(node.childNodes || [])) {
                stack.push(child);
            }
        }

        return null;
    }

    /**
    语言来源按可靠性排序：
    1. `<code class="... language-python">` —— 最稳定；
    2. `<pre class="... language-xxx">`；
    3. 代码块顶部的语言标签（`.code-block-decoration`，按钮已被 prune 掉，只剩语言名）。
    只有短标识符才当语言，避免结构变化时把正文误判成语言。
    */
    function detectLanguage(pre, codeNode) {
        const candidates = [classOf(codeNode), classOf(pre)];

        for (const cls of candidates) {
            const matched = String(cls).match(/language-([a-zA-Z0-9+#._-]+)/);

            if (matched) {
                return matched[1];
            }
        }

        // 语言标签在 `<pre>` 的兄弟分支里（code-block > [decoration, content > pre]），
        // 所以要向上找到整个代码块容器再找它，不能只看 pre 的直接父级。
        let block = pre.parentElement;

        while (block && classOf(block).split(/\s+/).indexOf("code-block") === -1) {
            block = block.parentElement;
        }

        const decoration = block ? findByClass(block, "code-block-decoration") : null;

        if (decoration) {
            const label = normalizeText(decoration.textContent).trim();

            if (/^[a-zA-Z0-9+#._-]{1,20}$/.test(label)) {
                return label.toLowerCase();
            }
        }

        return "";
    }

    // ------------------------------------------------------------
    // 表格 → Markdown 管道表
    // ------------------------------------------------------------

    /**
    行序必须与文档顺序一致（thead 在前、tbody 在后）。
    这里用递归而不是栈：栈是 LIFO，会把表头和表体顺序倒过来。
    */
    function collectRows(table) {
        const rows = [];

        function visit(node) {
            for (const child of Array.from(node.childNodes || [])) {
                if (!child || child.nodeType !== ELEMENT_NODE) {
                    continue;
                }

                if (tagOf(child) === "tr") {
                    rows.push(child);
                    continue;
                }

                visit(child);
            }
        }

        visit(table);

        return rows;
    }

    function renderTable(table) {
        const rows = collectRows(table);

        if (!rows.length) {
            return "";
        }

        const lines = rows.map((row) => {
            const cells = Array.from(row.childNodes || [])
                .filter((cell) => cell.nodeType === ELEMENT_NODE)
                .filter((cell) => tagOf(cell) === "td" || tagOf(cell) === "th")
                .map((cell) => render(cell).replace(/\s+/g, " ").trim());

            return "| " + cells.join(" | ") + " |";
        });

        const columns = Math.max(lines[0].split("|").length - 2, 1);
        const separator = "| " + new Array(columns).fill("---").join(" | ") + " |";

        return "\n" + [lines[0], separator].concat(lines.slice(1)).join("\n") + "\n";
    }

    // ------------------------------------------------------------
    // 正文渲染
    // ------------------------------------------------------------

    function renderChildren(node) {
        return Array.from(node.childNodes || [])
            .map(render)
            .join("");
    }

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

        const tag = tagOf(node);

        if (tag === "br") {
            return "\n";
        }

        if (tag === "pre") {
            const codeNode = findFirstByTag(node, "code") || node;
            const code = normalizeText(codeNode.textContent).replace(/^\n+|\n+$/g, "");
            const language = detectLanguage(node, codeNode);

            return "\n```" + language + "\n" + code + "\n```\n";
        }

        if (tag === "table") {
            return renderTable(node);
        }

        // 语言标签块只用于识别语言，本身不进正文
        if (classOf(node).split(/\s+/).indexOf("code-block-decoration") !== -1) {
            return "";
        }

        if (/^h[1-6]$/.test(tag)) {
            const heading = renderChildren(node).replace(/\s+/g, " ").trim();

            return "\n" + "#".repeat(Number(tag.slice(1))) + " " + heading + "\n";
        }

        if (tag === "strong" || tag === "b") {
            return "**" + renderChildren(node) + "**";
        }

        if (tag === "em" || tag === "i") {
            return "*" + renderChildren(node) + "*";
        }

        if (tag === "code") {
            return "`" + renderChildren(node) + "`";
        }

        if (tag === "li") {
            // 列表符号必须补回来：只拼文本会退化成普通段落，下游 markdown 就丢了结构
            const parent = node.parentElement;
            const parentTag = tagOf(parent);
            const siblings = parent
                ? Array.from(parent.childNodes).filter(
                      (child) => child.nodeType === ELEMENT_NODE && tagOf(child) === "li"
                  )
                : [];
            const index = siblings.indexOf(node) + 1;
            const marker = parentTag === "ol" ? Math.max(index, 1) + ". " : "- ";

            return marker + renderChildren(node).trim() + "\n";
        }

        const children = renderChildren(node);

        if (
            tag === "p" ||
            tag === "div" ||
            tag === "section" ||
            tag === "message-content" ||
            tag === "code-block"
        ) {
            return children + "\n";
        }

        return children;
    }

    const clone = element.cloneNode(true);

    prune(clone);

    return render(clone)
        .replace(/\n{4,}/g, "\n\n")
        .trim();
}

module.exports = {
    renderGeminiMessage,
};
