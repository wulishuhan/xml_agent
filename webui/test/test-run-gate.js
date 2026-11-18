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

    // 6. 唤醒回调抛错：不能冒泡打断 release()，槽位要回收，后面的继续被唤醒
    setLimit(1);
    let goodWoken = 0;
    const gate6 = new RunGate();
    const errors = [];
    gate6.on("resume.error", (event) => errors.push(event));
    gate6.acquire("a");
    gate6.enqueue("bad", () => {
        throw new Error("boom");
    });
    gate6.enqueue("good", () => {
        goodWoken += 1;
    });
    let releaseThrew = false;
    try {
        gate6.release("a");
    } catch (error) {
        releaseThrew = true;
    }
    check("resume 抛错不会从 release 冒泡", releaseThrew === false);
    check("抛错的会话不占槽位", gate6.isHeld("bad") === false);
    check("后续排队者仍被唤醒", goodWoken === 1, String(goodWoken));
    check(
        "resume.error 事件上报",
        errors.length === 1 && errors[0].id === "bad",
        JSON.stringify(errors)
    );
    check("唤醒链继续后队列清空", gate6.queuedCount() === 0);

    // 7. acquired 事件的 position 不该恒为 null
    setLimit(1);
    const gate7 = new RunGate();
    const acquired = [];
    gate7.on("acquired", (event) => acquired.push(event));
    gate7.acquire("a");
    gate7.enqueue("b", () => {});
    gate7.release("a");
    check(
        "acquired.position 为队首位置 1",
        acquired.length === 1 && acquired[0].position === 1,
        JSON.stringify(acquired)
    );

    // 8. 缺少 resume 的排队项不会永久占死槽位
    setLimit(1);
    let nextWoken = 0;
    const gate8 = new RunGate();
    gate8.acquire("a");
    gate8.enqueue("orphan", null);
    gate8.enqueue("next", () => {
        nextWoken += 1;
    });
    gate8.release("a");
    check("无 resume 的排队项被回收", gate8.isHeld("orphan") === false);
    check("后面的会话仍能启动", nextWoken === 1, String(nextWoken));

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
