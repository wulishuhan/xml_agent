/**
 * 排队状态恢复归一单测
 *
 * 覆盖：持久化里的 queued 状态在进程重启后归一为 created，排队位置清空；
 *       运行期 queued 会话的 getInfo() 暴露 queued/queuePosition。
 *
 * 运行：node webui/test/test-session-restore-queued.js
 */

const { AgentSession } = require("../session/agent-session");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

async function main() {
    const restored = new AgentSession({ workspace: "D:/tmp/xml-agent-test-ws", task: "t" });
    restored.status = "queued";
    restored.queuePosition = 3;
    restored.restore({ status: "queued", queuePosition: 3 });
    check("恢复后状态归一为 created", restored.status === "created", restored.status);
    check("恢复后排队位置清空", restored.queuePosition === null, String(restored.queuePosition));
    check("恢复后 getInfo().queued 为 false", restored.getInfo().queued === false);
    check("恢复后 isRunning 为 false", restored.isRunning() === false);

    const queued = new AgentSession({ workspace: "D:/tmp/xml-agent-test-ws", task: "t" });
    queued.status = "queued";
    queued.queuePosition = 2;
    const info = queued.getInfo();
    check("排队中 getInfo().queued 为 true", info.queued === true);
    check(
        "排队中 getInfo().queuePosition 为 2",
        info.queuePosition === 2,
        String(info.queuePosition)
    );
    check("排队中 isRunning 为 false", queued.isRunning() === false);

    // 排队中的会话已登记唤醒回调，再 start 会造成同一个 session 被启动两次
    const dup = new AgentSession({ workspace: "D:/tmp/xml-agent-test-ws", task: "t" });
    dup.status = "queued";
    dup.queuePosition = 1;
    let blocked = false;
    try {
        dup.start();
    } catch (error) {
        blocked = /already queued/i.test(error.message);
    }
    check("queued 会话再次 start 被拒绝", blocked);

    // _begin() 同步抛错时 run() 不会执行，必须在 start() 里兜底释放槽位
    const { runGate } = require("../session/run-gate");
    const broken = new AgentSession({ workspace: "D:/tmp/xml-agent-test-ws", task: "t" });
    const brokenId = broken.id;
    broken._begin = () => {
        throw new Error("agent ctor failed");
    };
    let startThrew = false;
    try {
        broken.start();
    } catch (error) {
        startThrew = true;
    }
    check("_begin 抛错时 start 会向上抛", startThrew);
    check("_begin 抛错后槽位被释放", runGate.isHeld(brokenId) === false);
    check("_begin 抛错后状态为 error", broken.status === "error");

    console.log("");
    console.log("Total: " + pass + "/" + total);

    if (pass !== total) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("FAILED: " + error.stack);
    process.exitCode = 1;
});
