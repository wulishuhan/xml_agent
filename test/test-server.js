/**
测试用常驻 HTTP 服务器

端口优先级：--port=N > 环境变量 TEST_SERVER_PORT > 后台模式默认 9999 > 随机端口。
注意：exec 动作会把命令末尾的 ` --background` 当作自己的旗标剥掉，
脚本收不到它。所以需要固定端口时用 --port=N（跨平台，无需 shell 语法）。
*/
const http = require("http");

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const explicitPort = portArg ? Number(portArg.slice("--port=".length)) : null;
const isBackground = process.argv.includes("--background");
const PORT = explicitPort || Number(process.env.TEST_SERVER_PORT) || (isBackground ? 9999 : 0);
// 指定了端口就说明调用方要它能访问，因此保持常驻
const stayAlive = isBackground || explicitPort !== null;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("test");
});
server.listen(PORT, () => {
    const address = server.address();
    console.log("Test server running on port " + address.port);
    if (!stayAlive) {
        server.close(() => process.exit(0));
    }
});
server.on("error", (error) => {
    console.error(error);
    process.exit(1);
});
