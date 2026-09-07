
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const { getText } = require("./parse/xml-parse");
const agentConfig = require("./config/agent-config");

const MAX_FILE_SIZE = agentConfig.runtime.maxFileSize;
const MAX_READ_SIZE = agentConfig.runtime.maxReadSize;
const MAX_EXEC_TIMEOUT = agentConfig.runtime.maxExecTimeout;

class Runtime {
constructor(workspace = null) {
this.workspace = null;

    if (workspace) {
        this.setWorkspace(workspace);
    }
}

setWorkspace(workspace) {
    if (!workspace || typeof workspace !== "string") {
        throw new Error("Workspace path is required");
    }

    const resolved = path.resolve(workspace);

    if (!fs.existsSync(resolved)) {
        throw new Error("Workspace does not exist: " + resolved);
    }

    const stat = fs.statSync(resolved);

    if (!stat.isDirectory()) {
        throw new Error("Workspace is not a directory: " + resolved);
    }

    this.workspace = resolved;

    return this.workspace;
}

getWorkspace() {
    if (!this.workspace) {
        throw new Error("Workspace has not been configured");
    }

    return this.workspace;
}

resolvePath(filePath) {
    const workspace = this.getWorkspace();

    if (!filePath || typeof filePath !== "string") {
        throw new Error("Path is required");
    }

    if (path.isAbsolute(filePath)) {
        throw new Error("Absolute paths are not allowed");
    }

    const fullPath = path.resolve(workspace, filePath);
    const workspacePrefix = workspace.endsWith(path.sep)
        ? workspace
        : workspace + path.sep;

    if (
        fullPath !== workspace &&
        !fullPath.startsWith(workspacePrefix)
    ) {
        throw new Error("Path escapes workspace");
    }

    return fullPath;
}

read(node) {
    const filePath = node?.["@_path"];

    if (!filePath) {
        throw new Error("read requires path");
    }

    const fullPath = this.resolvePath(filePath);

    if (!fs.existsSync(fullPath)) {
        return {
            ok: false,
            action: "read",
            path: filePath,
            error: "File or directory does not exist",
        };
    }

    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
        const entries = fs
            .readdirSync(fullPath, {
                withFileTypes: true,
            })
            .map((entry) => {
                return entry.name + (entry.isDirectory() ? "/" : "");
            })
            .sort();

        return {
            ok: true,
            action: "read",
            path: filePath,
            type: "directory",
            entries,
        };
    }

    if (stat.size > MAX_READ_SIZE) {
        return {
            ok: false,
            action: "read",
            path: filePath,
            error:
                "File too large to read. Size: " +
                stat.size +
                " bytes",
        };
    }

    const content = fs.readFileSync(fullPath, "utf8");

    return {
        ok: true,
        action: "read",
        path: filePath,
        type: "file",
        size: stat.size,
        content,
    };
}

write(node) {
    const filePath = node?.["@_path"];

    if (!filePath) {
        throw new Error("write requires path");
    }

    const fullPath = this.resolvePath(filePath);
    const content = getText(node);

    if (Buffer.byteLength(content, "utf8") > MAX_FILE_SIZE) {
        return {
            ok: false,
            action: "write",
            path: filePath,
            error: "File too large",
        };
    }

    fs.mkdirSync(path.dirname(fullPath), {
        recursive: true,
    });

    fs.writeFileSync(fullPath, content, "utf8");

    return {
        ok: true,
        action: "write",
        path: filePath,
        size: Buffer.byteLength(content, "utf8"),
    };
}

execute(node) {
    const workspace = this.getWorkspace();
    const command = node?.["@_command"];

    if (!command) {
        throw new Error("exec requires command");
    }

    console.log("");
    console.log("Executing command:");
    console.log(command);

    const isBackground = command.includes(" --background");

    if (isBackground) {
        const cleanCommand = command.replace(/ --background/g, "");

        console.log(
            "Running as background process: " + cleanCommand
        );

        try {
            const child = spawn(cleanCommand, {
                cwd: workspace,
                shell: true,
                env: process.env,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });

            child.unref();

            console.log(
                "Background process started with PID: " + child.pid
            );

            return {
                ok: true,
                action: "exec",
                command: cleanCommand,
                background: true,
                pid: child.pid,
                message:
                    "Background process started with PID: " +
                    child.pid,
            };
        } catch (error) {
            return {
                ok: false,
                action: "exec",
                command: cleanCommand,
                error: error.message,
            };
        }
    }

    try {
        const output = execSync(command, {
            cwd: workspace,
            encoding: "utf8",
            timeout: MAX_EXEC_TIMEOUT,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: false,
        });

        return {
            ok: true,
            action: "exec",
            command,
            output,
        };
    } catch (error) {
        return {
            ok: false,
            action: "exec",
            command,
            exitCode: error.status ?? null,
            stdout: error.stdout || "",
            stderr: error.stderr || "",
            error: error.message,
        };
    }
}

answer(node) {
    const content = getText(node);

    if (!content.trim()) {
        throw new Error("answer content cannot be empty");
    }

    return {
        ok: true,
        action: "answer",
        content,
    };
}

done() {
    return {
        ok: true,
        action: "done",
    };
}

run(action) {
    if (!action || typeof action !== "object") {
        throw new Error("Action is required");
    }

    this.getWorkspace();

    const actionName = action.action;
    const node = action.node;

    if (!actionName || typeof actionName !== "string") {
        throw new Error("Action name is required");
    }

    console.log("");
    console.log("==================================");
    console.log("Runtime Action:", actionName);
    console.log("==================================");

    const handler = this.actionHandlers[actionName];

    if (!handler) {
        throw new Error("Unknown action: " + actionName);
    }

    return handler(node);
}

get actionHandlers() {
    return {
        read: this.read.bind(this),
        write: this.write.bind(this),
        exec: this.execute.bind(this),
        answer: this.answer.bind(this),
        done: this.done.bind(this),
    };
}

}

function createRuntime(workspace) {
return new Runtime(workspace);
}

/*

Legacy singleton API.

Existing callers can continue to use:

setWorkspace(workspace);

run(action);

New Agent instances should create their own Runtime instance through

createRuntime(workspace), which keeps workspace state isolated.
*/
const legacyRuntime = createRuntime();

function setWorkspace(workspace) {
return legacyRuntime.setWorkspace(workspace);
}

function getWorkspace() {
return legacyRuntime.getWorkspace();
}

function run(action) {
return legacyRuntime.run(action);
}

module.exports = {
Runtime,
createRuntime,
run,
setWorkspace,
getWorkspace,
};
