/**
极简假 DOM：只实现 renderGlmMessage 用得到的那部分。

为什么不引 jsdom：
1. 项目离线测试不装浏览器/框架依赖；
2. 被测函数只需要 类选择器、文本节点、clone/replaceWith 这几样，
   真 DOM 的其它能力反而会掩盖"函数是否自包含"的问题。
*/

class FakeNode {
    constructor() {
        this.parentNode = null;
        this.childNodes = [];
    }

    get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }

    get textContent() {
        return this.childNodes.map((child) => child.textContent).join("");
    }

    // 真实 DOM 里给 textContent 赋值会替换全部子节点，这里保持一致，
    // 因为 renderGlmMessage 正是用它把代码写进 <pre>。
    set textContent(value) {
        this.childNodes = [];
        if (value !== "") {
            this.append(new FakeText(String(value)));
        }
    }

    cloneNode() {
        throw new Error("cloneNode must be implemented by subclass");
    }
}

class FakeText extends FakeNode {
    constructor(value) {
        super();
        this.nodeType = 3;
        this.nodeValue = value;
    }

    get textContent() {
        return this.nodeValue;
    }

    cloneNode() {
        return new FakeText(this.nodeValue);
    }
}

class FakeElement extends FakeNode {
    constructor(tagName, className) {
        super();
        this.nodeType = 1;
        this.tagName = String(tagName).toUpperCase();
        this.className = className || "";
        this.attributes = {};
        this.ownerDocument = null;
    }

    get children() {
        return this.childNodes.filter((child) => child.nodeType === 1);
    }

    get firstElementChild() {
        return this.children[0] || null;
    }

    append(...nodes) {
        for (const node of nodes) {
            node.parentNode = this;
            this.childNodes.push(node);
        }
        return this;
    }

    getAttribute(name) {
        if (name === "class") {
            return this.className || null;
        }
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
            ? this.attributes[name]
            : null;
    }

    setAttribute(name, value) {
        if (name === "class") {
            this.className = String(value);
            return;
        }
        this.attributes[name] = String(value);
    }

    /** 支持 ".a" 与 ".a, .b"；其它语法直接断言失败，避免测试里悄悄用不支持的写法。 */
    querySelectorAll(selector) {
        const groups = String(selector)
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        const wanted = groups.map((part) => {
            if (!part.startsWith(".")) {
                throw new Error("fake-dom 只支持类选择器，收到：" + part);
            }
            return part.slice(1);
        });

        const matched = [];
        walk(this, (node) => {
            const classes = String(node.className || "").split(/\s+/);
            if (wanted.some((name) => classes.indexOf(name) !== -1)) {
                matched.push(node);
            }
        });
        return matched;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    cloneNode(deep) {
        const copy = new FakeElement(this.tagName, this.className);
        copy.attributes = Object.assign({}, this.attributes);
        copy.ownerDocument = this.ownerDocument;
        if (deep) {
            for (const child of this.childNodes) {
                copy.append(child.cloneNode(true));
            }
        }
        return copy;
    }

    remove() {
        if (!this.parentNode) {
            return;
        }
        const siblings = this.parentNode.childNodes;
        const index = siblings.indexOf(this);
        if (index !== -1) {
            siblings.splice(index, 1);
        }
        this.parentNode = null;
    }

    replaceWith(node) {
        const parent = this.parentNode;
        if (!parent) {
            return;
        }
        const index = parent.childNodes.indexOf(this);
        parent.childNodes[index] = node;
        node.parentNode = parent;
        this.parentNode = null;
    }
}

function walk(node, visit) {
    for (const child of node.childNodes) {
        if (child.nodeType !== 1) {
            continue;
        }
        visit(child);
        walk(child, visit);
    }
}

/**
构造一棵假 DOM 树。
用法：build("<div class=a>", [子节点...])，元素写法为 "tag.class1.class2"。
*/
function build(spec, children) {
    const [tag, ...classes] = String(spec).split(".");
    const element = new FakeElement(tag, classes.join(" "));
    element.ownerDocument = DOCUMENT;
    for (const child of children || []) {
        element.append(child);
    }
    return element;
}

function text(value) {
    return new FakeText(value);
}

const DOCUMENT = {
    createElement(tagName) {
        const element = new FakeElement(tagName);
        element.ownerDocument = DOCUMENT;
        return element;
    },
};

module.exports = {
    FakeElement,
    FakeText,
    build,
    text,
    document: DOCUMENT,
};
