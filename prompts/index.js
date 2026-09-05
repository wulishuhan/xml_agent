const { SYSTEM_PROMPT } = require("./system-prompt.js");
const { getFirstPrompt } = require("./first-prompt.js");
const { getXmlErrorPrompt } = require("./xml-error-prompt.js");
const { getDonePrompt } = require("./done-prompt.js");
const { getRuntimeErrorPrompt, getRuntimeOkPrompt } = require("./runtime-prompt.js");
const { getSendErrorPrompt } = require("./send-error-prompt.js");
function getSystemPrompt() {
  return SYSTEM_PROMPT;
}

module.exports = {
  getSystemPrompt,
  getFirstPrompt,
  getXmlErrorPrompt,
  getDonePrompt,
  getRuntimeErrorPrompt,
  getRuntimeOkPrompt,
  getSendErrorPrompt,
};
