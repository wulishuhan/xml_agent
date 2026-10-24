
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
// 最小 PNG（1x1 透明像素），用于真实 multipart 上传测试。
const PNG_BASE64 =
"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
function buildMultipart(fields, files) {
const boundary = "----xmlagenttest" + Date.now();
const parts = [];
for (const field of fields) {
parts.push(
"--" +
boundary +
"\r\n" +
'Content-Disposition: form-data; name="' +
field.name +
'"\r\n\r\n' +
field.value +
"\r\n"
);
}
for (const file of files) {
parts.push(
"--" +
boundary +
"\r\n" +
'Content-Disposition: form-data; name="' +
file.field +
'"; filename="' +
file.name +
'"\r\n' +
"Content-Type: " +
(file.type || "application/octet-stream") +
"\r\n\r\n"
);
parts.push(file.buffer);
parts.push("\r\n");
}
parts.push("--" + boundary + "--\r\n");
const buffers = parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8")));
return {
boundary: boundary,
body: Buffer.concat(buffers),
};
}
function postMultipart(port, pathName, boundary, body) {
return new Promise((resolve, reject) => {
const req = http.request(
{
host: "127.0.0.1",
port: port,
path: pathName,
method: "POST",
headers: {
"Content-Type": "multipart/form-data; boundary=" + boundary,
"Content-Length": body.length,
},
},
(res) => {
let data = "";
res.on("data", (chunk) => {
data += chunk.toString();
});
res.on("end", () => {
let parsed = null;
try {
parsed = JSON.parse(data);
} catch (error) {
parsed = { raw: data };
}
resolve({ status: res.statusCode, body: parsed });
});
}
);
req.on("error", reject);
req.write(body);
req.end();
});
}
async function run() {
const { startServer, shutdown } = require("../webui/server");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-upload-"));
const port = 4611;
startServer({ port: port });
await new Promise((resolve) => setTimeout(resolve, 800));
let pass = 0;
let total = 0;
function check(name, ok, detail) {
total += 1;
if (ok) pass += 1;
console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}
try {
// 1. 正常上传一张 PNG
const pngBuffer = Buffer.from(PNG_BASE64, "base64");
const multipart = buildMultipart([], [
{ field: "images", name: "shot.png", type: "image/png", buffer: pngBuffer },
]);
const okRes = await postMultipart(
port,
"/api/uploads?workspace=" + encodeURIComponent(workspace),
multipart.boundary,
multipart.body
);
check("上传返回 200", okRes.status === 200, JSON.stringify(okRes.body));
check("上传 ok=true", okRes.body.ok === true);
check("上传 count=1", okRes.body.count === 1);
check(
"返回相对路径在 uploads/ 下",
Array.isArray(okRes.body.paths) &&
okRes.body.paths.length === 1 &&
okRes.body.paths[0].indexOf("uploads/") === 0,
JSON.stringify(okRes.body.paths)
);
const uploadedAbsolute = path.join(workspace, okRes.body.paths[0]);
check("文件真实落盘", fs.existsSync(uploadedAbsolute));
check(
"文件内容一致",
fs.existsSync(uploadedAbsolute) &&
fs.statSync(uploadedAbsolute).size === pngBuffer.length
);
// 2. 多张图片一次上传
const multi = buildMultipart([], [
{ field: "images", name: "a.png", type: "image/png", buffer: pngBuffer },
{ field: "images", name: "b.png", type: "image/png", buffer: pngBuffer },
]);
const multiRes = await postMultipart(
port,
"/api/uploads?workspace=" + encodeURIComponent(workspace),
multi.boundary,
multi.body
);
check("多图 count=2", multiRes.body.ok === true && multiRes.body.count === 2);
check(
"多图返回两个路径",
Array.isArray(multiRes.body.paths) && multiRes.body.paths.length === 2
);
// 3. 缺 workspace 参数应 400
const noWs = buildMultipart([], [
{ field: "images", name: "c.png", type: "image/png", buffer: pngBuffer },
]);
const noWsRes = await postMultipart(port, "/api/uploads", noWs.boundary, noWs.body);
check("缺 workspace 返回 400", noWsRes.status === 400, JSON.stringify(noWsRes.body));
// 4. workspace 不存在应 400
const badWs = buildMultipart([], [
{ field: "images", name: "d.png", type: "image/png", buffer: pngBuffer },
]);
const badWsRes = await postMultipart(
port,
"/api/uploads?workspace=" + encodeURIComponent(path.join(workspace, "nope")),
badWs.boundary,
badWs.body
);
check("workspace 不存在返回 400", badWsRes.status === 400, JSON.stringify(badWsRes.body));
// 5. 非法扩展名应 400
const badExt = buildMultipart([], [
{ field: "images", name: "evil.exe", type: "application/octet-stream", buffer: pngBuffer },
]);
const badExtRes = await postMultipart(
port,
"/api/uploads?workspace=" + encodeURIComponent(workspace),
badExt.boundary,
badExt.body
);
check("非法扩展名返回 400", badExtRes.status === 400, JSON.stringify(badExtRes.body));
// 6. 没有文件应 400
const empty = buildMultipart([], []);
const emptyRes = await postMultipart(
port,
"/api/uploads?workspace=" + encodeURIComponent(workspace),
empty.boundary,
empty.body
);
check("无文件返回 400", emptyRes.status === 400, JSON.stringify(emptyRes.body));
// 7. 文件名中的非法字符被清洗（不产生路径穿越）
const traversal = buildMultipart([], [
{
field: "images",
name: "../../evil.png",
type: "image/png",
buffer: pngBuffer,
},
]);
const traversalRes = await postMultipart(
port,
"/api/uploads?workspace=" + encodeURIComponent(workspace),
traversal.boundary,
traversal.body
);
check(
"文件名被清洗且落在 uploads/ 内",
traversalRes.status === 200 &&
traversalRes.body.ok === true &&
traversalRes.body.paths[0].indexOf("uploads/") === 0 &&
traversalRes.body.paths[0].indexOf("..") === -1,
JSON.stringify(traversalRes.body.paths)
);
} finally {
await shutdown();
try {
fs.rmSync(workspace, { recursive: true, force: true });
} catch (error) {
// ignore
}
}
console.log("");
console.log("Total: " + pass + "/" + total);
process.exit(pass === total ? 0 : 1);
}
run().catch((error) => {
console.error("UPLOAD API TEST FAILED:", error && error.stack ? error.stack : error);
process.exit(1);
});
