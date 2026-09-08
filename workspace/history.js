const fs = require("fs");
const path = require("path");

/**

Create an isolated history store for one Agent execution.

Keeping history per execution is important for the reusable Agent core:

multiple sessions must not share a global history array.
*/
function createHistory() {
    return [];
}

/**

Create a History Record.
*/
function createHistoryRecord(step, action, result) {
    return {
        step,
        timestamp: new Date().toISOString(),
        action,
        result,
    };
}

/**

Save History.

The records argument is optional for backward compatibility with the

original global history API.
*/
function saveHistory(workspace, records = history) {
    const agentDir = path.join(workspace, ".agent");

    fs.mkdirSync(agentDir, {
        recursive: true,
    });

    const historyPath = path.join(agentDir, "history.json");

    fs.writeFileSync(historyPath, JSON.stringify(records, null, 2), "utf8");

    return historyPath;
}

/**

Legacy history store.

Existing callers can continue using:

const { history } = require("./history");

New Agent instances should use createHistory() instead.
*/
const history = [];

module.exports = {
    history,
    createHistory,
    createHistoryRecord,
    saveHistory,
};
