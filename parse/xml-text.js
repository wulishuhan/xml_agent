/**
XML 节点取文本（叶子模块，不依赖任何项目内模块）

fast-xml-parser 在 CDATA / 纯文本两种写法下给出的结构不同：
- <answer><![CDATA[hi]]></answer> → { "#text": "hi" }
- <answer>hi</answer>            → "hi"
这里统一成字符串。
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

/** 解码 XML 实体（属性值与纯文本用；CDATA 是字面文本，不解码）。 */
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

/** CDATA 写法开头常带一个换行（<![CDATA[\n...]]），剥掉它以免写进文件。 */
function stripCdataLeadingNewline(text) {
    return String(text || "").replace(/^\r?\n/, "");
}

module.exports = {
    getText,
    decodeXmlEntities,
    stripCdataLeadingNewline,
};
