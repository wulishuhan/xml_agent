const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const sessionStore = require("../session/session-store");
const { SessionManager } = require("../session/session-manager");
const { getWorkspaceStoreDir, saveHistory } = require("../../workspace/history");
function main() {
    assert.ok(
        sessionStore.STORE_ROOT.startsWith(os.homedir()),
        "session store must live under user home, got: " + sessionStore.STORE_ROOT
    );
    const fakeWorkspace = path.join(os.tmpdir(), "xml-agent-fake-workspace-" + Date.now());
    fs.mkdirSync(fakeWorkspace, { recursive: true });

    const storeDir = getWorkspaceStoreDir(fakeWorkspace);
    assert.ok(storeDir.startsWith(os.homedir()));
    assert.ok(!storeDir.startsWith(fakeWorkspace));

    const historyPath = saveHistory(fakeWorkspace, [{ step: 1 }]);
    assert.ok(fs.existsSync(historyPath));
    assert.ok(!fs.existsSync(path.join(fakeWorkspace, ".agent")));

    const manager = new SessionManager();

    const session = manager.create({
        workspace: fakeWorkspace,
        provider: "chatgpt",
        task: "persistence test",
    });

    session.addOutput("system", "hello persistence");
    manager.persist(session);

    const savedId = session.id;
    const savedFile = path.join(sessionStore.STORE_ROOT, savedId + ".json");
    assert.ok(fs.existsSync(savedFile));

    const manager2 = new SessionManager();
    const restoredCount = manager2.restore();
    assert.ok(restoredCount >= 1);

    const restored = manager2.get(savedId);
    assert.ok(restored);
    assert.strictEqual(restored.task, "persistence test");
    assert.strictEqual(restored.provider, "chatgpt");
    assert.strictEqual(restored.workspace, fakeWorkspace);
    assert.ok(restored.getOutput().some((o) => o.content === "hello persistence"));
    assert.strictEqual(restored.isRunning(), false);

    // 使用独立的 SessionManager 做删除回归测试，避免其它 Manager
    // 持有同一个 session 并在测试期间重新写入磁盘。
    const deleteManager = new SessionManager();
    const deleteSession = deleteManager.create({
        workspace: fakeWorkspace,
        provider: "chatgpt",
        task: "delete persistence regression test",
    });
    const deleteId = deleteSession.id;
    const deleteFile = path.join(sessionStore.STORE_ROOT, deleteId + ".json");

    assert.ok(fs.existsSync(deleteFile));
    deleteManager.remove(deleteId);
    assert.ok(!fs.existsSync(deleteFile));
    assert.strictEqual(deleteManager.get(deleteId), null);

    // 模拟删除后的异步事件：这些事件绝不能重新创建已删除的 session。
    deleteSession.addOutput("system", "late output after deletion");
    deleteSession.emit("conversation", {
        id: deleteSession.id,
        conversationId: "late-conversation-id",
    });
    deleteSession.emit("finished", deleteSession.getInfo());
    deleteSession.emit("session.error", new Error("late error"));

    assert.ok(!fs.existsSync(deleteFile), "deleted session must not be recreated by late events");

    // output 使用 500ms 节流，再等待一个完整节流窗口，
    // 确认不存在残留 timer 可以把 session 写回磁盘。
    setTimeout(() => {
        assert.ok(
            !fs.existsSync(deleteFile),
            "deleted session must remain absent after pending save window"
        );

        const manager3 = new SessionManager();
        manager3.restore();
        assert.strictEqual(
            manager3.get(deleteId),
            null,
            "deleted session must not reappear after manager restart"
        );

        manager2.remove(savedId);
        fs.rmSync(fakeWorkspace, { recursive: true, force: true });

        console.log("PASS: session persistence + storage location + delete persistence verified");
    }, 700);
}
try {
    main();
} catch (error) {
    console.error("FAIL:", error.message);
    process.exitCode = 1;
}
