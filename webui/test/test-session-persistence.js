const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const sessionStore = require("../session/session-store");
const { SessionManager } = require("../session/session-manager");
const { getWorkspaceStoreDir, saveHistory } = require("../../workspace/history");

function main() {
    // 1. store 根目录必须在用户主目录下，不能是 workspace 或项目目录
    assert.ok(
        sessionStore.STORE_ROOT.startsWith(os.homedir()),
        "session store must live under user home, got: " + sessionStore.STORE_ROOT
    );

    // 2. history / report 目录也不能在 workspace 里
    const fakeWorkspace = path.join(os.tmpdir(), "xml-agent-fake-workspace-" + Date.now());
    fs.mkdirSync(fakeWorkspace, { recursive: true });

    const storeDir = getWorkspaceStoreDir(fakeWorkspace);
    assert.ok(
        storeDir.startsWith(os.homedir()),
        "workspace store dir must live under user home, got: " + storeDir
    );
    assert.ok(
        !storeDir.startsWith(fakeWorkspace),
        "workspace store dir must NOT live inside workspace"
    );

    const historyPath = saveHistory(fakeWorkspace, [{ step: 1 }]);
    assert.ok(fs.existsSync(historyPath), "history.json should be written");
    assert.ok(
        !fs.existsSync(path.join(fakeWorkspace, ".agent")),
        "workspace must not contain .agent directory anymore"
    );

    // 3. SessionManager: create -> persist -> restore
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
    assert.ok(fs.existsSync(savedFile), "session file should exist after persist");

    const manager2 = new SessionManager();
    const restoredCount = manager2.restore();
    assert.ok(restoredCount >= 1, "should restore at least 1 session");

    const restored = manager2.get(savedId);
    assert.ok(restored, "restored session should be found by id");
    assert.strictEqual(restored.task, "persistence test");
    assert.strictEqual(restored.provider, "chatgpt");
    assert.strictEqual(restored.workspace, fakeWorkspace);
    assert.ok(
        restored.getOutput().some((o) => o.content === "hello persistence"),
        "restored session should keep output records"
    );
    assert.strictEqual(restored.isRunning(), false, "restored session must not be running");

    // 4. remove -> 磁盘文件也应删除
    manager2.remove(savedId);
    assert.ok(!fs.existsSync(savedFile), "session file should be removed from disk");

    // 清理 workspace 临时目录
    fs.rmSync(fakeWorkspace, { recursive: true, force: true });

    console.log("PASS: session persistence + storage location verified");
}

try {
    main();
} catch (error) {
    console.error("FAIL:", error.message);
    process.exitCode = 1;
}
