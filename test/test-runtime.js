
const path = require("path");
const fs = require("fs");
const { run, setWorkspace, getWorkspace } = require("../runtime");

// 设置 workspace 为当前项目根目录
const workspaceRoot = path.resolve(__dirname, "..");
setWorkspace(workspaceRoot);

console.log("============================================================");
console.log("Runtime Module Test");
console.log("============================================================");
console.log("");
console.log("Workspace:", getWorkspace());
console.log("");

// 测试1: 读取文件
console.log("--- Test 1: read file ---");
const readResult = run({
action: "read",
node: { "@_path": "package.json" }
});
console.log("Read result:", readResult.ok ? "SUCCESS" : "FAILED");
if (readResult.ok) {
console.log(" File size:", readResult.size, "bytes");
console.log(" Content preview:", readResult.content.substring(0, 100) + "...");
}
console.log("");

// 测试2: 读取目录
console.log("--- Test 2: read directory ---");
const readDirResult = run({
action: "read",
node: { "@_path": "config" }
});
console.log("Read directory result:", readDirResult.ok ? "SUCCESS" : "FAILED");
if (readDirResult.ok) {
console.log(" Entries:", readDirResult.entries.join(", "));
}
console.log("");

// 测试3: 写入文件 - 修正调用方式，content 作为第二个参数
console.log("--- Test 3: write file ---");
const testFilePath = "workspace/test-runtime-output.txt";
const testContent = "Runtime test content written at " + new Date().toISOString();
const writeResult = run({
action: "write",
node: { "@_path": testFilePath,'#text': testContent }
});

console.log("Write result:", writeResult.ok ? "SUCCESS" : "FAILED");
if (writeResult.ok) {
console.log(" Written to:", testFilePath);
console.log(" Size:", writeResult.size, "bytes");
}
console.log("");

// 测试4: 验证写入的文件
console.log("--- Test 4: verify written file ---");
const verifyResult = run({
action: "read",
node: { "@_path": testFilePath }
});
console.log("Verify result:", verifyResult.ok ? "SUCCESS" : "FAILED");
if (verifyResult.ok) {
console.log(" Content:", verifyResult.content);
}
console.log("");

// 测试5: 执行简单命令
console.log("--- Test 5: exec command ---");
const execResult = run({
action: "exec",
node: { "@_command": "node --version" }
});
console.log("Exec result:", execResult.ok ? "SUCCESS" : "FAILED");
if (execResult.ok) {
console.log(" Output:", execResult.output.trim());
}
console.log("");

console.log("All tests completed.");
