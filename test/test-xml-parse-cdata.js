const { extractXML, tryExtractWriteManually } = require("../parse/xml-parse");

const CHAR_LT = String.fromCharCode(60);
const CHAR_GT = String.fromCharCode(62);
const CHAR_SLASH = String.fromCharCode(47);
const CHAR_BANG = String.fromCharCode(33);
const CHAR_LBRACK = String.fromCharCode(91);
const CHAR_RBRACK = String.fromCharCode(93);

const WRITE_OPEN = CHAR_LT + "write";
const WRITE_CLOSE = CHAR_LT + CHAR_SLASH + "write" + CHAR_GT;
const CDATA_OPEN = CHAR_LT + CHAR_BANG + CHAR_LBRACK + "CDATA" + CHAR_LBRACK;
const CDATA_CLOSE = CHAR_RBRACK + CHAR_RBRACK + CHAR_GT;

let pass = 0;
let total = 0;

function check(name, cond, extra) {
    total++;
    if (cond) {
        console.log("PASS - " + name);
        pass++;
    } else {
        console.log("FAIL - " + name);
        if (extra) console.log(" extra:", extra);
    }
}

// Case 1: 简单 write，内容里没有 XML 示例
const simple =
    WRITE_OPEN + ' path="a.txt"' + CHAR_GT + CDATA_OPEN + "hello world" + CDATA_CLOSE + WRITE_CLOSE;

try {
    const action = extractXML(simple);
    check("simple write parsed", action.action === "write" && action.node["@_path"] === "a.txt");
    check(
        "simple write content",
        action.node["#text"] === "hello world",
        JSON.stringify(action.node["#text"])
    );
} catch (e) {
    check("simple write parsed", false, e.message);
}

// Case 2: write 内容里含其他 XML Action 示例（模拟 readme 场景）
const withExamples = [
    WRITE_OPEN + ' path="readme.md"' + CHAR_GT + CDATA_OPEN,
    "# 示例文档",
    "",
    "以下是各种 XML Action 用法：",
    "",
    CHAR_LT + 'read path="package.json"/' + CHAR_GT,
    "",
    WRITE_OPEN +
        ' path="src/test.js"' +
        CHAR_GT +
        CDATA_OPEN +
        'console.log("hi");' +
        CDATA_CLOSE +
        WRITE_CLOSE,
    "",
    CHAR_LT + 'exec command="npm test"/' + CHAR_GT,
    "",
    CHAR_LT + "answer" + CHAR_GT + "任务完成" + CHAR_LT + CHAR_SLASH + "answer" + CHAR_GT,
    "",
    CHAR_LT + CHAR_SLASH + "done" + CHAR_GT,
    CDATA_CLOSE + WRITE_CLOSE,
].join("\n");

try {
    const action = extractXML(withExamples);
    check(
        "write with XML examples parsed",
        action.action === "write" && action.node["@_path"] === "readme.md",
        JSON.stringify({ action: action.action, path: action.node["@_path"] })
    );
    check(
        "content preserved",
        action.node["#text"].indexOf("# 示例文档") !== -1 &&
            action.node["#text"].indexOf("exec command") !== -1,
        action.node["#text"].substring(0, 100)
    );
} catch (e) {
    check("write with XML examples parsed", false, e.message);
}

// Case 3: write 内容里含 CDATA 结束标记
const withNestedCdata = [
    WRITE_OPEN + ' path="doc.md"' + CHAR_GT + CDATA_OPEN,
    "# 文档",
    "",
    "示例：以下内容代表 CDATA 结束标记",
    "",
    CDATA_CLOSE,
    "",
    "后面还有内容",
    CDATA_CLOSE + WRITE_CLOSE,
].join("\n");

try {
    const action = extractXML(withNestedCdata);
    check(
        "write with nested CDATA close parsed",
        action.action === "write" && action.node["@_path"] === "doc.md",
        JSON.stringify({ action: action.action, path: action.node && action.node["@_path"] })
    );
} catch (e) {
    check("write with nested CDATA close parsed", false, e.message);
}

// Case 4: 正常的 read 自闭合标签仍然走原路径
const readSimple = CHAR_LT + 'read path="package.json"/' + CHAR_GT;
try {
    const action = extractXML(readSimple);
    check(
        "simple read parsed",
        action.action === "read" && action.node["@_path"] === "package.json"
    );
} catch (e) {
    check("simple read parsed", false, e.message);
}

// Case 5: 带 ```xml 包裹的 write
const fenced = [
    String.fromCharCode(96, 96, 96) + "xml",
    WRITE_OPEN +
        ' path="fenced.md"' +
        CHAR_GT +
        CDATA_OPEN +
        "content here" +
        CDATA_CLOSE +
        WRITE_CLOSE,
    String.fromCharCode(96, 96, 96),
].join("\n");

try {
    const action = extractXML(fenced);
    check(
        "fenced write parsed",
        action.action === "write" && action.node["@_path"] === "fenced.md"
    );
} catch (e) {
    check("fenced write parsed", false, e.message);
}

// Case 6: tryExtractWriteManually 直接调用
const manual = tryExtractWriteManually(
    WRITE_OPEN + ' path="m.txt"' + CHAR_GT + CDATA_OPEN + "abc" + CDATA_CLOSE + WRITE_CLOSE
);
check(
    "tryExtractWriteManually direct",
    manual && manual.action === "write" && manual.node["@_path"] === "m.txt",
    JSON.stringify(manual)
);

// Case 7: 空 write 内容（手动提取拒绝）
const emptyWrite = WRITE_OPEN + ' path="e.txt"' + CHAR_GT + CDATA_OPEN + CDATA_CLOSE + WRITE_CLOSE;
try {
    extractXML(emptyWrite);
    check("empty write rejected", false, "should have thrown");
} catch (e) {
    check("empty write rejected", true);
}

console.log("");
console.log("Result: " + pass + "/" + total + " tests passed");
process.exit(pass === total ? 0 : 1);
