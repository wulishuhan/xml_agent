
const { buildWorkspaceManifest } = require("../workspace/manifest");

const manifest = buildWorkspaceManifest("D:/code/backend/nodejs/xml_agent");

console.log("============================================================");
console.log("Workspace Manifest - 递归扫描完整项目结构");
console.log("============================================================");
console.log("扫描结果：");
console.log("");

for (const entry of manifest) {
console.log(entry);
}

console.log("");
console.log("\u603b\u8ba1 " + manifest.length + " \u4e2a\u6761\u76ee");
