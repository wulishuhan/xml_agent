/**
 * ==========================================================
 * Agent Configuration
 * ==========================================================
 */

const agentConfig = {
  agent: {
    maxSteps: 50,
    maxProviderErrors: 3,
  },

  runtime: {
    maxFileSize: 5 * 1024 * 1024,
    maxReadSize: 2 * 1024 * 1024,
    maxExecTimeout: 300000,
  },
};

function validateConfig(config) {
  if (
    !Number.isInteger(config.agent.maxSteps) ||
    config.agent.maxSteps <= 0
  ) {
    throw new Error("agent.maxSteps must be a positive integer");
  }

  if (
    !Number.isInteger(config.agent.maxProviderErrors) ||
    config.agent.maxProviderErrors <= 0
  ) {
    throw new Error(
      "agent.maxProviderErrors must be a positive integer"
    );
  }

  if (
    !Number.isInteger(config.runtime.maxFileSize) ||
    config.runtime.maxFileSize <= 0
  ) {
    throw new Error(
      "runtime.maxFileSize must be a positive integer"
    );
  }

  if (
    !Number.isInteger(config.runtime.maxReadSize) ||
    config.runtime.maxReadSize <= 0
  ) {
    throw new Error(
      "runtime.maxReadSize must be a positive integer"
    );
  }

  if (
    !Number.isInteger(config.runtime.maxExecTimeout) ||
    config.runtime.maxExecTimeout <= 0
  ) {
    throw new Error(
      "runtime.maxExecTimeout must be a positive integer"
    );
  }
}

validateConfig(agentConfig);

module.exports = agentConfig;