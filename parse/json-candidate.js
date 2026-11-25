function findJsonObjects(text) {
    const source = String(text || "");
    const candidates = [];
    let start = 0;
    while (start < source.length) {
        if (source[start] !== "{") {
            start += 1;
            continue;
        }
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let index = start; index < source.length; index += 1) {
            const char = source[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === "\\") {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
            } else if (char === "{") {
                depth += 1;
            } else if (char === "}") {
                depth -= 1;
                if (depth === 0) {
                    end = index;
                    break;
                }
            }
        }
        if (end !== -1) {
            candidates.push(source.slice(start, end + 1));
            start = end + 1;
        } else {
            start += 1;
        }
    }
    return candidates;
}

function isEnvelope(value) {
    return Boolean(
        value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof value.action === "string" &&
            value.params &&
            typeof value.params === "object" &&
            !Array.isArray(value.params)
    );
}

function extractActionEnvelope(response) {
    if (!response || typeof response !== "string" || !response.trim()) {
        throw new Error("returned empty response");
    }
    const text = response.trim();
    const candidates = findJsonObjects(text);
    const envelopes = [];
    const errors = [];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (isEnvelope(parsed)) {
                envelopes.push(parsed);
            }
        } catch (error) {
            errors.push(error.message);
        }
    }
    if (envelopes.length === 1) {
        return envelopes[0];
    }
    if (envelopes.length > 1) {
        throw new Error("Exactly one JSON action is required, but received " + envelopes.length);
    }
    if (errors.length > 0) {
        throw new Error("Invalid JSON action: " + errors[0]);
    }
    throw new Error('JSON action must be an object with string "action" and object "params"');
}

function hasActionEnvelope(response) {
    try {
        extractActionEnvelope(response);
        return true;
    } catch (error) {
        return false;
    }
}

module.exports = {
    extractActionEnvelope,
    findJsonObjects,
    hasActionEnvelope,
};
