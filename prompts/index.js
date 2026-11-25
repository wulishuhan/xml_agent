const { getSystemPrompt } = require("./system-prompt.js");
const { getFirstPrompt } = require("./first-prompt.js");
const { getJsonErrorPrompt } = require("./json-error-prompt.js");
const { getDonePrompt } = require("./done-prompt.js");
const { getRuntimeErrorPrompt, getRuntimeOkPrompt } = require("./runtime-prompt.js");
const { getSendErrorPrompt } = require("./send-error-prompt.js");

module.exports = {
    getSystemPrompt,
    getFirstPrompt,
    getJsonErrorPrompt,
    getDonePrompt,
    getRuntimeErrorPrompt,
    getRuntimeOkPrompt,
    getSendErrorPrompt,
};
