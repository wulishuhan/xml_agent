const { extractActionEnvelope } = require("./json-candidate");
const { ACTION_ENVELOPE_SCHEMA, validateParams } = require("./action-schema");

let builtinActionsModule = null;
let pluginRegistryModule = null;

function getBuiltinActionsApi() {
    if (builtinActionsModule === null) {
        builtinActionsModule = require("../actions");
    }
    return builtinActionsModule;
}

function getPluginRegistry() {
    if (pluginRegistryModule === null) {
        pluginRegistryModule = require("../plugins/registry");
    }
    return pluginRegistryModule.getRegistrySafe();
}

function extractAction(response) {
    const envelope = extractActionEnvelope(response);
    const checkedEnvelope = validateParams(ACTION_ENVELOPE_SCHEMA, envelope);
    if (!checkedEnvelope.ok) {
        throw new Error(checkedEnvelope.error);
    }
    const action = checkedEnvelope.value.action;
    const params = checkedEnvelope.value.params;
    const builtin = getBuiltinActionsApi().validateBuiltinAction(action, params);
    if (builtin.ok) {
        return { action, params: builtin.value };
    }
    if (builtin.error && builtin.error.indexOf("Unknown action:") === 0) {
        const registry = getPluginRegistry();
        if (registry && registry.hasAction(action)) {
            const plugin = registry.validateAction(action, params);
            if (!plugin.ok) {
                throw new Error(plugin.error || "Invalid " + action + " action");
            }
            return {
                action,
                params: plugin.value,
                plugin: registry.getActionPluginName(action),
            };
        }
        throw new Error(builtin.error);
    }
    throw new Error(builtin.error || "Invalid " + action + " action");
}

Object.defineProperty(module.exports, "ACTION_NAMES", {
    enumerable: true,
    get() {
        return getBuiltinActionsApi().getBuiltinActionNames();
    },
});

module.exports = {
    extractAction,
};
