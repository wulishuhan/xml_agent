const os = require("os");
const path = require("path");
const fs = require("fs");

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-hook-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-hookws-"));

const { createRegistry, setRegistryForTests } = require("../plugins/registry");
const reg = createRegistry({ storeRoot, logger: { info() {}, warn() {}, error() {}, debug() {} } });
reg.load();
setRegistryForTests(reg);

const { Agent } = require("../agent-core");
const agent = new Agent({ workspace: ws, task: "hook check" });
let events = 0;
agent.on("event", () => {
    events += 1;
});
agent.emitEvent("runtime.result", {
    step: 1,
    action: "fetch",
    result: { ok: true, action: "fetch", plugin: "fetch", durationMs: 5 },
});
agent.emitEvent("agent.error", { error: "boom" });

const auditDir = path.join(storeRoot, "plugins", "audit-log", "data");
const files = fs.existsSync(auditDir) ? fs.readdirSync(auditDir) : [];
const text = files.length ? fs.readFileSync(path.join(auditDir, files[0]), "utf8") : "";
const lines = text.trim() ? text.trim().split("\n") : [];

console.log("agent.plugins attached:", Boolean(agent.plugins));
console.log("events emitted:", events);
console.log("audit lines:", lines.length);
console.log("audit has fetch action:", text.indexOf('"action":"fetch"') !== -1);
console.log("audit has agent.error:", text.indexOf("agent.error") !== -1);

fs.rmSync(storeRoot, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });
