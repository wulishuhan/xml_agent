const { ChatGPTProvider } = require("./chatgpt");

const { QwenProvider } = require("./qwen");

const providers = {
  chatgpt: ChatGPTProvider,
  qwen: QwenProvider,
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
