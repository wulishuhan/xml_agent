/**
Vue SFC 编译校验（不需要 Vite / esbuild，可在受限环境里跑）

用途：本机沙箱禁止子进程时无法执行 `npm run webui:build`，
这里用 @vue/compiler-sfc 直接编译单文件组件，至少保证模板/脚本/样式语法正确。

用法：node test/check-vue-sfc.js [文件...]
默认校验仓库内的全部 .vue 组件。
*/

const fs = require("fs");
const path = require("path");

let compiler;
try {
    compiler = require("@vue/compiler-sfc");
} catch (error) {
    console.error("@vue/compiler-sfc 不可用：" + error.message);
    process.exit(1);
}

const root = path.join(__dirname, "..");
const componentsDir = path.join(root, "webui", "frontend", "src");

function collectVueFiles(dir, acc) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectVueFiles(full, acc);
        } else if (entry.name.endsWith(".vue")) {
            acc.push(full);
        }
    }
    return acc;
}

const targets = process.argv.slice(2).length
    ? process.argv.slice(2).map((item) => path.resolve(item))
    : collectVueFiles(componentsDir, []);

let failed = 0;

for (const file of targets) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(root, file).split(path.sep).join("/");
    const problems = [];

    const { descriptor, errors } = compiler.parse(source, { filename: file });
    for (const error of errors) {
        problems.push("parse: " + (error.message || error));
    }

    try {
        if (descriptor.script || descriptor.scriptSetup) {
            compiler.compileScript(descriptor, { id: "sfc-check" });
        }
    } catch (error) {
        problems.push("script: " + error.message);
    }

    if (descriptor.template) {
        try {
            const result = compiler.compileTemplate({
                id: "sfc-check",
                filename: file,
                source: descriptor.template.content,
                scoped: true,
            });
            for (const error of result.errors || []) {
                problems.push("template: " + (error.message || error));
            }
        } catch (error) {
            problems.push("template: " + error.message);
        }
    }

    for (const style of descriptor.styles) {
        try {
            const result = compiler.compileStyle({
                id: "sfc-check",
                filename: file,
                source: style.content,
                scoped: style.scoped,
            });
            for (const error of result.errors || []) {
                problems.push("style: " + (error.message || error));
            }
        } catch (error) {
            problems.push("style: " + error.message);
        }
    }

    if (problems.length) {
        failed += 1;
        console.log("FAIL - " + relative);
        for (const problem of problems) {
            console.log("    " + problem);
        }
    } else {
        console.log("PASS - " + relative);
    }
}

console.log("");
console.log("Total: " + (targets.length - failed) + "/" + targets.length);
process.exit(failed === 0 ? 0 : 1);
