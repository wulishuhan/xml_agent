const { SessionManager } = require("../webui/session/session-manager");

async function main() {
const manager = new SessionManager();

const s1 = manager.create({
    workspace: process.cwd(),
    provider: "chatgpt",
    task: "test session A",
});

const s2 = manager.create({
    workspace: process.cwd(),
    provider: "chatgpt",
    task: "test session B",
});

console.log("session1:", s1.id);
console.log("session2:", s2.id);

console.log("same session object:", s1 === s2);
console.log("session count:", manager.list().length);

if (s1 === s2 || manager.list().length !== 2) {
    throw new Error("Session isolation failed");
}

console.log("Session isolation test passed");

}

main().catch((error) => {
console.error(error.message);
process.exit(1);
});
