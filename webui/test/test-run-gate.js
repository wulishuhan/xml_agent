/**
 * 并发闸门单测（webui/session/run-gate.js）
 *
 * 覆盖：单槽排队与唤醒、队列位置、排队中取消、limit=0 不限、多槽、运行期调大。
 *
 * 运行：node webui/test/test-run-gate.js
 */

const agentConfig = require("../../config/agent-config");
const { RunGate } = require("../session/run-gate");

let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total += 1;
    if (ok) {
        pass += 1;
    }
    console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail ? "  [" + detail + "]" : ""));
}

function setLimit(value) {
    agentConfig.browser.maxConcurrentSessions = value;
}

async function main() {
    // 1. 单槽：第二个排队，释放后自动唤醒
    setLimit(1);
    let resumed = 0;
    const gate = new RunGate();
    check("limit 读取为 1", gate.limit() === 1, String(gate.limit()));
    check("第一个获得槽位", gate.acquire("a") === true);
    check("第二个被拒", gate.acquire("b") === false);
    gate.enqueue("b", () => {
        resumed += 1;
    });
    check("队列长度 1", gate.queuedCount() === 1);
    check("位置为 1", gate.positionOf("b") === 1);
    check("未排队的位置为 null", gate.positionOf("a") === null);
    check("释放唤醒 b", gate.release("a") === "b");
    check("b 的回调被调用", resumed === 1);
    check("b 已持有槽位", gate.isHeld("b") === true);
    check("队列已清空", gate.queuedCount() === 0);
    check("重复释放幂等", gate.release("a") === null);

    // 2. 排队中取消（remove）
    setLimit(1);
    const gate2 = new RunGate();
    gate2.acquire("x");
    gate2.enqueue("y", () => {});
    check("取消排队返回 null", gate2.release("y") === null);
    check("取消后队列空", gate2.queuedCount() === 0);
    check("取消后不影响已持有者", gate2.isHeld("x") === true);

    // 3. limit=0 不限并发
    setLimit(0);
    const gate3 = new RunGate();
    check(
        "limit=0 时不限",
        gate3.limit() === 0 && gate3.acquire("p") === true && gate3.acquire("q") === true
    );

    // 4. limit=2
    setLimit(2);
    const gate4 = new RunGate();
    check("limit=2 前两个通过", gate4.acquire("p") === true && gate4.acquire("q") === true);
    check("limit=2 第三个被拒", gate4.acquire("r") === false);

    // 5. 运行期调大：两个等待者都会被唤醒
    setLimit(1);
    let bWoken = 0;
    let cWoken = 0;
    const gate5 = new RunGate();
    gate5.acquire("a");
    gate5.enqueue("b", () => {
        bWoken += 1;
    });
    gate5.enqueue("c", () => {
        cWoken += 1;
    });
    setLimit(2);
    gate5.release("a");
    check("运行期调大后 b 被唤醒", bWoken === 1, String(bWoken));
    check("运行期调大后 c 被唤醒", cWoken === 1, String(cWoken));
    check("运行期调大后都持有槽位", gate5.isHeld("b") && gate5.isHeld("c"));

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
