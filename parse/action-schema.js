const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
const validators = new WeakMap();
const MAX_READ_CHARS = 4000;

const READ_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
        path: { type: "string", minLength: 1 },
        offset: {
            type: "integer",
            minimum: 0,
            description: "Character offset for the next read window; defaults to 0.",
        },
        limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_READ_CHARS,
            description: "Characters to return in this window; defaults to 4000.",
        },
    },
};

const WRITE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string", minLength: 1 },
    },
};

const EDIT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["path", "changes"],
    properties: {
        path: { type: "string", minLength: 1 },
        all: { type: "boolean", default: false },
        changes: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["old", "new"],
                properties: {
                    old: { type: "string", minLength: 1 },
                    new: { type: "string" },
                },
            },
        },
    },
};

const EXEC_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
        command: { type: "string", minLength: 1 },
    },
};

const ANSWER_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["content"],
    properties: {
        content: { type: "string", minLength: 1 },
    },
};

const DONE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    maxProperties: 0,
};

const SCREENSHOT_TARGET_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["source"],
    properties: {
        source: { type: "string", enum: ["screen", "window", "browser_page"] },
        windowTitle: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        url: { type: "string", minLength: 1 },
        selector: { type: "string", minLength: 1 },
        fullPage: { type: "boolean", default: false },
        path: { type: "string", minLength: 1 },
    },
    allOf: [
        {
            if: { properties: { source: { const: "window" } }, required: ["source"] },
            then: { anyOf: [{ required: ["windowTitle"] }, { required: ["title"] }] },
        },
    ],
};

const SCREENSHOT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["targets"],
    properties: {
        targets: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: SCREENSHOT_TARGET_SCHEMA,
        },
    },
};

const BUILTIN_ACTION_SCHEMAS = {
    read: READ_SCHEMA,
    write: WRITE_SCHEMA,
    edit: EDIT_SCHEMA,
    exec: EXEC_SCHEMA,
    answer: ANSWER_SCHEMA,
    done: DONE_SCHEMA,
    screenshot: SCREENSHOT_SCHEMA,
};

const ACTION_ENVELOPE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["action", "params"],
    properties: {
        action: { type: "string", minLength: 1 },
        params: { type: "object" },
    },
};

const ACTION_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["action", "params"],
    properties: {
        action: { type: "string", minLength: 1 },
        params: { type: "object" },
    },
    $defs: BUILTIN_ACTION_SCHEMAS,
    allOf: Object.keys(BUILTIN_ACTION_SCHEMAS).map((name) => ({
        if: {
            properties: { action: { const: name } },
            required: ["action"],
        },
        then: {
            properties: {
                params: { $ref: "#/$defs/" + name },
            },
        },
    })),
};

function validateParams(schema, params) {
    if (!schema || typeof schema !== "object") {
        return { ok: true, value: params };
    }
    let validate = validators.get(schema);
    if (!validate) {
        validate = ajv.compile(schema);
        validators.set(schema, validate);
    }
    const value =
        params && typeof params === "object" ? JSON.parse(JSON.stringify(params)) : params;
    if (validate(value)) {
        return { ok: true, value };
    }
    const details = (validate.errors || [])
        .map((error) => {
            const path = error.instancePath || "params";
            if (error.keyword === "additionalProperties" && error.params.additionalProperty) {
                return (
                    path +
                    " must NOT have additional property '" +
                    error.params.additionalProperty +
                    "'"
                );
            }
            return path + " " + error.message;
        })
        .join("; ");
    return { ok: false, value, error: details || "参数不符合 JSON Schema" };
}

module.exports = {
    ACTION_ENVELOPE_SCHEMA,
    ACTION_SCHEMA,
    BUILTIN_ACTION_SCHEMAS,
    MAX_READ_CHARS,
    SCREENSHOT_TARGET_SCHEMA,
    validateParams,
};
