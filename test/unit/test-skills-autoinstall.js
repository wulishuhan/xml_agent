/**
 * 技能自动安装单测（skills.syncSkillsToWorkspace + Agent.collectSkills）
 *
 * 为什么单独一层：技能装好即用依赖两条容易各自跑偏的规则 ——
 * 1. read 被沙箱限制在工作区内，所以只有落进 `<workspace>/.agent/skills/` 的技能
 *    才有 workspacePath，才会出现在首轮提示词里；
 * 2. 同步必须幂等且不覆盖用户改过的工作区副本，否则"改完技能下次启动被冲掉"。
 *
 * 存储根用 XML_AGENT_STORE_ROOT 指到临时目录，不碰真实的 ~/.xml-agent。
 *
 * 运行：node test/unit/test-skills-autoinstall.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoinstall-store-"));
process.env.XML_AGENT_STORE_ROOT = storeRoot;
// v1.3.0 起 skills.autoInstall 默认关闭；本测试专门验证"开启后"的同步行为，
// 所以在任何 require 之前显式打开（agent-config 在模块加载时读取该环境变量）。
process.env.SKILLS_AUTO_INSTALL = "1";

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

function makeProject() {
    const root = tempDir("autoinstall-project-");
    writeFile(
        path.join(root, "skills", "novel-writing", "SKILL.md"),
        "# 男频网文写作\n\n## 何时使用\n\n写连载网文时按本文件执行。\n\n正文\n"
    );
    writeFile(path.join(root, "skills", "README.md"), "# Skills 索引\n");
    return root;
}

function makeUserSkill(store, name, content) {
    writeFile(path.join(store, "skills", name + ".md"), content);
}

function wsSkills(workspace) {
    return path.join(workspace, ".agent", "skills");
}

async function main() {
    const projectRoot = makeProject();
    const options = { projectRoot };
    makeUserSkill(
        storeRoot,
        "security-review",
        "# 安全审查\n\n## 何时使用\n\n做安全审查时。\n\n正文\n"
    );

    // ---- 1. 基本同步 ----
    const ws = tempDir("autoinstall-ws-");
    await check("同步把 builtin + user 技能复制进工作区", () => {
        const result = skills.syncSkillsToWorkspace(ws, options);
        assert.deepStrictEqual(result.installed.sort(), [
            "builtin:novel-writing",
            "user:security-review",
        ]);
        assert.strictEqual(result.updated.length, 0);
        const files = fs.readdirSync(wsSkills(ws)).sort();
        assert.deepStrictEqual(files, ["novel-writing.md", "security-review.md"]);
    });

    await check("同步后技能获得 workspacePath 并进首轮提示词", () => {
        const list = skills.listSkills(Object.assign({ workspace: ws }, options));
        const section = buildSkillPromptSection(list);
        assert.ok(section.indexOf("可用技能") !== -1);
        assert.ok(section.indexOf(".agent/skills/novel-writing.md") !== -1);
        const prompt = getFirstPrompt(ws, ["file.txt"], "写一本男频网文小说", { skills: list });
        assert.ok(prompt.indexOf("可用技能") !== -1, "首轮提示词必须含技能段");
        assert.ok(prompt.indexOf("novel-writing") !== -1, "首轮提示词必须列出该技能");
    });

    // ---- 2. 幂等 ----
    await check("重复同步不产生任何写入", () => {
        const before = fs.readFileSync(path.join(wsSkills(ws), "novel-writing.md"), "utf8");
        const result = skills.syncSkillsToWorkspace(ws, options);
        assert.strictEqual(result.installed.length, 0);
        assert.strictEqual(result.updated.length, 0);
        assert.ok(result.skipped.length >= 2);
        assert.strictEqual(
            fs.readFileSync(path.join(wsSkills(ws), "novel-writing.md"), "utf8"),
            before
        );
    });

    await check("默认不覆盖用户改过的工作区副本", () => {
        const mine = path.join(wsSkills(ws), "novel-writing.md");
        fs.writeFileSync(mine, "# 我改过的\n", "utf8");
        const result = skills.syncSkillsToWorkspace(ws, options);
        assert.strictEqual(result.updated.length, 0);
        assert.strictEqual(fs.readFileSync(mine, "utf8"), "# 我改过的\n");
    });

    await check("overwrite=true 才回写内置内容", () => {
        const mine = path.join(wsSkills(ws), "novel-writing.md");
        const result = skills.syncSkillsToWorkspace(
            ws,
            Object.assign({}, options, { overwrite: true })
        );
        assert.ok(result.updated.indexOf("builtin:novel-writing") !== -1);
        assert.notStrictEqual(fs.readFileSync(mine, "utf8"), "# 我改过的\n");
    });

    // ---- 3. sources 白名单 ----
    await check("sources 白名单只同步指定来源", () => {
        const scoped = tempDir("autoinstall-sources-");
        const result = skills.syncSkillsToWorkspace(
            scoped,
            Object.assign({}, options, { sources: ["builtin"] })
        );
        assert.deepStrictEqual(result.installed, ["builtin:novel-writing"]);
        const files = fs.readdirSync(wsSkills(scoped));
        assert.deepStrictEqual(files, ["novel-writing.md"]);
    });

    // ---- 4. disabled / shadowed ----
    await check("被禁用的技能不同步", () => {
        const disabledWs = tempDir("autoinstall-disabled-");
        skills.setSkillEnabled("user:security-review", false, options);
        const result = skills.syncSkillsToWorkspace(disabledWs, options);
        assert.strictEqual(
            result.installed.indexOf("user:security-review"),
            -1,
            JSON.stringify(result.installed)
        );
        assert.strictEqual(
            fs.existsSync(path.join(wsSkills(disabledWs), "security-review.md")),
            false
        );
        skills.setSkillEnabled("user:security-review", true, options);
    });

    await check("被工作区同名副本遮蔽的那份不重复同步", () => {
        const shadowWs = tempDir("autoinstall-shadow-");
        skills.syncSkillsToWorkspace(shadowWs, options);
        // 第二次跑：workspace 来源已存在，builtin/user 目标也存在 → 全部跳过
        const result = skills.syncSkillsToWorkspace(shadowWs, options);
        const workspaceIds = result.skipped.filter((id) => id.indexOf("workspace:") === 0);
        assert.ok(workspaceIds.length >= 2, JSON.stringify(result.skipped));
        const list = skills.listSkills(Object.assign({ workspace: shadowWs }, options));
        const writing = list.filter((item) => item.slug === "novel-writing");
        assert.strictEqual(writing.filter((item) => item.active).length, 1, "只能有一份生效");
        assert.strictEqual(writing.find((item) => !item.active).source, "builtin");
    });

    // ---- 5. 边界 ----
    await check("没有工作区时不做任何事", () => {
        assert.deepStrictEqual(skills.syncSkillsToWorkspace("", options), {
            installed: [],
            updated: [],
            skipped: [],
        });
        assert.deepStrictEqual(skills.syncSkillsToWorkspace(null, options), {
            installed: [],
            updated: [],
            skipped: [],
        });
    });

    await check("README 索引页不被当成技能同步", () => {
        const readmeWs = tempDir("autoinstall-readme-");
        const result = skills.syncSkillsToWorkspace(readmeWs, options);
        assert.strictEqual(
            result.installed
                .concat(result.updated, result.skipped)
                .some((id) => /readme/i.test(id)),
            false
        );
        assert.strictEqual(fs.existsSync(path.join(wsSkills(readmeWs), "README.md")), false);
    });

    // ---- 6. Agent.collectSkills 钩子 ----
    await check("Agent.collectSkills 自动安装并只上报一次变更", () => {
        const { Agent } = require("../../agent-core");
        const agentWs = tempDir("autoinstall-agent-");
        const agent = new Agent({ workspace: agentWs, task: "写一本男频网文小说" });
        const seen = [];
        agent.on("event", (event) => {
            if (String(event.type).indexOf("skills.") === 0) {
                seen.push(event.type);
            }
        });
        const list = agent.collectSkills(agentWs);
        assert.ok(seen.indexOf("skills.auto_installed") !== -1, JSON.stringify(seen));
        assert.ok(
            list.some((item) => item.slug === "novel-writing" && item.workspacePath),
            "同步后应存在可读的工作区副本"
        );
        // 第二次不该再报变更
        seen.length = 0;
        agent.collectSkills(agentWs);
        assert.strictEqual(seen.indexOf("skills.auto_installed"), -1, JSON.stringify(seen));
    });

    console.log("\nTotal: " + pass + "/" + total);
    if (pass !== total) {
        process.exitCode = 1;
    }
    fs.rmSync(storeRoot, { recursive: true, force: true });
}

main().catch((error) => {
    console.error("FATAL", error);
    process.exitCode = 2;
});
