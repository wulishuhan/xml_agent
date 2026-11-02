/**
迁移等价性自查（一次性：对比 HEAD 版 runtime.js 与 actions/*.js 的关键字面量）。
不是常驻测试，只是这次重构的机械比对工具。

用法：
    git show HEAD:runtime.js | Set-Content -Encoding UTF8 "$env:TEMP\head-runtime.js"
    node test/check-migration-equivalence.js "$env:TEMP\head-runtime.js"
*/
const fs = require("fs");
const path = require("path");

const LITERALS = [
    "Workspace path is required",
    "Workspace does not exist: ",
    "Workspace is not a directory: ",
    "Path is required",
    "Unsafe absolute path",
    "Absolute paths are not allowed in workspace mode",
    "Path escapes workspace",
    "read requires path",
    "File or directory does not exist",
    "File too large to read. Size: ",
    "write requires path",
    "File too large",
    "Content validation failed: ",
    "Invalid JSON content: ",
    "exec requires command",
    "Background process started with PID: ",
    "Running as background process: ",
    "Capturing screenshot:",
    "Capturing ",
    "Screenshot failed:",
    "screenshot failed",
    "answer content cannot be empty",
];

const baselinePath = process.argv[2];
if (!baselinePath || !fs.existsSync(baselinePath)) {
    console.error("请先导出基线：git show HEAD:runtime.js | Set-Content -Encoding UTF8 <file>");
    process.exit(1);
}
const source = fs.readFileSync(baselinePath, "utf8");

const projectRoot = path.join(__dirname, "..");
const targets = [path.join(projectRoot, "runtime.js")].concat(
    fs
        .readdirSync(path.join(projectRoot, "actions"))
        .filter((name) => name.endsWith(".js"))
        .map((name) => path.join(projectRoot, "actions", name))
);

const combined = targets.map((file) => fs.readFileSync(file, "utf8")).join("\n");

const missingInSource = [];
const missingInNew = [];
for (const literal of LITERALS) {
    if (source.indexOf(literal) === -1) {
        missingInSource.push(literal);
    }
    if (combined.indexOf(literal) === -1) {
        missingInNew.push(literal);
    }
}

console.log("对比基线 HEAD:runtime.js 中的字面量：" + LITERALS.length + " 条");
console.log("新代码缺失：" + (missingInNew.length ? missingInNew.join(" | ") : "无"));
console.log(
    "基线里不存在（说明是我新加的，属正常）：" +
        (missingInSource.length ? missingInSource.join(" | ") : "无")
);
console.log(missingInNew.length === 0 ? "EQ_OK" : "EQ_MISSING");
