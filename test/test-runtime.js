const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, setWorkspace, getWorkspace } = require("../runtime");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-runtime-"));
fs.writeFileSync(path.join(workspace, "package.json"), '{"name":"runtime-fixture"}\n', "utf8");
fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
fs.writeFileSync(path.join(workspace, "config", "sample.json"), '{"enabled":true}\n', "utf8");
setWorkspace(workspace);

let pass = 0;
let total = 0;

async function check(name, fn) {
    total += 1;
    try {
        await fn();
        pass += 1;
        console.log("PASS - " + name);
    } catch (error) {
        console.log("FAIL - " + name + "  [" + error.message + "]");
    }
}

async function main() {
    console.log("============================================================");
    console.log("Runtime Module Test");
    console.log("============================================================");
    console.log("Workspace:", getWorkspace());
    console.log("");

    await check("read 读取 JSON 动作参数指定的文件", async () => {
        const result = await run({ action: "read", params: { path: "package.json" } });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.type, "file");
        assert.strictEqual(JSON.parse(result.content).name, "runtime-fixture");
    });

    await check("read 读取目录并返回 entries", async () => {
        const result = await run({ action: "read", params: { path: "config" } });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.type, "directory");
        assert.deepStrictEqual(result.entries, ["sample.json"]);
    });

    await check("write 按 params.content 逐字写入并自动创建目录", async () => {
        const content = "Runtime test content\r\nwith trailing spaces  \n";
        const result = await run({
            action: "write",
            params: { path: "workspace/test-runtime-output.txt", content },
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.path, "workspace/test-runtime-output.txt");
        assert.strictEqual(result.size, Buffer.byteLength(content, "utf8"));
        assert.strictEqual(
            fs.readFileSync(path.join(workspace, "workspace", "test-runtime-output.txt"), "utf8"),
            content
        );
    });

    await check("read 验证写入内容与 CRLF 均未变化", async () => {
        const result = await run({
            action: "read",
            params: { path: "workspace/test-runtime-output.txt" },
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.content, "Runtime test content\r\nwith trailing spaces  \n");
    });

    await check("exec 使用 params.command 执行命令", async () => {
        const result = await run({ action: "exec", params: { command: "node --version" } });
        assert.strictEqual(result.ok, true, result.error);
        assert.match(result.output, /^v\d+\./);
    });

    await check("Runtime.run 拒绝缺少 params 的旧节点结构", async () => {
        await assert.rejects(
            () => run({ action: "read", node: {} }),
            /Action params must be an object/
        );
    });

    console.log("");
    console.log("Total: " + pass + "/" + total);
}

main()
    .catch((error) => {
        console.error("Test run failed:", error.message);
        process.exitCode = 1;
    })
    .finally(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        if (pass !== total) {
            process.exitCode = 1;
        }
    });
