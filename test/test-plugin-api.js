/**
插件 HTTP API 测试：启动内置服务，验证 /api/plugins 与 /api/permissions。
存储根目录指向临时目录，避免污染用户真实的 ~/.xml-agent。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-plugin-api-"));
process.env.XML_AGENT_STORE_ROOT = storeRoot;
process.env.PORT = String(34000 + Math.floor(Math.random() * 2000));

const projectRoot = path.join(__dirname, "..");
const server = require(path.join(projectRoot, "webui", "server.js"));

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function request(method, url, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request(
            url,
            {
                method,
                headers: payload
                    ? {
                          "content-type": "application/json",
                          "content-length": Buffer.byteLength(payload),
                      }
                    : {},
            },
            (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    text += chunk;
                });
                res.on("end", () => {
                    let data = null;
                    try {
                        data = JSON.parse(text);
                    } catch (error) {
                        data = text;
                    }
                    resolve({ statusCode: res.statusCode, data });
                });
            }
        );
        req.on("error", reject);
        req.setTimeout(8000, () => req.destroy(new Error("timeout")));
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

async function main() {
    const instance = server.startServer();
    await new Promise((resolve, reject) => {
        if (instance.listening) {
            resolve();
        } else {
            instance.once("listening", resolve);
            instance.once("error", reject);
        }
    });
    const base = "http://127.0.0.1:" + instance.address().port;

    const list = await request("GET", base + "/api/plugins");
    check("GET /api/plugins 返回 200", list.statusCode === 200, String(list.statusCode));
    check("插件系统处于启用状态", list.data.enabled === true);
    const fetchPlugin = (list.data.plugins || []).filter((item) => item.name === "fetch")[0];
    check(
        "fetch 插件出现在列表中且已加载",
        Boolean(fetchPlugin) && fetchPlugin.status === "loaded",
        fetchPlugin ? fetchPlugin.status : "missing"
    );
    check(
        "列表带动作与有效权限",
        Boolean(fetchPlugin) &&
            fetchPlugin.actions.indexOf("fetch") !== -1 &&
            fetchPlugin.effectivePermissions.length > 0
    );

    const ui = await request("GET", base + "/api/plugins/ui");
    check(
        "GET /api/plugins/ui 返回声明式 UI 结构",
        ui.statusCode === 200 &&
            Array.isArray(ui.data.panels) &&
            Array.isArray(ui.data.settings) &&
            Array.isArray(ui.data.actions),
        String(ui.statusCode)
    );
    const auditPanel = (ui.data.panels || []).filter((item) => item.plugin === "audit-log")[0];
    check(
        "内置 audit-log 声明了可渲染的面板",
        Boolean(auditPanel) &&
            auditPanel.basePath === "/api/plugins/audit-log/api" &&
            Array.isArray(auditPanel.blocks) &&
            auditPanel.blocks.length > 0,
        auditPanel ? auditPanel.blocks.map((block) => block.kind).join(",") : "missing"
    );

    const pluginApi = await request("GET", base + "/api/plugins/audit-log/api/summary");
    check(
        "插件自定义接口可访问",
        pluginApi.statusCode === 200 &&
            typeof pluginApi.data.total === "number" &&
            Array.isArray(pluginApi.data.recent),
        JSON.stringify(Object.keys(pluginApi.data || {}))
    );
    const pluginApiMissing = await request("GET", base + "/api/plugins/audit-log/api/nope");
    check(
        "插件未注册的路径返回 404",
        pluginApiMissing.statusCode === 404,
        String(pluginApiMissing.statusCode)
    );
    const noApiPlugin = await request("GET", base + "/api/plugins/fetch/api/summary");
    check(
        "没有注册接口的插件返回 404",
        noApiPlugin.statusCode === 404,
        String(noApiPlugin.statusCode)
    );

    const configGet = await request("GET", base + "/api/plugins/fetch/config");
    check(
        "默认配置带 allowHosts 与 schema",
        configGet.statusCode === 200 &&
            Array.isArray(configGet.data.config.allowHosts) &&
            Boolean(configGet.data.schema.allowHosts),
        JSON.stringify(configGet.data.config)
    );

    const configPost = await request("POST", base + "/api/plugins/fetch/config", {
        config: { allowHosts: ["127.0.0.1"], httpMaxBytes: 2048 },
    });
    check(
        "POST 配置保存成功",
        configPost.statusCode === 200 &&
            configPost.data.config.allowHosts.length === 1 &&
            configPost.data.config.httpMaxBytes === 2048,
        JSON.stringify(configPost.data.config)
    );

    const badConfig = await request("POST", base + "/api/plugins/fetch/config", {
        config: { httpMaxBytes: "not-a-number" },
    });
    check(
        "非法配置返回 400",
        badConfig.statusCode === 400 && String(badConfig.data.error || "").includes("配置"),
        String(badConfig.statusCode)
    );

    const providers = await request("GET", base + "/api/providers");
    const providerList = (providers.data && providers.data.providers) || [];
    check(
        "GET /api/providers 返回 200 与全部内置 provider",
        providers.statusCode === 200 &&
            providerList.length >= 4 &&
            providerList.every((item) => item.id && item.defaultTargetUrl),
        providerList.map((item) => item.id).join(",")
    );
    check(
        "provider 列表带会话 id 正则（GLM 同时支持 /c/ 与 /s/）",
        providerList.some(
            (item) => item.id === "glm" && String(item.conversationIdPattern).indexOf("c|s") !== -1
        )
    );
    check(
        "provider 列表给出默认 provider（与前端下拉首项一致）",
        providers.data && providers.data.defaultId === providerList[0].id,
        String(providers.data && providers.data.defaultId)
    );

    const permissions = await request("GET", base + "/api/permissions");
    check(
        "GET /api/permissions 返回 scope 列表",
        permissions.statusCode === 200 && permissions.data.scopes.length >= 7,
        String(permissions.data.scopes.length)
    );

    const grant = await request("POST", base + "/api/permissions/grant", {
        scope: "network:http",
        policy: "deny",
    });
    check(
        "授权接口可写入 deny 策略",
        grant.statusCode === 200 && grant.data.permissions.policy["network:http"] === "deny",
        JSON.stringify(grant.data.permissions.policy["network:http"])
    );

    const afterGrant = await request("GET", base + "/api/plugins");
    const deniedFetch = (afterGrant.data.plugins || []).filter((item) => item.name === "fetch")[0];
    check(
        "deny 后 fetch 的有效权限变为 deny",
        Boolean(deniedFetch) &&
            deniedFetch.effectivePermissions.some(
                (item) => item.scope === "network:http" && item.policy === "deny"
            )
    );

    const badGrant = await request("POST", base + "/api/permissions/grant", {
        scope: "unknown:scope",
        policy: "allow",
    });
    check("未知 scope 返回 400", badGrant.statusCode === 400, String(badGrant.statusCode));

    const reload = await request("POST", base + "/api/plugins/reload");
    check(
        "reload 返回 200 且插件仍加载",
        reload.statusCode === 200 &&
            (reload.data.plugins || []).some(
                (item) => item.name === "fetch" && item.status === "loaded"
            )
    );

    const missing = await request("POST", base + "/api/plugins/nope/enabled", { enabled: false });
    check("未知插件返回 404", missing.statusCode === 404, String(missing.statusCode));

    // 前端产物检查：确认 Plugins 面板真的被打进 bundle（改了组件却忘记 build 会在这里暴露）
    const distIndex = path.join(projectRoot, "webui", "frontend", "dist", "index.html");
    if (!fs.existsSync(distIndex)) {
        console.log("SKIP - 前端未构建，跳过打包产物检查（先执行 npm run webui:build）");
    } else {
        const page = await request("GET", base + "/xml_agent_web");
        const html = typeof page.data === "string" ? page.data : "";
        check(
            "GET /xml_agent_web 返回前端入口",
            page.statusCode === 200 && html.indexOf("assets/index-") !== -1,
            String(page.statusCode)
        );
        const match = html.match(/assets\/(index-[^"]+\.js)/);
        if (match) {
            const bundle = await request("GET", base + "/assets/" + match[1]);
            const bundleText = typeof bundle.data === "string" ? bundle.data : "";
            check(
                "打包产物包含 Plugins 面板",
                bundleText.indexOf("Plugin system is disabled") !== -1,
                match[1]
            );
        } else {
            check("打包产物包含 Plugins 面板", false, "index.html 未引用 bundle");
        }
    }

    await server.shutdown();
}

main()
    .catch(async (error) => {
        console.error("Plugin API test failed:", error && error.message ? error.message : error);
        try {
            await server.shutdown();
        } catch (shutdownError) {
            // ignore
        }
        process.exitCode = 1;
    })
    .finally(() => {
        try {
            fs.rmSync(storeRoot, { recursive: true, force: true });
        } catch (error) {
            // ignore
        }
        console.log("");
        console.log("Total: " + pass + "/" + total);
        if (pass !== total) {
            process.exitCode = 1;
        }
    });
