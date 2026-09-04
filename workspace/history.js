const fs = require("fs");
const path = require("path");
/**
 * History
 */

const history = [];

/**
 * 创建 History Record
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
 * Save History
 */

function saveHistory(workspace) {
  const agentDir = path.join(workspace, ".agent");

  fs.mkdirSync(agentDir, {
    recursive: true,
  });

  const historyPath = path.join(agentDir, "history.json");

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf8");

  return historyPath;
}

module.exports = {
  history,
  createHistoryRecord,
  saveHistory,
};
