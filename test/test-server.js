const http = require("http");
const isBackground = process.argv.includes("--background");
const PORT = Number(process.env.TEST_SERVER_PORT || (isBackground ? 9999 : 0));
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("test");
});
server.listen(PORT, () => {
    const address = server.address();
    console.log("Test server running on port " + address.port);
    if (!isBackground) {
        server.close(() => process.exit(0));
    }
});
server.on("error", (error) => {
    console.error(error);
    process.exit(1);
});
