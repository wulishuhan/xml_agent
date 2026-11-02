/**
XML 节点取文本（叶子模块，不依赖任何项目内模块）

fast-xml-parser 在 CDATA / 纯文本两种写法下给出的结构不同：
- <answer><![CDATA[hi]]></answer> → { "#text": "hi" }
- <answer>hi</answer>            → "hi"
这里统一成字符串。

下沉为叶子模块是为了让 actions/ 与 parse/xml-parse.js 都能直接使用而不形成循环依赖。
*/

function getText(node) {
    if (node === undefined || node === null) return "";
    if (typeof node === "string") return node;
    if (typeof node === "number" || typeof node === "boolean") {
        return String(node);
    }
    if (typeof node === "object" && node["#text"] !== undefined) {
        return String(node["#text"]);
    }
    return "";
}

module.exports = {
    getText,
};
