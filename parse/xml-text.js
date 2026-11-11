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

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
解码 XML 实体（属性值与纯文本都用它）。

快速解析器读到的是原始文本：`path="a&amp;b.txt"` 会原样当成文件名，
而通用解析路径（fast-xml-parser）会解码成 `a&b.txt`。
两条路径给出不同的文件名，就会出现"刚写进去的文件读不到"，
所以手写解析器必须自己解一次，规则与 XML 一致。

CDATA 里的内容不解码 —— 那是字面文本，`&amp;` 就该是 `&amp;`。
*/
function decodeXmlEntities(value) {
    return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
        if (body.charAt(0) === "#") {
            const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
            const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
                return match;
            }
            try {
                return String.fromCodePoint(code);
            } catch (error) {
                return match;
            }
        }
        const key = body.toLowerCase();
        return Object.prototype.hasOwnProperty.call(XML_ENTITIES, key) ? XML_ENTITIES[key] : match;
    });
}

module.exports = {
    getText,
    decodeXmlEntities,
};
