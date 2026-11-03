/**
Plugin Capabilities

插件能拿到的"能力门面"。刻意不暴露 raw fs / raw fetch / child_process：
- fs：只能访问当前 Runtime 的 workspace，越界直接抛错（复用 Runtime.resolvePath）；
- http：受域名白名单、超时、响应体积上限约束，不跟随重定向（避免 SSRF 借道跳转）；
- storage：插件私有目录下的 JSON KV 与追加式日志；
- secrets：只读密钥，配合 redactSecrets 在日志与 Trace 中脱敏。
*/

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const MAX_HTTP_TIMEOUT_MS = 120000;
const DEFAULT_HTTP_MAX_BYTES = 1024 * 1024;
const HARD_HTTP_MAX_BYTES = 4 * 1024 * 1024;
const MAX_FS_FILE_BYTES = 2 * 1024 * 1024;

function capabilityError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function clampInt(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(Math.max(Math.trunc(number), min), max);
}

// ------------------------------------------------------------
// workspace 作用域文件访问
// ------------------------------------------------------------

/**
 * resolvePath 由 Runtime 注入（Runtime.resolvePath），
 * 因此插件天然继承 workspace 越界保护，不需要也不允许自己拼绝对路径。
 */
function createWorkspaceFs(options = {}) {
    const workspace = options.workspace || "";
    const resolvePath = options.resolvePath;

    function resolve(target) {
        if (typeof resolvePath !== "function") {
            throw capabilityError("FS_UNAVAILABLE", "当前上下文没有可用的 workspace");
        }
        return resolvePath(String(target || ""));
    }

    function relativeOf(absolutePath) {
        return path.relative(workspace, absolutePath).split(path.sep).join("/");
    }

    return {
        workspace,
        resolve,
        exists(target) {
            try {
                return fs.existsSync(resolve(target));
            } catch (error) {
                return false;
            }
        },
        stat(target) {
            return fs.statSync(resolve(target));
        },
        list(target) {
            const fullPath = resolve(target);
            return fs
                .readdirSync(fullPath, { withFileTypes: true })
                .map((entry) => ({
                    name: entry.name,
                    path: relativeOf(path.join(fullPath, entry.name)),
                    type: entry.isDirectory() ? "directory" : "file",
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        },
        readText(target, options2 = {}) {
            const fullPath = resolve(target);
            const stat = fs.statSync(fullPath);
            const maxBytes = clampInt(options2.maxBytes, MAX_FS_FILE_BYTES, 1, MAX_FS_FILE_BYTES);
            if (stat.size > maxBytes) {
                throw capabilityError(
                    "FS_TOO_LARGE",
                    "文件过大：" + stat.size + " bytes（上限 " + maxBytes + "）"
                );
            }
            return fs.readFileSync(fullPath, "utf8");
        },
        readJson(target, options2 = {}) {
            const text = this.readText(target, options2);
            return JSON.parse(text);
        },
        writeText(target, content, options2 = {}) {
            const fullPath = resolve(target);
            const maxBytes = clampInt(options2.maxBytes, MAX_FS_FILE_BYTES, 1, MAX_FS_FILE_BYTES);
            const text = String(content === undefined || content === null ? "" : content);
            if (Buffer.byteLength(text, "utf8") > maxBytes) {
                throw capabilityError(
                    "FS_TOO_LARGE",
                    "写入内容过大（上限 " + maxBytes + " bytes）"
                );
            }
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            const tempPath = fullPath + ".tmp." + Date.now();
            try {
                fs.writeFileSync(tempPath, text, "utf8");
                fs.renameSync(tempPath, fullPath);
            } catch (error) {
                try {
                    if (fs.existsSync(tempPath)) {
                        fs.unlinkSync(tempPath);
                    }
                } catch (cleanupError) {
                    // ignore
                }
                throw error;
            }
            return { path: relativeOf(fullPath), bytes: Buffer.byteLength(text, "utf8") };
        },
        writeJson(target, value, options2 = {}) {
            return this.writeText(target, JSON.stringify(value, null, 2), options2);
        },
    };
}

// ------------------------------------------------------------
// 受控 HTTP
// ------------------------------------------------------------

/**
 * 域名白名单规则：
 *   "*"              允许任意主机
 *   "example.com"    精确匹配主机名（端口不限）
 *   "example.com:80" 精确匹配主机名 + 端口
 *   "*.example.com"  匹配所有子域
 * 空名单 = 全部拒绝（宁可默认不通，也不要默认全通）。
 */
function isHostAllowed(hostname, port, allowHosts) {
    const host = String(hostname || "").toLowerCase();
    if (!host) {
        return false;
    }
    const authority = port ? host + ":" + port : host;
    for (const raw of Array.isArray(allowHosts) ? allowHosts : []) {
        const rule = String(raw || "")
            .trim()
            .toLowerCase();
        if (!rule) {
            continue;
        }
        if (rule === "*") {
            return true;
        }
        if (rule === host || rule === authority) {
            return true;
        }
        if (rule.indexOf("*.") === 0) {
            const suffix = rule.substring(1);
            if (host.endsWith(suffix) && host.length > suffix.length) {
                return true;
            }
        }
    }
    return false;
}

function parseTargetUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || "").trim());
    } catch (error) {
        throw capabilityError("HTTP_INVALID_URL", "URL 非法：" + rawUrl);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw capabilityError("HTTP_INVALID_URL", "只支持 http / https，收到：" + parsed.protocol);
    }
    return parsed;
}

function createHttpClient(options = {}) {
    const allowHosts = Array.isArray(options.allowHosts) ? options.allowHosts : [];
    const defaultTimeoutMs = clampInt(
        options.defaultTimeoutMs,
        DEFAULT_HTTP_TIMEOUT_MS,
        1,
        MAX_HTTP_TIMEOUT_MS
    );
    const hardMaxBytes = clampInt(options.maxBytes, DEFAULT_HTTP_MAX_BYTES, 1, HARD_HTTP_MAX_BYTES);

    async function request(params = {}) {
        const parsed = parseTargetUrl(params.url);
        const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
        if (!isHostAllowed(parsed.hostname, port, allowHosts)) {
            throw capabilityError(
                "HTTP_HOST_NOT_ALLOWED",
                "域名不在白名单：" +
                    parsed.hostname +
                    "（当前允许：" +
                    (allowHosts.length ? allowHosts.join(", ") : "无") +
                    "）"
            );
        }
        const method = String(params.method || "GET")
            .trim()
            .toUpperCase();
        const timeoutMs = clampInt(params.timeoutMs, defaultTimeoutMs, 1, MAX_HTTP_TIMEOUT_MS);
        const maxBytes = Math.min(
            clampInt(params.maxBytes, hardMaxBytes, 1, HARD_HTTP_MAX_BYTES),
            hardMaxBytes
        );
        return await sendRequest({
            parsed,
            method,
            body: params.body,
            headers: params.headers,
            timeoutMs,
            maxBytes,
            signal: params.signal,
        });
    }

    return { request, allowHosts };
}

function sendRequest({ parsed, method, body, headers, timeoutMs, maxBytes, signal }) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(capabilityError("HTTP_ABORTED", "请求已被取消"));
            return;
        }
        const transport = parsed.protocol === "https:" ? https : http;
        const requestOptions = {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method,
            headers: Object.assign({ "user-agent": "xml-agent-plugin/1" }, headers || {}),
        };
        let settled = false;
        let timer = null;

        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            resolve(value);
        };
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            reject(error);
        };

        const request = transport.request(requestOptions, (response) => {
            const chunks = [];
            let bytes = 0;
            let truncated = false;
            response.on("data", (chunk) => {
                if (truncated) {
                    return;
                }
                bytes += chunk.length;
                if (bytes > maxBytes) {
                    const keep = chunk.length - (bytes - maxBytes);
                    if (keep > 0) {
                        chunks.push(chunk.subarray(0, keep));
                    }
                    truncated = true;
                    bytes = maxBytes;
                    request.destroy();
                    finish(buildResponse(response, chunks, bytes, truncated));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => finish(buildResponse(response, chunks, bytes, truncated)));
            response.on("error", (error) => fail(wrapNetworkError(error)));
        });

        request.on("error", (error) => fail(wrapNetworkError(error)));

        timer = setTimeout(() => {
            request.destroy();
            fail(capabilityError("HTTP_TIMEOUT", "请求超时（" + timeoutMs + "ms）"));
        }, timeoutMs);
        if (typeof timer.unref === "function") {
            timer.unref();
        }

        if (signal) {
            signal.addEventListener(
                "abort",
                () => {
                    request.destroy();
                    fail(capabilityError("HTTP_ABORTED", "请求已被取消"));
                },
                { once: true }
            );
        }

        if (body !== undefined && body !== null && String(body) !== "") {
            request.write(String(body));
        }
        request.end();
    });
}

function buildResponse(response, chunks, bytes, truncated) {
    return {
        ok: true,
        status: response.statusCode,
        statusText: response.statusMessage || "",
        headers: response.headers || {},
        body: Buffer.concat(chunks).toString("utf8"),
        bytes,
        truncated,
    };
}

function wrapNetworkError(error) {
    if (error && error.code && String(error.code).indexOf("HTTP_") === 0) {
        return error;
    }
    const wrapped = capabilityError(
        "HTTP_REQUEST_FAILED",
        "请求失败：" + ((error && error.message) || "unknown error")
    );
    wrapped.cause = error;
    return wrapped;
}

// ------------------------------------------------------------
// 插件私有存储
// ------------------------------------------------------------

function safeSegment(value) {
    return String(value || "")
        .replace(/[^a-zA-Z0-9_.-]/g, "_")
        .replace(/^\.+/, "");
}

function createStorage(options = {}) {
    const dir = options.dir;
    if (!dir) {
        throw capabilityError("STORAGE_UNAVAILABLE", "插件存储目录未配置");
    }

    function resolve(name) {
        const safe = safeSegment(name);
        if (!safe) {
            throw capabilityError("STORAGE_INVALID_KEY", "非法的存储文件名");
        }
        return path.join(dir, safe);
    }

    function ensureDir() {
        fs.mkdirSync(dir, { recursive: true });
    }

    return {
        dir,
        resolve,
        ensureDir,
        readJson(name, fallback) {
            const filePath = resolve(name);
            if (!fs.existsSync(filePath)) {
                return fallback === undefined ? null : fallback;
            }
            try {
                return JSON.parse(fs.readFileSync(filePath, "utf8"));
            } catch (error) {
                return fallback === undefined ? null : fallback;
            }
        },
        writeJson(name, value) {
            ensureDir();
            const filePath = resolve(name);
            const tempPath = filePath + ".tmp";
            fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
            fs.renameSync(tempPath, filePath);
            return filePath;
        },
        appendLine(name, text) {
            ensureDir();
            const filePath = resolve(name);
            fs.appendFileSync(filePath, String(text) + "\n", "utf8");
            return filePath;
        },
        readText(name, fallback) {
            const filePath = resolve(name);
            if (!fs.existsSync(filePath)) {
                return fallback === undefined ? "" : fallback;
            }
            return fs.readFileSync(filePath, "utf8");
        },
        /**
         * 列出插件私有目录里的文件名（按名称排序）。
         * 只给文件名，不给路径：插件不该知道也不该拼宿主的目录结构。
         * 用于"按保留策略清理旧文件"这类需要枚举的场景。
         */
        list() {
            try {
                return fs
                    .readdirSync(dir)
                    .filter((name) => name.indexOf(".") !== 0)
                    .filter((name) => {
                        try {
                            return fs.statSync(path.join(dir, name)).isFile();
                        } catch (error) {
                            return false;
                        }
                    })
                    .sort();
            } catch (error) {
                // 目录还不存在等同于"没有文件"
                if (error && error.code === "ENOENT") {
                    return [];
                }
                throw error;
            }
        },
        /**
         * 删除插件私有目录里的一个文件。存在并删除成功返回 true，
         * 文件本来就不在返回 false（清理旧文件时这属于正常情况）。
         * 其他错误照常抛出：删不掉（权限/占用）必须让调用方知道，
         * 静默失败会让"自动清理"变成一句空话。
         */
        remove(name) {
            const filePath = resolve(name);
            try {
                fs.unlinkSync(filePath);
                return true;
            } catch (error) {
                if (error && error.code === "ENOENT") {
                    return false;
                }
                throw error;
            }
        },
    };
}

// ------------------------------------------------------------
// 密钥（只读）
// ------------------------------------------------------------

function createSecrets(options = {}) {
    const file = options.file;

    function readAll() {
        if (!file || !fs.existsSync(file)) {
            return {};
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    return {
        getAll: readAll,
        get(key) {
            const all = readAll();
            const name = String(key || "");
            return Object.prototype.hasOwnProperty.call(all, name) ? all[name] : null;
        },
    };
}

function redactSecrets(text, secrets) {
    if (!text || typeof text !== "string" || !secrets) {
        return text;
    }
    let result = text;
    for (const key of Object.keys(secrets)) {
        const value = secrets[key];
        if (typeof value !== "string" || value.length < 4) {
            continue;
        }
        result = result.split(value).join("***");
    }
    return result;
}

module.exports = {
    isHostAllowed,
    parseTargetUrl,
    createWorkspaceFs,
    createHttpClient,
    createStorage,
    createSecrets,
    redactSecrets,
    DEFAULT_HTTP_TIMEOUT_MS,
    DEFAULT_HTTP_MAX_BYTES,
    HARD_HTTP_MAX_BYTES,
};
