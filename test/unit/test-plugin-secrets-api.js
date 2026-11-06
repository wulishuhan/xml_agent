/**
密钥管理 HTTP 接口测试

设计文档里 P5 长期标着"⚠️ secrets.json 仍需手工编辑"。补上接口后，这里钉住三条边界：

1. 值只进不出：GET 只回键名与长度，响应体里不能出现密钥内容；
2. 写入即落盘，且文件权限收紧（POSIX 下 0600）；
3. 非法键名 / 空值只能得到 400，不能写进文件。

存储根用 XML_AGENT_STORE_ROOT 指到临时目录，不会碰用户真实的 ~/.xml-agent。

运行：node test/unit/test-plugin-secrets-api.js
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-secrets-"));
process.env.XML_AGENT_STORE_ROOT = storeRoot;

const { app } = require("../../webui/server");

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
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const secretsFile = path.join(storeRoot, "secrets.json");

    const call = async (method, urlPath, body) => {
        const options = { method };
        if (body !== undefined) {
            options.headers = { "Content-Type": "application/json" };
            options.body = JSON.stringify(body);
        }
        const response = await fetch(base + urlPath, options);
        const text = await response.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (error) {
            json = null;
        }
        return { status: response.status, text, json };
    };

    await check("初始状态返回空清单", async () => {
        const result = await call("GET", "/api/plugins/secrets");
        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(result.json.secrets, []);
    });

    await check("写入密钥后只回键名与长度", async () => {
        const result = await call("PUT", "/api/plugins/secrets/API_KEY", {
            value: "super-secret-value",
        });
        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(result.json.secrets, [{ key: "API_KEY", length: 18 }]);
        assert.strictEqual(result.text.indexOf("super-secret-value"), -1, "响应体不能带值");
    });

    await check("密钥确实落盘", () => {
        const saved = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
        assert.strictEqual(saved.API_KEY, "super-secret-value");
    });

    await check("文件权限在 POSIX 下是 0600", () => {
        if (process.platform === "win32") {
            return;
        }
        const mode = fs.statSync(secretsFile).mode & 0o777;
        assert.strictEqual(mode, 0o600);
    });

    await check("重复写入覆盖旧值", async () => {
        const result = await call("PUT", "/api/plugins/secrets/API_KEY", { value: "rotated" });
        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(result.json.secrets, [{ key: "API_KEY", length: 7 }]);
        const saved = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
        assert.strictEqual(saved.API_KEY, "rotated");
    });

    await check("再读也拿不到值", async () => {
        const result = await call("GET", "/api/plugins/secrets");
        assert.strictEqual(result.json.secrets.length, 1);
        assert.strictEqual(result.text.indexOf("rotated"), -1);
    });

    await check("空值被拒绝", async () => {
        const result = await call("PUT", "/api/plugins/secrets/NEW_KEY", { value: "   " });
        assert.strictEqual(result.status, 400);
        assert.ok(result.json.error.indexOf("不能为空") !== -1);
    });

    await check("非法键名被拒绝", async () => {
        const result = await call("PUT", "/api/plugins/secrets/bad%2Fname", { value: "x" });
        assert.strictEqual(result.status, 400);
        assert.strictEqual(result.json.code, "SECRET_INVALID");
    });

    await check("删除返回 removed:true 并清空清单", async () => {
        const result = await call("DELETE", "/api/plugins/secrets/API_KEY");
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.json.removed, true);
        assert.deepStrictEqual(result.json.secrets, []);
    });

    await check("删除不存在的键返回 removed:false", async () => {
        const result = await call("DELETE", "/api/plugins/secrets/NOPE");
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.json.removed, false);
    });

    await new Promise((resolve) => server.close(resolve));

    console.log("\n" + pass + "/" + total + " passed");
    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
