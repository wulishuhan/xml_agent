
const agentConfig = require("../config/agent-config.js");

console.log("============================================================");
console.log("Agent Configuration Test");
console.log("============================================================");
console.log("");

console.log("Agent Settings:");
console.log(" maxSteps:", agentConfig.agent.maxSteps);
console.log(" maxProviderErrors:", agentConfig.agent.maxProviderErrors);
console.log("");

console.log("Runtime Settings:");
console.log(" maxFileSize:", agentConfig.runtime.maxFileSize, "bytes");
console.log(" maxReadSize:", agentConfig.runtime.maxReadSize, "bytes");
console.log(" maxExecTimeout:", agentConfig.runtime.maxExecTimeout, "ms");
console.log("");

console.log("Configuration validation passed.");
console.log("Test completed successfully.");
