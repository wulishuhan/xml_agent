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
        const error = new Error(result.error || "Failed to start agent");
        error.code = result.code || null;
        error.stats = result.stats || null;
        throw error;
    }
    return result;
}
// 新增：创建占位会话（New Session）
export async function createPlaceholderSession(workspace, provider = "chatgpt") {
    const response = await fetch(api("/api/sessions/new"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspace, provider }),
    });
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.error || "Failed to create placeholder session");
        error.code = result.code || null;
        error.stats = result.stats || null;
        throw error;
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
// 在指定目录下新建文件夹，供 WorkspacePicker 的 "New Folder" 按钮使用。
export async function createWorkspaceFolder(parentPath, name) {
    const response = await fetch(api("/api/workspace/mkdir"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            path: parentPath,
            name,
        }),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to create folder");
    }
    return result;
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
// 新增：按工作区分组获取会话列表
export async function getWorkspaces() {
    const response = await fetch(api("/api/workspaces"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to get workspaces");
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
// 获取会话存储占用统计（数量、磁盘体积、上限、告警状态）。
export async function getStorage() {
    const response = await fetch(api("/api/storage"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to get storage stats");
    }
    return result;
}
// 清理遗留的 .tmp 临时文件。
export async function cleanStorage() {
    const response = await fetch(api("/api/storage/clean"), {
        method: "POST",
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to clean storage");
    }
    return result;
}
export function getEventSourceUrl(sessionId) {
    return api("/api/sessions/" + sessionId + "/events");
}
/**
- 让用户选择图片。
- - 桌面版（Electron）：走原生文件对话框，直接拿到本地绝对路径数组。
- - Web 版：无法拿到本地绝对路径，返回 null，由调用方回退到 <input type="file"> + uploadWorkspaceImages。
*/
export async function pickImages() {
    if (
        typeof window !== "undefined" &&
        window.xmlAgentDesktop &&
        window.xmlAgentDesktop.dialog &&
        typeof window.xmlAgentDesktop.dialog.pickImages === "function"
    ) {
        const paths = await window.xmlAgentDesktop.dialog.pickImages();
        return Array.isArray(paths) ? paths : [];
    }

    return null;
}

/**
- Web 版上传图片：multipart 提交到 /api/uploads，服务端落到 workspace/uploads 下，
- 返回相对 workspace 的路径数组，可直接作为 Agent 的 images 传入。
*/
export async function uploadWorkspaceImages(workspace, files) {
    if (!workspace || !workspace.trim()) {
        throw new Error("Workspace is required before uploading images");
    }
    const list = Array.from(files || []);
    if (!list.length) {
        return [];
    }
    const form = new FormData();
    for (const file of list) {
        form.append("images", file, file.name);
    }
    const response = await fetch(
        api("/api/uploads?workspace=" + encodeURIComponent(workspace.trim())),
        {
            method: "POST",
            body: form,
        }
    );
    const result = await response.json();
    if (!response.ok || !result.ok) {
        throw new Error(result.error || "Failed to upload images");
    }
    return result.paths || [];
}

/**
从 provider 页面 URL 中提取 conversationId。
前端不直接依赖 provider 逻辑，只做一点轻量解析，用于提示用户。

正则优先取自 `/api/providers` 返回的 provider 元数据（与 server 端同一份声明），
接口不可用时回落到下面的内置表，因此页面在接口异常时行为不变。
@param {string} provider "chatgpt" | "deepseek" | "qwen" | "glm" | "gemini" | 插件 provider
@param {string} url
@returns {string|null}
*/
const FALLBACK_PROVIDER_PATTERNS = {
    deepseek: "/a/chat/s/([0-9a-fA-F-]+)",
    chatgpt: "/c/([0-9a-zA-Z-]+)",
    qwen: "/c/([0-9a-zA-Z-]+)",
    glm: "/(?:c|s)/([0-9a-zA-Z-]+)",
    gemini: "/app/([0-9a-zA-Z_-]{8,})",
};
let providerPatternCache = null;
let providersPromise = null;
export async function getProviders() {
    const response = await fetch(api("/api/providers"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to read providers");
    }
    return result;
}
/**
加载并缓存 provider 列表与其会话 id 正则（幂等；失败时静默回落内置表）。
*/
export function loadProviders() {
    if (!providersPromise) {
        providersPromise = getProviders()
            .then((data) => {
                const providers = Array.isArray(data.providers) ? data.providers : [];
                const cache = {};
                for (const item of providers) {
                    if (!item || !item.id || !item.conversationIdPattern) {
                        continue;
                    }
                    try {
                        cache[item.id] = new RegExp(item.conversationIdPattern);
                    } catch (error) {
                        // 非法正则忽略，回落内置表
                    }
                }
                providerPatternCache = cache;
                return providers;
            })
            .catch(() => {
                providerPatternCache = {};
                return [];
            });
    }
    return providersPromise;
}
export function extractConversationId(provider, url) {
    if (!url || typeof url !== "string") {
        return null;
    }
    let pattern = providerPatternCache ? providerPatternCache[provider] : null;
    if (!pattern) {
        const source = FALLBACK_PROVIDER_PATTERNS[provider];
        pattern = source ? new RegExp(source) : null;
    }
    if (!pattern) {
        return null;
    }
    const match = url.match(pattern);
    return match ? match[1] : null;
}
// ---- 浏览器设置与切换（Web 版，通过 HTTP API）----
export async function getBrowserSettings() {
    const response = await fetch(api("/api/browser/settings"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to read browser settings");
    }
    return result;
}
export async function saveBrowserSettings(settings) {
    const response = await fetch(api("/api/browser/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings || {}),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to save browser settings");
    }
    return result;
}
export async function detectBrowser(browserType) {
    const query = browserType ? "?type=" + encodeURIComponent(browserType) : "";
    const response = await fetch(api("/api/browser/detect" + query));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to detect browser");
    }
    return result;
}
export async function getBrowserStatus() {
    const response = await fetch(api("/api/browser/status"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to get browser status");
    }
    return result;
}
export async function launchBrowser() {
    const response = await fetch(api("/api/browser/launch"), { method: "POST" });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to launch browser");
    }
    return result;
}
export async function switchBrowser(browserType) {
    const response = await fetch(api("/api/browser/switch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browserType: browserType || "" }),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to switch browser");
    }
    return result;
}
// ---- Agent 配置管理（Web 版，通过 HTTP API）----
export async function getAgentConfig() {
    const response = await fetch(api("/api/agent/config"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to read agent config");
    }
    return result;
}
export async function saveAgentConfig(config) {
    const response = await fetch(api("/api/agent/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config || {}),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to save agent config");
    }
    return result;
}
// ---- 插件管理（Web 版与桌面版共用同一套本地后端接口）----
function pluginPath(name, suffix) {
    return api("/api/plugins/" + encodeURIComponent(name) + (suffix || ""));
}
export async function getPlugins() {
    const response = await fetch(api("/api/plugins"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to read plugins");
    }
    return result;
}
export async function reloadPlugins() {
    const response = await fetch(api("/api/plugins/reload"), { method: "POST" });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to reload plugins");
    }
    return result;
}
export async function setPluginEnabled(name, enabled) {
    const response = await fetch(pluginPath(name, "/enabled"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabled !== false }),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to update plugin state");
    }
    return result;
}
export async function getPluginConfig(name) {
    const response = await fetch(pluginPath(name, "/config"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to read plugin config");
    }
    return result;
}
export async function savePluginConfig(name, config) {
    const response = await fetch(pluginPath(name, "/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: config || {} }),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to save plugin config");
    }
    return result;
}
export async function getPermissionPolicy() {
    const response = await fetch(api("/api/permissions"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to read permissions");
    }
    return result;
}
// ---- 插件声明式 UI（宿主渲染，插件不提供任何可执行 JS）----
export async function getPluginUi() {
    const response = await fetch(api("/api/plugins/ui"));
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to read plugin UI manifest");
    }
    return result;
}
/**
调用某个插件注册的接口。pluginPath 是面板里声明的相对路径（如 "/summary"）。
*/
export async function callPluginApi(name, pluginPath, method = "GET", body) {
    const suffix =
        pluginPath && pluginPath.charAt(0) === "/" ? pluginPath : "/" + (pluginPath || "");
    const url = api("/api/plugins/" + encodeURIComponent(name) + "/api" + suffix);
    const options = { method };
    if (method !== "GET" && body !== undefined && body !== null) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    let result = null;
    try {
        result = await response.json();
    } catch (error) {
        result = null;
    }
    if (!response.ok) {
        throw new Error((result && result.error) || "Plugin API failed (" + response.status + ")");
    }
    return result || {};
}
export async function grantPermission(scope, policy) {
    const response = await fetch(api("/api/permissions/grant"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, policy }),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "Failed to update permission");
    }
    return result;
}
