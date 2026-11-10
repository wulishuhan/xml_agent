/**
技能（Skill）系统测试

技能 = 工作区里的 Markdown 指令文档，模型按需 read 进来照着做。
这一层最容易出问题的地方不是"读文件"，而是四条边界，这里逐条钉住：

1. 三来源优先级：workspace > user > builtin，同名只保留一份，被压住的记进 shadowed；
2. read 是工作区沙箱内的动作，所以只有落在工作区里的技能才有 workspacePath，
   提示词只列这类 —— 否则模型会去读一个必然被拒绝的路径；
3. 启用/禁用只影响提示词，不动文件；状态落 `<storeRoot>/skills.json`；
4. 安装/删除只能落在 `<workspace>/.agent/skills/` 下，builtin/user 不可删。

存储根用 XML_AGENT_STORE_ROOT 指到临时目录，不会碰用户真实的 ~/.xml-agent。

运行：node test/unit/test-skills.js
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-store-"));
process.env.XML_AGENT_STORE_ROOT = storeRoot;

const skills = require("../../skills");
const { buildSkillPromptSection } = require("../../prompts/skill-prompt");
const { getFirstPrompt } = require("../../prompts/first-prompt");

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

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(target, content) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
}

function makeProjectRoot() {
    const root = tempDir("skill-project-");
    writeFile(
        path.join(root, "skills", "novel-writing", "SKILL.md"),
        "# 男频网文写作\n\n## 何时使用\n\n写连载网文时按本文件执行。\n\n---\n\n正文\n"
    );
    // 一个不与工作区重名的内置技能，用来验证"读不到就没有 workspacePath"
    writeFile(
        path.join(root, "skills", "refactor", "SKILL.md"),
        "# 重构规范\n\n## 何时使用\n\n改代码结构时按本文件执行。\n\n---\n\n正文\n"
    );
    // 目录根部的 README 是索引页，不该被当成技能
    writeFile(path.join(root, "skills", "README.md"), "# Skills\n\n索引页\n");
    return root;
}

function makeWorkspace(prefix, name, content) {
    const workspace = tempDir(prefix || "skill-workspace-");
    if (name) {
        writeFile(path.join(workspace, ".agent", "skills", name + ".md"), content);
    }
    return workspace;
}

async function main() {
    const projectRoot = makeProjectRoot();
    const options = { projectRoot: projectRoot, storeRoot: storeRoot };

    // ---- 扫描与优先级 ----
    const userSkillsDir = path.join(storeRoot, "skills");
    writeFile(
        path.join(userSkillsDir, "novel-writing.md"),
        "---\nname: 网文（用户版）\ndescription: 用户自己改的版本\n---\n\n# 网文\n\n用户正文\n"
    );

    const workspace = makeWorkspace(
        "skill-ws-",
        "novel-writing",
        "# 网文（工作区版）\n\n工作区正文\n"
    );

    await check("同名技能三份都可见，只有最高优先级那份 active", () => {
        const list = skills.listSkills(Object.assign({ workspace: workspace }, options));
        const novel = list.filter((item) => item.slug === "novel-writing");
        assert.strictEqual(novel.length, 3, "builtin / user / workspace 各一份");
        const active = novel.filter((item) => item.active);
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0].id, "workspace:novel-writing");
        const inactive = novel.filter((item) => !item.active);
        assert.deepStrictEqual(
            inactive.map((item) => item.shadowedBy),
            ["workspace", "workspace"]
        );
    });

    await check("没有工作区时只扫 builtin + user", () => {
        const list = skills.listSkills(options);
        const sources = Array.from(new Set(list.map((item) => item.source))).sort();
        assert.deepStrictEqual(sources, ["builtin", "user"]);
        assert.ok(list.some((item) => item.id === "user:novel-writing"));
        assert.ok(list.some((item) => item.id === "builtin:refactor"));
    });

    await check("builtin 的 skills/README.md 不会被当成技能", () => {
        const list = skills.listSkills(options);
        assert.ok(!list.some((item) => item.slug.toLowerCase() === "readme"));
    });

    await check("workspacePath 只在技能落在工作区内时非空", () => {
        const list = skills.listSkills(Object.assign({ workspace: workspace }, options));
        const builtin = list.find((item) => item.id === "builtin:refactor");
        const scoped = list.find((item) => item.id === "workspace:novel-writing");
        assert.strictEqual(builtin.workspacePath, null, "内置技能在工作区外，模型读不到");
        assert.ok(scoped.workspacePath.indexOf(".agent/skills/") === 0);
    });

    await check("平铺 <name>.md 与 <name>/SKILL.md 两种布局都能识别", () => {
        const custom = tempDir("skill-layout-");
        writeFile(path.join(custom, "skills", "flat.md"), "# 平铺技能\n\n正文\n");
        writeFile(path.join(custom, "skills", "nested", "SKILL.md"), "# 嵌套技能\n\n正文\n");
        // storeRoot 单独给一个空目录，避免用户级技能混进来影响计数
        const list = skills.listSkills({
            projectRoot: custom,
            storeRoot: tempDir("skill-store-empty-"),
        });
        const slugs = list.map((item) => item.slug).sort();
        assert.deepStrictEqual(slugs, ["flat", "nested"]);
    });

    // ---- 读取 ----
    await check("readSkill 返回全文与 front matter", () => {
        const doc = skills.readSkill("user:novel-writing", options);
        assert.strictEqual(doc.name, "网文（用户版）");
        assert.strictEqual(doc.frontMatter.description, "用户自己改的版本");
        assert.ok(doc.body.indexOf("用户正文") !== -1);
    });

    await check("readSkill 无 front matter 时从标题与“何时使用”取元信息", () => {
        const doc = skills.readSkill("builtin:refactor", options);
        assert.strictEqual(doc.name, "重构规范");
        assert.ok(doc.description.indexOf("改代码结构时按本文件执行") === 0);
        assert.strictEqual(doc.truncated, false);
    });

    await check("非法 id 报 SKILL_INVALID_ID（路径穿越在这里就断掉）", () => {
        const cases = ["", "novel-writing", "evil:novel", "builtin:../../etc/passwd", "builtin:"];
        cases.forEach((id) => {
            assert.throws(
                () => skills.readSkill(id, options),
                (error) => error.code === "SKILL_INVALID_ID",
                "应拒绝: " + JSON.stringify(id)
            );
        });
    });

    await check("不存在的 id 报 SKILL_NOT_FOUND", () => {
        assert.throws(
            () => skills.readSkill("builtin:not-there", options),
            (error) => error.code === "SKILL_NOT_FOUND"
        );
    });

    // ---- 安装 ----
    await check("installSkill 把技能复制进工作区 .agent/skills", () => {
        const target = makeWorkspace("skill-install-");
        const result = skills.installSkill("builtin:refactor", target, options);
        assert.strictEqual(result.installed, true);
        assert.strictEqual(result.overwritten, false);
        assert.strictEqual(result.workspacePath, ".agent/skills/refactor.md");
        assert.ok(fs.existsSync(result.path));
    });

    await check("重复安装标记 overwritten 且内容同步", () => {
        const target = makeWorkspace("skill-reinstall-");
        skills.installSkill("builtin:refactor", target, options);
        const again = skills.installSkill("builtin:refactor", target, options);
        assert.strictEqual(again.overwritten, true);
        const content = fs.readFileSync(again.path, "utf8");
        assert.ok(content.indexOf("重构规范") !== -1);
    });

    await check("安装到不存在的工作区报 WORKSPACE_NOT_FOUND", () => {
        assert.throws(
            () => skills.installSkill("builtin:refactor", path.join(storeRoot, "nope"), options),
            (error) => error.code === "WORKSPACE_NOT_FOUND"
        );
    });

    await check("已在工作区里的技能再安装不会自我复制", () => {
        const target = makeWorkspace("skill-self-", "refactor", "# 工作区版\n\n正文\n");
        const result = skills.installSkill("workspace:refactor", target, options);
        assert.strictEqual(result.alreadyInstalled, true);
        assert.strictEqual(result.installed, false);
    });

    // ---- 启用/禁用 ----
    await check("禁用写入 skills.json 并反映在列表里", () => {
        skills.setSkillEnabled("builtin:refactor", false, options);
        const registry = JSON.parse(fs.readFileSync(path.join(storeRoot, "skills.json"), "utf8"));
        assert.deepStrictEqual(registry.disabled, ["builtin:refactor"]);
        const list = skills.listSkills(options);
        assert.strictEqual(list.find((item) => item.id === "builtin:refactor").enabled, false);
        skills.setSkillEnabled("builtin:refactor", true, options);
        const after = skills.listSkills(options);
        assert.strictEqual(after.find((item) => item.id === "builtin:refactor").enabled, true);
    });

    await check("skills.json 坏掉时按全部启用处理，不隐藏技能", () => {
        const registryFile = path.join(storeRoot, "skills.json");
        fs.writeFileSync(registryFile, "{ 这不是 JSON", "utf8");
        const list = skills.listSkills(options);
        assert.ok(list.length > 0);
        assert.ok(list.every((item) => item.enabled));
        fs.writeFileSync(registryFile, '{"disabled": []}\n', "utf8");
    });

    // ---- 删除 ----
    await check("removeSkill 只删工作区里的副本", () => {
        const target = makeWorkspace("skill-remove-");
        const installed = skills.installSkill("builtin:refactor", target, options);
        const result = skills.removeSkill("workspace:refactor", target, options);
        assert.strictEqual(result.removed, true);
        assert.strictEqual(fs.existsSync(installed.path), false);
    });

    await check("builtin 技能不允许删除", () => {
        const target = makeWorkspace("skill-remove2-");
        assert.throws(
            () => skills.removeSkill("builtin:refactor", target, options),
            (error) => error.code === "SKILL_NOT_REMOVABLE"
        );
    });

    // ---- 编辑 ----
    await check("writeSkill 改写工作区副本，builtin 原文不动", () => {
        const target = makeWorkspace("skill-write-");
        const installed = skills.installSkill("builtin:refactor", target, options);
        const builtinFile = path.join(projectRoot, "skills", "refactor", "SKILL.md");
        const before = fs.readFileSync(builtinFile, "utf8");
        const next = "# 重构规范（改）\n\n## 何时使用\n\n只在我点头时改。\n";
        const result = skills.writeSkill(
            "workspace:refactor",
            next,
            Object.assign({ workspace: target }, options)
        );
        assert.strictEqual(result.path, installed.path);
        assert.strictEqual(fs.readFileSync(installed.path, "utf8"), next);
        assert.strictEqual(fs.readFileSync(builtinFile, "utf8"), before, "内置那一份必须保持原样");
        const detail = skills.readSkill(
            "workspace:refactor",
            Object.assign({ workspace: target }, options)
        );
        assert.ok(detail.content.indexOf("只在我点头时改") !== -1);
        assert.strictEqual(detail.size, Buffer.byteLength(next, "utf8"));
    });

    await check("writeSkill 拒绝改 builtin（只读）", () => {
        assert.throws(
            () => skills.writeSkill("builtin:refactor", "# 改\n", options),
            (error) => error.code === "SKILL_READONLY"
        );
    });

    await check("writeSkill 可以改 user 层技能", () => {
        const next = "---\nname: 用户版\n---\n\n改过了\n";
        const result = skills.writeSkill("user:novel-writing", next, options);
        assert.strictEqual(fs.readFileSync(result.path, "utf8"), next);
        assert.ok(
            result.path.indexOf(path.join(storeRoot, "skills")) === 0,
            "必须写回 user 层自己的目录"
        );
    });

    await check("writeSkill 超过大小上限报 SKILL_TOO_LARGE", () => {
        const target = makeWorkspace("skill-big-", "big", "# big\n");
        assert.throws(
            () =>
                skills.writeSkill(
                    "workspace:big",
                    "x".repeat(skills.MAX_SKILL_BYTES + 1),
                    Object.assign({ workspace: target }, options)
                ),
            (error) => error.code === "SKILL_TOO_LARGE"
        );
    });

    await check("writeSkill 拒绝非字符串内容", () => {
        for (const bad of [null, undefined, 42, ["a"], { text: "a" }]) {
            assert.throws(
                () => skills.writeSkill("builtin:refactor", bad, options),
                (error) => error.code === "SKILL_INVALID_CONTENT",
                "应拒绝: " + JSON.stringify(bad)
            );
        }
    });

    await check("editable 只对 builtin 为 false", () => {
        const list = skills.listSkills(Object.assign({ workspace: workspace }, options));
        assert.strictEqual(list.find((item) => item.id === "builtin:refactor").editable, false);
        assert.strictEqual(
            list.find((item) => item.id === "workspace:novel-writing").editable,
            true
        );
        assert.strictEqual(list.find((item) => item.id === "user:novel-writing").editable, true);
    });

    // ---- 提示词 ----
    await check("提示词只列可读且启用的技能", () => {
        const list = skills.listSkills(Object.assign({ workspace: workspace }, options));
        const section = buildSkillPromptSection(list);
        assert.ok(section.indexOf("可用技能") !== -1);
        assert.ok(section.indexOf(".agent/skills/novel-writing.md") !== -1);
        // builtin / user 的绝对路径不该出现：模型读不到
        const workspaceFree = skills.listSkills({ workspace: null }, options);
        assert.strictEqual(buildSkillPromptSection(workspaceFree), "");
    });

    await check("禁用的技能不进提示词", () => {
        const scoped = skills.listSkills(Object.assign({ workspace: workspace }, options));
        const disabled = scoped.map((item) =>
            Object.assign({}, item, { enabled: item.id !== "workspace:novel-writing" })
        );
        assert.strictEqual(buildSkillPromptSection(disabled), "");
    });

    await check("没有技能时首轮提示词与旧版一致（不含技能段落）", () => {
        const prompt = getFirstPrompt(workspace, ["file.txt"], "做点事", { skills: [] });
        assert.strictEqual(prompt.indexOf("可用技能"), -1);
    });

    await check("有技能时首轮提示词带路径，且仍保留原有段落", () => {
        const list = skills.listSkills(Object.assign({ workspace: workspace }, options));
        const prompt = getFirstPrompt(workspace, ["file.txt"], "做点事", { skills: list });
        assert.ok(prompt.indexOf("可用技能") !== -1);
        assert.ok(prompt.indexOf(".agent/skills/novel-writing.md") !== -1);
        assert.ok(prompt.indexOf("Workspace Manifest") !== -1);
        assert.ok(prompt.indexOf("用户任务") !== -1);
    });

    // ---- HTTP 接口 ----
    // 上面验证了 user 覆盖 builtin；这里要验证"builtin 不可删除"，先撤掉那层遮蔽，
    // 让 builtin:novel-writing 重新可见（真实目录里的内置技能）。
    fs.rmSync(path.join(userSkillsDir, "novel-writing.md"), { force: true });

    const { app } = require("../../webui/server");
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const httpWorkspace = makeWorkspace(
        "skill-http-",
        "demo",
        "# 演示技能\n\n## 何时使用\n\n演示用\n"
    );

    const call = async (method, urlPath, body) => {
        const request = { method: method };
        if (body !== undefined) {
            request.headers = { "Content-Type": "application/json" };
            request.body = JSON.stringify(body);
        }
        const response = await fetch(base + urlPath, request);
        const text = await response.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (error) {
            json = null;
        }
        return { status: response.status, text: text, json: json };
    };

    const encoded = (id) => encodeURIComponent(id);

    await check("GET /api/skills 返回工作区技能与可读路径", async () => {
        const result = await call(
            "GET",
            "/api/skills?workspace=" + encodeURIComponent(httpWorkspace)
        );
        assert.strictEqual(result.status, 200);
        const demo = (result.json.skills || []).find((item) => item.id === "workspace:demo");
        assert.ok(demo, "应包含 workspace:demo");
        assert.strictEqual(demo.workspacePath, ".agent/skills/demo.md");
        assert.strictEqual(demo.installed, true);
    });

    await check("GET /api/skills/:id 返回完整文档", async () => {
        const result = await call(
            "GET",
            "/api/skills/" +
                encoded("workspace:demo") +
                "?workspace=" +
                encodeURIComponent(httpWorkspace)
        );
        assert.strictEqual(result.status, 200);
        assert.ok(result.json.content.indexOf("演示技能") !== -1);
        assert.strictEqual(result.json.source, "workspace");
    });

    await check("GET /api/skills/:id 对不存在与非法 id 分别回 404/400", async () => {
        const missing = await call("GET", "/api/skills/" + encoded("workspace:none"));
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(missing.json.code, "SKILL_NOT_FOUND");
        const invalid = await call("GET", "/api/skills/not-an-id");
        assert.strictEqual(invalid.status, 400);
        assert.strictEqual(invalid.json.code, "SKILL_INVALID_ID");
    });

    await check("POST /api/skills/:id/enabled 落盘并回显状态", async () => {
        const result = await call("POST", "/api/skills/" + encoded("workspace:demo") + "/enabled", {
            enabled: false,
            workspace: httpWorkspace,
        });
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.json.enabled, false);
        const list = await call(
            "GET",
            "/api/skills?workspace=" + encodeURIComponent(httpWorkspace)
        );
        assert.strictEqual(
            list.json.skills.find((item) => item.id === "workspace:demo").enabled,
            false
        );
        await call("POST", "/api/skills/" + encoded("workspace:demo") + "/enabled", {
            enabled: true,
            workspace: httpWorkspace,
        });
    });

    await check("POST /api/skills/:id/install 把内置技能装进工作区", async () => {
        const target = makeWorkspace("skill-http-install-");
        const result = await call("POST", "/api/skills/builtin%3Anovel-writing/install", {
            workspace: target,
        });
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.json.installed, true);
        assert.ok(fs.existsSync(path.join(target, ".agent", "skills", "novel-writing.md")));
    });

    await check("POST /api/skills/:id/install 缺 workspace 回 400", async () => {
        const result = await call("POST", "/api/skills/builtin%3Anovel-writing/install", {});
        assert.strictEqual(result.status, 400);
        assert.strictEqual(result.json.code, "WORKSPACE_REQUIRED");
    });

    await check("PUT /api/skills/:id 保存文档并落盘", async () => {
        const next = "# 演示技能\n\n## 何时使用\n\n改过的版本\n";
        const result = await call("PUT", "/api/skills/" + encoded("workspace:demo"), {
            content: next,
            workspace: httpWorkspace,
        });
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.json.message, "Skill updated");
        assert.strictEqual(
            fs.readFileSync(path.join(httpWorkspace, ".agent", "skills", "demo.md"), "utf8"),
            next
        );
        const detail = await call(
            "GET",
            "/api/skills/" +
                encoded("workspace:demo") +
                "?workspace=" +
                encodeURIComponent(httpWorkspace)
        );
        assert.strictEqual(detail.json.size, Buffer.byteLength(next, "utf8"));
        assert.ok(detail.json.content.indexOf("改过的版本") !== -1);
    });

    await check("PUT /api/skills/:id 对 builtin 回 403，非字符串回 400", async () => {
        const readonly = await call("PUT", "/api/skills/" + encoded("builtin:novel-writing"), {
            content: "# 改\n",
            workspace: httpWorkspace,
        });
        assert.strictEqual(readonly.status, 403);
        assert.strictEqual(readonly.json.code, "SKILL_READONLY");

        const bad = await call("PUT", "/api/skills/" + encoded("workspace:demo"), {
            content: 123,
            workspace: httpWorkspace,
        });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.json.code, "SKILL_INVALID_CONTENT");
    });

    await check("DELETE /api/skills/:id 删除工作区副本，builtin 拒绝", async () => {
        const removed = await call(
            "DELETE",
            "/api/skills/" +
                encoded("workspace:demo") +
                "?workspace=" +
                encodeURIComponent(httpWorkspace)
        );
        assert.strictEqual(removed.status, 200);
        assert.strictEqual(removed.json.removed, true);
        assert.strictEqual(
            fs.existsSync(path.join(httpWorkspace, ".agent", "skills", "demo.md")),
            false
        );

        const builtin = await call(
            "DELETE",
            "/api/skills/" +
                encoded("builtin:novel-writing") +
                "?workspace=" +
                encodeURIComponent(httpWorkspace)
        );
        assert.strictEqual(builtin.status, 400);
        assert.strictEqual(builtin.json.code, "SKILL_NOT_REMOVABLE");
    });

    await new Promise((resolve) => server.close(resolve));
    console.log("\nTotal: " + pass + "/" + total);
    if (pass !== total) {
        process.exitCode = 1;
    }
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
}

main().catch((error) => {
    console.error("FATAL", error);
    process.exitCode = 2;
});
