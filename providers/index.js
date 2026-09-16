const { ChatGPTProvider } = require("./chatgpt");
const { DeepSeekProvider } = require("./deepseek");
const { QwenProvider } = require("./qwen");
const { GlmProvider } = require("./glm");
const providers = {
    chatgpt: ChatGPTProvider,
    deepseek: DeepSeekProvider,
    qwen: QwenProvider,
    glm: GlmProvider,
};
function createProvider(name, options = {}) {
    const ProviderClass = providers[name];
    if (!ProviderClass) {
        throw new Error(`Unknown provider: ${name}`);
    }

    return new ProviderClass(options);
}
module.exports = {
    createProvider,
};
