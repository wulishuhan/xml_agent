// Electron 版会把端口通过 window.xmlAgentDesktop.port 注入，
// 浏览器版没有该对象，此时回退到相对路径（同源）。
function getBaseUrl() {
    if (typeof window !== "undefined" && window.xmlAgentDesktop && window.xmlAgentDesktop.baseUrl) {
        return window.xmlAgentDesktop.baseUrl;
    }

    return "";
}

function api(path) {
    return getBaseUrl() + path;
}

export async function runAgent(data) {
    const response = await fetch(api("/api/run"), {
        method: "POST",

        headers: {
            "Content-Type": "application/json",
        },

        body: JSON.stringify(data),
    });

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error || "Failed to start agent");
    }

    return result;
}

export async function browseWorkspace(targetPath) {
    const query = targetPath ? "?path=" + encodeURIComponent(targetPath) : "";
    const response = await fetch(api("/api/workspace/browse" + query));

    if (!response.ok) {
        const text = await response.text();
        let message = "Failed to browse workspace";

        try {
            const result = JSON.parse(text);
            message = result.error || message;
        } catch (error) {
            message = text || message;
        }

        throw new Error(message);
    }

    return response.json();
}

export async function getSession(sessionId) {
    const response = await fetch(api("/api/sessions/" + sessionId));

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error || "Failed to get session");
    }

    return result;
}

export async function getSessionOutput(sessionId) {
    const response = await fetch(api("/api/sessions/" + sessionId + "/output"));

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error || "Failed to get session output");
    }

    return result;
}

export async function stopSession(sessionId) {
    const response = await fetch(api("/api/sessions/" + sessionId + "/stop"), {
        method: "POST",
    });

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error || "Failed to stop session");
    }

    return result;
}

export async function getSessions() {
    const response = await fetch(api("/api/sessions"));

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error || "Failed to get sessions");
    }

    return result;
}

export async function deleteSession(sessionId) {
    const response = await fetch(api("/api/sessions/" + sessionId), {
        method: "DELETE",
    });

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error || "Failed to delete session");
    }

    return result;
}

export function getEventSourceUrl(sessionId) {
    return api("/api/sessions/" + sessionId + "/events");
}
