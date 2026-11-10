/**
技能（Skill）的扫描、读取与安装

技能 = 一份自包含的 Markdown 指令文档，模型按需 `read` 进来照着做。
对应 `docs/PLUGIN_DESIGN.md` 里的"技能文件模式"：把长文档塞进系统提示词会撑爆上下文，
而写作规范、流程约定这类知识不产生新动作，做成独立文档按需读取更划算。

三个来源，同名（slug 相同）时优先级从低到高：

    builtin     <projectRoot>/skills/<name>/SKILL.md        随仓库与安装包分发
    user        ~/.xml-agent/skills/<name>.md               跨工作区共享
    workspace   <workspace>/.agent/skills/<name>.md         随项目走

高优先级覆盖低优先级，被覆盖的来源记在 `shadowed` 里，前端可以提示"有同名技能被遮蔽"。

对外 id 形如 `workspace:novel-writing`（`source:slug`）。id 只用来在扫描结果里查表，
不会直接拼进文件路径 —— 路径穿越在校验层就被拦掉了，查不到即 404。
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

/** 来源，按优先级从低到高。 */
const SKILL_SOURCES = ["builtin", "user", "workspace"];
const SOURCE_RANK = { builtin: 0, user: 1, workspace: 2 };

/** 单个技能文档的大小上限：超过就截断（技能文档本来就该精简，1MB 已经离谱了）。 */
const MAX_SKILL_BYTES = 1024 * 1024;
/** 列表接口只读文件头部来提取标题/描述，不必把整篇读进来。 */
const META_READ_BYTES = 8 * 1024;
const MAX_DESCRIPTION_CHARS = 200;
/** 禁用状态落盘位置（与插件配置同目录）。 */
const REGISTRY_FILE = "skills.json";
/** slug 里不允许出现路径分隔符与文件名非法字符。 */
const INVALID_SLUG = /[\\/:*?"<>|\u0000-\u001f]/;

function skillError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function statOrNull(target) {
    try {
        return fs.statSync(target);
    } catch (error) {
        return null;
    }
}

function isDirectory(target) {
    const stat = statOrNull(target);
    return Boolean(stat && stat.isDirectory());
}

function realPath(target) {
    try {
        const resolve = fs.realpathSync.native || fs.realpathSync;
        return resolve(target);
    } catch (error) {
        return null;
    }
}

function isInsidePath(root, target) {
    const a = path.resolve(root);
    const b = path.resolve(target);
    if (a === b) {
        return true;
    }
    const prefix = a.endsWith(path.sep) ? a : a + path.sep;
    return b.startsWith(prefix);
}

function toRelativePath(root, target) {
    return path.relative(root, target).split(path.sep).join("/");
}

/**
 * 读文件头部或全文。用 fd 读固定长度，避免先 stat 再 read 之间的竞态，
 * 也避免把一个被截断的巨大文件整块塞进内存。
 */
function readText(file, maxBytes) {
    const limit = Math.min(maxBytes || MAX_SKILL_BYTES, MAX_SKILL_BYTES);
    const buffer = Buffer.alloc(limit);
    const fd = fs.openSync(file, "r");
    try {
        const bytes = fs.readSync(fd, buffer, 0, limit, 0);
        return buffer.subarray(0, bytes).toString("utf8");
    } finally {
        fs.closeSync(fd);
    }
}

// ------------------------------------------------------------
// 元信息解析
// ------------------------------------------------------------

/**
解析可选的 YAML 头（只支持一层 `key: value`，够用且不引依赖）：

    ---
    name: 男频网文写作
    description: 写连载网文时按本文件执行
    tags: 网文, 男频
    ---
*/
function parseFrontMatter(text) {
    const source = typeof text === "string" ? text : "";
    const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
    if (!match) {
        return { meta: {}, body: source };
    }
    const meta = {};
    match[1].split(/\r?\n/).forEach((line) => {
        const pair = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!pair) {
            return;
        }
        let value = pair[2].trim();
        if (
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        }
        meta[pair[1].toLowerCase()] = value;
    });
    return { meta, body: source.slice(match[0].length) };
}

function firstHeading(body) {
    const match = /^#\s+(.+)$/m.exec(body || "");
    return match ? match[1].trim() : "";
}

/** 取某个小标题下的第一段文字（技能文档普遍用"何时使用"交代适用场景）。 */
function extractSection(body, pattern) {
    const lines = String(body || "").split(/\r?\n/);
    const start = lines.findIndex((line) => /^#{2,3}\s+/.test(line) && pattern.test(line));
    if (start === -1) {
        return "";
    }
    const collected = [];
    for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (/^#{1,3}\s+/.test(line) || line.trim() === "---") {
            break;
        }
        if (!line.trim()) {
            if (collected.length) {
                break;
            }
            continue;
        }
        collected.push(line.trim());
    }
    return collected.join(" ");
}

/** 兜底：正文里第一段普通文字（跳过标题、列表、引用、表格）。 */
function firstParagraph(body) {
    const collected = [];
    let started = false;
    for (const line of String(body || "").split(/\r?\n/)) {
        const text = line.trim();
        if (!text) {
            if (started) {
                break;
            }
            continue;
        }
        const structural =
            /^#{1,6}\s/.test(text) ||
            text === "---" ||
            text.startsWith(">") ||
            text.startsWith("|") ||
            text.startsWith("- ") ||
            text.startsWith("* ") ||
            /^\d+\./.test(text);
        if (structural) {
            if (started) {
                break;
            }
            continue;
        }
        started = true;
        collected.push(text);
    }
    return collected.join(" ");
}

/** 列表里要纯文本：去掉行内标记，否则界面上会显示一堆 `**` 和反引号。 */
function stripInlineMarkdown(text) {
    return String(text || "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.*?)\1/g, "$2")
        .replace(/(\*|_)(.+?)\1/g, "$2")
        .replace(/`([^`]*)`/g, "$1");
}

function truncate(text, max) {
    const value = stripInlineMarkdown(text).replace(/\s+/g, " ").trim();
    if (value.length <= max) {
        return value;
    }
    return value.slice(0, Math.max(0, max - 1)) + "…";
}

// ------------------------------------------------------------
// 目录扫描
// ------------------------------------------------------------

/**
存储根：与插件配置同源（`XML_AGENT_STORE_ROOT`，默认 `~/.xml-agent`）。
用户级技能放 `<storeRoot>/skills`，启用状态写 `<storeRoot>/skills.json`。
测试靠这个环境变量重定向，不会碰用户真实目录。
*/
function resolveStoreRoot(options = {}) {
    if (options.storeRoot) {
        return path.resolve(options.storeRoot);
    }
    if (process.env.XML_AGENT_STORE_ROOT) {
        return path.resolve(process.env.XML_AGENT_STORE_ROOT);
    }
    return path.join(options.homeDir || os.homedir(), ".xml-agent");
}

function resolveRoots(options = {}) {
    const projectRoot = options.projectRoot || path.join(__dirname, "..");
    const storeRoot = resolveStoreRoot(options);
    const roots = [
        { source: "builtin", dir: path.join(projectRoot, "skills") },
        { source: "user", dir: path.join(storeRoot, "skills") },
    ];
    if (options.workspace) {
        roots.push({
            source: "workspace",
            dir: path.join(path.resolve(options.workspace), ".agent", "skills"),
        });
    }
    return roots;
}

/** 目录里哪个文件算技能正文：SKILL.md > index.md > <目录名>.md。 */
function findSkillFile(dir, slug) {
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch (error) {
        return null;
    }
    const byLower = new Map();
    names.forEach((name) => {
        const key = name.toLowerCase();
        if (!byLower.has(key)) {
            byLower.set(key, name);
        }
    });
    const candidates = ["skill.md", "index.md", slug.toLowerCase() + ".md"];
    for (const candidate of candidates) {
        const actual = byLower.get(candidate);
        if (!actual) {
            continue;
        }
        const full = path.join(dir, actual);
        const stat = statOrNull(full);
        if (stat && stat.isFile()) {
            return full;
        }
    }
    return null;
}

function scanRoot(root) {
    const entries = [];
    if (!isDirectory(root.dir)) {
        return entries;
    }
    let names = [];
    try {
        names = fs.readdirSync(root.dir);
    } catch (error) {
        return entries;
    }
    names.sort().forEach((name) => {
        const full = path.join(root.dir, name);
        const stat = statOrNull(full);
        if (!stat) {
            return;
        }
        if (stat.isDirectory()) {
            const file = findSkillFile(full, name);
            if (file) {
                entries.push({ source: root.source, slug: name, file });
            }
            return;
        }
        if (!stat.isFile() || !/\.md$/i.test(name)) {
            return;
        }
        // 目录根部的 README 是索引页，不是技能。
        if (name.toLowerCase() === "readme.md") {
            return;
        }
        entries.push({ source: root.source, slug: name.replace(/\.md$/i, ""), file: full });
    });
    return entries;
}

/**
汇集三个来源的全部条目，并标出哪一个"生效"。

不去重是刻意的：把内置技能安装到工作区之后，两份文件都应该留在列表里 ——
用户需要看到"我改的这份覆盖了内置那份"，而且 `builtin:xxx` 这个 id 依然可寻址
（否则刚安装完，同一个技能就变成 404 了，再装一次、删掉重装都会失效）。
`active` 才是"模型实际会用到的那一份"，提示词只列 active 的。
*/
function collectEntries(options = {}) {
    const entries = [];
    resolveRoots(options).forEach((root) => {
        scanRoot(root).forEach((entry) => {
            // 名字里带路径分隔符/非法字符的目录直接跳过：它既拼不出安全的文件名，
            // 也无法通过 id 校验，收进来只会变成删不掉的幽灵条目。
            if (INVALID_SLUG.test(entry.slug) || INVALID_SLUG.test(path.basename(entry.file))) {
                return;
            }
            entries.push({ source: entry.source, slug: entry.slug, file: entry.file });
        });
    });
    const winnerBySlug = new Map();
    entries.forEach((entry) => {
        const current = winnerBySlug.get(entry.slug);
        if (!current || SOURCE_RANK[entry.source] > SOURCE_RANK[current.source]) {
            winnerBySlug.set(entry.slug, entry);
        }
    });
    entries.forEach((entry) => {
        const winner = winnerBySlug.get(entry.slug);
        entry.active = winner === entry;
        entry.shadowedBy = entry.active ? null : winner.source;
    });
    return entries;
}

// ------------------------------------------------------------
// 禁用状态
// ------------------------------------------------------------

function registryPath(options = {}) {
    return path.join(resolveStoreRoot(options), REGISTRY_FILE);
}

function readRegistry(options = {}) {
    try {
        const parsed = JSON.parse(fs.readFileSync(registryPath(options), "utf8"));
        const disabled = Array.isArray(parsed && parsed.disabled)
            ? parsed.disabled.filter((item) => typeof item === "string")
            : [];
        return { disabled };
    } catch (error) {
        // 文件不存在或内容坏掉，都按"全部启用"处理。
        // 不能因为一个坏 JSON 让所有技能从界面上消失。
        return { disabled: [] };
    }
}

function writeRegistry(options, registry) {
    const file = registryPath(options);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = JSON.stringify(registry, null, 4) + "\n";
    const temp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, payload, "utf8");
    try {
        fs.renameSync(temp, file);
    } catch (error) {
        fs.writeFileSync(file, payload, "utf8");
        try {
            fs.unlinkSync(temp);
        } catch (cleanupError) {
            // 临时文件删不掉不影响结果。
        }
    }
}

// ------------------------------------------------------------
// 对外接口
// ------------------------------------------------------------

function parseId(id) {
    const value = String(id || "").trim();
    const separator = value.indexOf(":");
    if (separator <= 0) {
        throw skillError("SKILL_INVALID_ID", "Invalid skill id: " + value);
    }
    const source = value.slice(0, separator);
    const slug = value.slice(separator + 1);
    if (SKILL_SOURCES.indexOf(source) === -1 || !slug || INVALID_SLUG.test(slug)) {
        throw skillError("SKILL_INVALID_ID", "Invalid skill id: " + value);
    }
    return { source, slug, id: source + ":" + slug };
}

function findEntry(id, options = {}) {
    const parsed = parseId(id);
    const entry = collectEntries(options).find(
        (item) => item.slug === parsed.slug && item.source === parsed.source
    );
    if (!entry) {
        throw skillError("SKILL_NOT_FOUND", "Skill not found: " + parsed.id);
    }
    return entry;
}

function describeEntry(entry, options, disabledSet) {
    const id = entry.source + ":" + entry.slug;
    let head = "";
    try {
        head = readText(entry.file, META_READ_BYTES);
    } catch (error) {
        head = "";
    }
    const { meta, body } = parseFrontMatter(head);
    const stat = statOrNull(entry.file);
    const workspace = options.workspace ? path.resolve(options.workspace) : "";
    const absolute = path.resolve(entry.file);
    const readable =
        Boolean(workspace) &&
        isInsidePath(workspace, absolute) &&
        isInsidePath(realPath(workspace) || workspace, realPath(absolute) || absolute);
    return {
        id,
        slug: entry.slug,
        name: meta.name || firstHeading(body) || entry.slug,
        description: truncate(
            meta.description ||
                extractSection(body, /何时使用|when to use/i) ||
                firstParagraph(body),
            MAX_DESCRIPTION_CHARS
        ),
        source: entry.source,
        tags: meta.tags
            ? meta.tags
                  .split(/[,，]/)
                  .map((tag) => tag.trim())
                  .filter(Boolean)
            : [],
        // 绝对路径只用于展示与排查；模型侧只认 workspacePath。
        path: absolute,
        // 模型能看到的路径：只有落在工作区里才非空（read 动作被沙箱限制在工作区）。
        workspacePath: readable ? toRelativePath(workspace, absolute) : null,
        installed: entry.source === "workspace",
        removable: entry.source === "workspace",
        // builtin 打在 app.asar 里：改了下次升级就被覆盖，还可能是只读目录。
        // 想改内置技能的内容，先装到工作区再改那一份。
        editable: entry.source !== "builtin",
        // active=false 表示同名技能在更高优先级来源里有一份，这份不会进提示词。
        active: entry.active !== false,
        shadowedBy: entry.shadowedBy || null,
        size: stat ? stat.size : 0,
        modifiedAt: stat ? stat.mtime.toISOString() : null,
        enabled: !disabledSet.has(id),
    };
}

/** 列出所有技能（含被遮蔽信息与启用状态）。 */
function listSkills(options = {}) {
    const disabledSet = new Set(readRegistry(options).disabled);
    const skills = collectEntries(options).map((entry) =>
        describeEntry(entry, options, disabledSet)
    );
    return skills.sort((left, right) => {
        // 同名的两份排在一起（生效的在前），方便界面上对照
        const byName = left.name.localeCompare(right.name);
        if (byName !== 0) {
            return byName;
        }
        if (left.active !== right.active) {
            return left.active ? -1 : 1;
        }
        return SOURCE_RANK[left.source] - SOURCE_RANK[right.source];
    });
}

/** 读取一个技能的完整文档。 */
function readSkill(id, options = {}) {
    const entry = findEntry(id, options);
    const disabledSet = new Set(readRegistry(options).disabled);
    const skill = describeEntry(entry, options, disabledSet);
    const stat = statOrNull(entry.file);
    const content =
        stat && stat.size > MAX_SKILL_BYTES ? "" : readText(entry.file, MAX_SKILL_BYTES);
    const { meta, body } = parseFrontMatter(content);
    return Object.assign({}, skill, {
        content,
        body,
        frontMatter: meta,
        truncated: Boolean(stat && stat.size > MAX_SKILL_BYTES),
    });
}

/** 启用/禁用。禁用只影响是否出现在首轮提示词里，文件本身不动。 */
function setSkillEnabled(id, enabled, options = {}) {
    const entry = findEntry(id, options);
    const registry = readRegistry(options);
    const disabled = new Set(registry.disabled);
    const key = entry.source + ":" + entry.slug;
    const next = enabled !== false;
    if (next) {
        disabled.delete(key);
    } else {
        disabled.add(key);
    }
    writeRegistry(options, { disabled: Array.from(disabled).sort() });
    return { id: key, enabled: next };
}

/** 文件名安全化：slug 来自目录名，落到磁盘前把非法字符换掉。 */
function safeFileName(slug) {
    const value = String(slug || "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    const trimmed = value.replace(/^\.+/, "").replace(/\.+$/, "");
    return trimmed || "skill";
}

/**
把技能复制进工作区的 `.agent/skills/`。

为什么需要：`read` 动作被沙箱限制在工作区内，安装包里的 builtin 技能
（`<安装目录>/resources/app.asar/skills/...`）和 `~/.xml-agent/skills` 下的
用户技能，模型都读不到。安装一份到工作区是唯一安全的方式。
*/
function installSkill(id, workspace, options = {}) {
    if (!workspace || typeof workspace !== "string") {
        throw skillError("WORKSPACE_REQUIRED", "Workspace is required");
    }
    const targetWorkspace = path.resolve(workspace);
    if (!isDirectory(targetWorkspace)) {
        throw skillError("WORKSPACE_NOT_FOUND", "Workspace does not exist: " + targetWorkspace);
    }
    const entry = findEntry(id, Object.assign({}, options, { workspace: targetWorkspace }));
    const targetDir = path.join(targetWorkspace, ".agent", "skills");
    const target = path.join(targetDir, safeFileName(entry.slug) + ".md");
    const relativePath = toRelativePath(targetWorkspace, target);
    if (path.resolve(entry.file) === path.resolve(target)) {
        return {
            id,
            installed: false,
            alreadyInstalled: true,
            path: target,
            workspacePath: relativePath,
            message: "Skill is already in this workspace",
        };
    }
    const content = fs.readFileSync(entry.file);
    fs.mkdirSync(targetDir, { recursive: true });
    const overwritten = fs.existsSync(target);
    fs.writeFileSync(target, content);
    return {
        id,
        installed: true,
        alreadyInstalled: false,
        overwritten,
        path: target,
        workspacePath: relativePath,
        message: overwritten ? "Skill updated in workspace" : "Skill installed to workspace",
    };
}

/** 从工作区移除技能（只允许删 `<workspace>/.agent/skills/` 下的文件）。 */
function removeSkill(id, workspace, options = {}) {
    if (!workspace || typeof workspace !== "string") {
        throw skillError("WORKSPACE_REQUIRED", "Workspace is required");
    }
    const targetWorkspace = path.resolve(workspace);
    const entry = findEntry(id, Object.assign({}, options, { workspace: targetWorkspace }));
    if (entry.source !== "workspace") {
        throw skillError("SKILL_NOT_REMOVABLE", "Only workspace skills can be removed: " + id);
    }
    const skillsRoot = path.join(targetWorkspace, ".agent", "skills");
    const realRoot = realPath(skillsRoot) || skillsRoot;
    const realFile = realPath(entry.file) || entry.file;
    if (!isInsidePath(realRoot, realFile)) {
        throw skillError("SKILL_NOT_REMOVABLE", "Skill is outside the workspace skills directory");
    }
    fs.unlinkSync(realFile);
    const registry = readRegistry(options);
    const disabled = registry.disabled.filter((item) => item !== entry.source + ":" + entry.slug);
    if (disabled.length !== registry.disabled.length) {
        writeRegistry(options, { disabled });
    }
    return { id, removed: true, path: realFile };
}

/**
就地改写技能文档。

只允许改 user 与 workspace 两层：builtin 打在 `app.asar` 里，改了下次升级就被覆盖，
安装目录还可能只读 —— 写进去只会让人误以为改生效了。要改内置技能，先安装到工作区。

整篇覆盖，不做局部替换：技能文档本来就是一个自包含的整体，逐行 patch 反而更容易
把 front matter 和正文拼出矛盾。长度上限沿用 MAX_SKILL_BYTES。

写回位置严格限制在该条目原本所属的那一层根目录内。符号链接指到目录外时会被拦下 ——
否则一次 PUT 就能借技能文档改写工作区里的任意文件。
*/
function writeSkill(id, content, options = {}) {
    if (typeof content !== "string") {
        throw skillError("SKILL_INVALID_CONTENT", "Skill content must be a string");
    }
    const entry = findEntry(id, options);
    if (entry.source === "builtin") {
        throw skillError(
            "SKILL_READONLY",
            "Built-in skills are read-only. Install it to the workspace first, then edit that copy."
        );
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SKILL_BYTES) {
        throw skillError(
            "SKILL_TOO_LARGE",
            "Skill document is " + bytes + " bytes, limit is " + MAX_SKILL_BYTES
        );
    }
    const root = resolveRoots(options).find((item) => item.source === entry.source);
    const rootDir = root ? realPath(root.dir) || root.dir : "";
    const target = realPath(entry.file) || entry.file;
    if (!rootDir || !isInsidePath(rootDir, target)) {
        throw skillError("SKILL_READONLY", "Skill file is outside its source directory: " + id);
    }
    fs.writeFileSync(target, content, "utf8");
    const stat = statOrNull(target);
    return {
        id: entry.source + ":" + entry.slug,
        path: target,
        size: stat ? stat.size : bytes,
        modifiedAt: stat ? stat.mtime.toISOString() : null,
        message: "Skill updated",
    };
}

module.exports = {
    SKILL_SOURCES,
    MAX_SKILL_BYTES,
    parseFrontMatter,
    parseId,
    listSkills,
    readSkill,
    writeSkill,
    setSkillEnabled,
    installSkill,
    removeSkill,
    // 供测试与内部使用
    resolveRoots,
    collectEntries,
    readRegistry,
};
