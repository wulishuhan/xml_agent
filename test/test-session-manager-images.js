const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
// 回归测试：SessionManager.create 必须把 images 透传给 AgentSession，
// 否则前端选了图也到不了 Agent（表现为"界面有图片列表但模型没收到图"）。
const { SessionManager } = require("../webui/session/session-manager");
function run() {
    const manager = new SessionManager();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-sm-images-"));
    fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });
    const img1 = path.join(workspace, "uploads", "a.png");
    const img2 = path.join(workspace, "uploads", "b.png");
    fs.writeFileSync(img1, Buffer.from("x"));
    fs.writeFileSync(img2, Buffer.from("y"));
    let pass = 0;
    let total = 0;
    function check(name, ok, detail) {
        total += 1;
        if (ok) pass += 1;
        console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
    }
    try {
        // 1. 带 images 创建
        const session = manager.create({
            workspace: workspace,
            provider: "deepseek",
            task: "test",
            images: ["uploads/a.png", "uploads/b.png"],
        });
        check(
            "session.images 已透传",
            Array.isArray(session.images) && session.images.length === 2,
            JSON.stringify(session.images)
        );
        check(
            "getInfo().images 已透传",
            Array.isArray(session.getInfo().images) && session.getInfo().images.length === 2,
            JSON.stringify(session.getInfo().images)
        );
        // 2. 不带 images 创建
        const session2 = manager.create({
            workspace: workspace,
            provider: "deepseek",
            task: "test2",
        });
        check(
            "未传 images 时为空数组",
            Array.isArray(session2.images) && session2.images.length === 0
        );
        // 3. resume 时更新 images
        const beforeResume = session.images.length;
        session.resume("resume task", ["uploads/a.png"]);
        check(
            "resume 后 images 被更新",
            session.images.length === 1 && session.images[0] === "uploads/a.png",
            beforeResume + " -> " + JSON.stringify(session.images)
        );
        // 4. AgentSession 构造时 images 是复制而非共享引用
        const source = ["uploads/a.png"];
        const session3 = manager.create({
            workspace: workspace,
            provider: "deepseek",
            task: "test3",
            images: source,
        });
        source.push("uploads/b.png");
        check(
            "images 是拷贝而非共享引用",
            session3.images.length === 1,
            JSON.stringify(session3.images)
        );
    } finally {
        try {
            fs.rmSync(workspace, { recursive: true, force: true });
        } catch (e) {
            // ignore
        }
    }
    console.log("");
    console.log("Total: " + pass + "/" + total);
    process.exit(pass === total ? 0 : 1);
}
run();
