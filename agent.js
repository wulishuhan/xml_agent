const { Agent } = require("./agent-core");
const { saveHistory } = require("./workspace/history");
const { saveReport } = require("./workspace/report");
const agentConfig = require("./config/agent-config");
const logger = require("./logger");
const { cleanupAllSync } = require("./processes/registry");

function parseArgs() {
    const args = process.argv.slice(2);

    let workspace = null;
    let provider = "chatgpt";
    let background = false;
    const taskParts = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--workspace") {
            workspace = args[++i];
            continue;
        }

        if (arg.startsWith("--workspace=")) {
            workspace = arg.substring("--workspace=".length);
            continue;
        }

        if (arg === "--provider") {
            provider = args[++i];
            continue;
        }

        if (arg.startsWith("--provider=")) {
            provider = arg.substring("--provider=".length);
            continue;
        }

        if (arg === "--background") {
            background = true;
            continue;
        }

        taskParts.push(arg);
    }

    return {
        workspace,
        provider,
        task: taskParts.join(" ").trim(),
        background,
    };
}

function attachLogging(agent) {
    agent.on("event", (event) => {
        const prefix = "[" + event.type + "]";

        if (event.type.endsWith("error")) {
            logger.error(prefix, event.error || event.result || "");
            return;
        }

        if (event.type === "provider.response") {
            logger.debug(prefix, "Response length:", event.length);
            return;
        }

        if (event.type === "runtime.result") {
            logger.debug(prefix, event.action, JSON.stringify(event.result));
            return;
        }

        if (event.type === "answer") {
            console.log("");
            console.log("================================");
            console.log("Agent Answer");
            console.log("================================");
            console.log("");
            console.log(event.content);
            return;
        }

        logger.info(prefix, JSON.stringify(event));
    });
}

async function main() {
    const { workspace, task, provider: providerName, background } = parseArgs();

    if (!workspace) {
        throw new Error("Workspace is required");
    }

    if (!task) {
        throw new Error("Task is required");
    }

    if (background) {
        process.on("SIGINT", function () {
            logger.warn("Received SIGINT in background mode, ignoring...");
        });

        logger.info("Running in background mode");
    }

    // 信号路径不会触发 process 的 exit 事件（实测 SIGTERM / SIGINT 都是直接终止），
    // 所以必须在这里显式收摊，否则 --background 启动的命令会留成孤儿。
    // 后台模式的 SIGINT 语义保持原样（忽略），只处理 SIGTERM / SIGHUP。
    let stoppingBySignal = false;
    const stopBySignal = (signal) => {
        if (stoppingBySignal) {
            return;
        }
        stoppingBySignal = true;
        logger.warn("Received " + signal + ", stopping child processes...");
        const killed = cleanupAllSync("signal");
        if (killed > 0) {
            logger.info("Stopped " + killed + " child process(es)");
        }
        process.exit(0);
    };
    if (!background) {
        process.on("SIGINT", () => stopBySignal("SIGINT"));
    }
    process.on("SIGTERM", () => stopBySignal("SIGTERM"));
    process.on("SIGHUP", () => stopBySignal("SIGHUP"));

    const agent = new Agent({
        workspace,
        provider: providerName,
        task,
        maxSteps: agentConfig.agent.maxSteps,
        maxProviderErrors: agentConfig.agent.maxProviderErrors,
    });

    attachLogging(agent);

    console.log("");
    console.log("================================");
    console.log("XML Agent");
    console.log("================================");
    console.log("");
    console.log("[SYSTEM] Workspace:", workspace);
    console.log("[SYSTEM] Provider:", providerName);
    console.log("[SYSTEM] User Task:", task);
    console.log("");

    try {
        const result = await agent.run();

        saveHistory(result.workspace, result.history);
        saveReport(result.task, result.workspace, result.history);

        console.log("");
        console.log("================================");
        console.log("[SYSTEM] Agent Finished");
        console.log("================================");
        console.log("[SYSTEM] Status:", result.status);
        console.log("[SYSTEM] Steps:", result.step);
    } catch (error) {
        logger.error("Agent Error:", error.message);

        try {
            const result = agent.getResult();

            saveHistory(result.workspace, result.history);
            saveReport(result.task, result.workspace, result.history);
        } catch (saveError) {
            logger.error("Failed to save agent artifacts:", saveError.message);
        }

        process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch((error) => {
        logger.error("Fatal Agent Error:", error);
        process.exitCode = 1;
    });
}

module.exports = {
    Agent,
    parseArgs,
    main,
};
