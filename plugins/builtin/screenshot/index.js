/**
内置插件：screenshot（action）

从内建动作迁入插件（P2，v1.1.0）：实现与迁移前逐行一致，只是执行上下文从
`ctx.runtime` 换成了插件能拿到的能力门面：

| 迁移前                | 迁移后                          |
| --------------------- | ------------------------------- |
| runtime.getWorkspace()| ctx.workspace                   |
| runtime.resolvePath() | ctx.fs.resolve()（同一套越界保护）|
| logger                | ctx.logger（带 [plugin:screenshot] 前缀）|

因此"截图"现在是一个可以被单独启停、单独授权（system:screen / system:window）、
单独审计的插件能力，而不是写死在 Runtime 里的第 6 个动作。

注意：`activation: "manual"` —— 该动作的用法文档已经写在系统提示词里
（prompts/system-prompt.js），不再由插件提示词区块重复注入，避免提示词膨胀。

本次落地后新增的一致性：
- 通过权限面板 deny `system:screen` 即可整体关闭截图能力；
- 失败/成功都带 plugin 与 durationMs，审计日志里能看出它是插件动作。
*/

// 截图引擎随插件走（engine/），核心目录不再有截图实现。
// 这样删掉整个插件目录即可彻底移除这项能力，内核不留残骸。
const { takeScreenshot } = require("./engine/take-screenshot");
const { normalizeScreenshotTargets } = require("../../../parse/xml-parse");
const { CHAR_LT, CHAR_GT, CHAR_SLASH } = require("../../../parse/xml-chars");

const SOURCES = ["browser_page", "screen", "window"];
const MAX_TARGETS = 8;

/**
手写解析自闭合的 screenshot 动作：<screenshot source="screen" path="a.png"/>
仅处理"无子节点"的旧写法；带 <target> 子节点的多目标写法交给完整 XML 解析器。
*/
function tryExtractScreenshotManually(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    const OPEN = CHAR_LT + "screenshot";
    const GT = CHAR_GT;
    const SELF_CLOSE = CHAR_SLASH + GT;
    if (trimmed.indexOf(OPEN) !== 0) return null;
    if (
        !trimmed.endsWith(SELF_CLOSE) &&
        !trimmed.endsWith(CHAR_LT + CHAR_SLASH + "screenshot" + GT)
    ) {
        return null;
    }
    const firstGt = trimmed.indexOf(GT);
    if (firstGt === -1) return null;
    // 存在子节点（如 <target .../>）时不在手动解析里处理。
    const inner = trimmed.substring(firstGt + 1);
    if (inner && inner.trim() && inner.trim().indexOf(CHAR_LT) === 0) {
        return null;
    }
    let attrText = trimmed.substring(OPEN.length, firstGt);
    if (attrText.endsWith(CHAR_SLASH)) {
        attrText = attrText.substring(0, attrText.length - 1);
    }
    const node = {};
    const attrPattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = attrPattern.exec(attrText)) !== null) {
        node["@_" + match[1]] = match[2];
    }
    return {
        action: "screenshot",
        node: node,
    };
}

function validateScreenshotTarget(target, index) {
    const label = "screenshot target[" + index + "]";
    if (!target || typeof target !== "object") {
        throw new Error(label + " is invalid");
    }
    const source = target["@_source"];
    if (!source) {
        throw new Error(label + " requires source (browser_page | screen | window)");
    }
    if (SOURCES.indexOf(source) === -1) {
        throw new Error(label + " source must be one of: browser_page, screen, window");
    }
    if (source === "window" && !target["@_windowTitle"] && !target["@_title"]) {
        throw new Error(label + " source=window requires windowTitle");
    }
}

function validateScreenshot(node) {
    if (!node || typeof node !== "object") {
        throw new Error("screenshot action is invalid");
    }
    const targets = normalizeScreenshotTargets(node);
    // 多目标写法：<screenshot><target .../><target .../></screenshot>
    if (targets.length > 0) {
        targets.forEach(function (target, index) {
            validateScreenshotTarget(target, index);
        });
        if (targets.length > MAX_TARGETS) {
            throw new Error(
                "screenshot supports at most " +
                    MAX_TARGETS +
                    " targets per action, got " +
                    targets.length
            );
        }
        return;
    }
    // 旧写法：<screenshot source="..." path="..."/>
    const source = node["@_source"];
    if (!source) {
        throw new Error("screenshot requires source (browser_page | screen | window)");
    }
    if (SOURCES.indexOf(source) === -1) {
        throw new Error("screenshot source must be one of: browser_page, screen, window");
    }
    if (source === "window" && !node["@_windowTitle"] && !node["@_title"]) {
        throw new Error("screenshot source=window requires windowTitle");
    }
}

/**
收集结果里所有可上传的图片路径（相对 workspace）。
兼容单图（result.path）与多图（result.paths / result.results）。
Agent 通过动作声明的 meta.collectImages 调用它，因此"上传给模型"这条通道
对内置插件与第三方插件是同一套。
*/
function collectImages(result) {
    const relativePaths = [];
    if (Array.isArray(result.paths)) {
        for (const item of result.paths) {
            if (item && relativePaths.indexOf(item) === -1) {
                relativePaths.push(item);
            }
        }
    }
    if (relativePaths.length === 0 && Array.isArray(result.results)) {
        for (const item of result.results) {
            if (item && item.ok && item.path && relativePaths.indexOf(item.path) === -1) {
                relativePaths.push(item.path);
            }
        }
    }
    if (relativePaths.length === 0 && result.path) {
        relativePaths.push(result.path);
    }
    return relativePaths;
}

// 执行单个截图目标。target 既可以是 <target> 节点，也可以是旧的 screenshot 根节点。
async function captureOneTarget(env, target) {
    const source = target?.["@_source"] || "screen";
    const requestedPath = target?.["@_path"];
    // 若显式指定路径，先做 workspace 越界校验，避免写到工作区之外。
    if (requestedPath) {
        env.resolve(requestedPath);
    }
    const result = await takeScreenshot({
        workspace: env.workspace,
        path: requestedPath,
        source: source,
        url: target?.["@_url"],
        selector: target?.["@_selector"],
        fullPage: target?.["@_fullPage"] === "true",
        windowTitle: target?.["@_windowTitle"] || target?.["@_title"],
    });
    if (!result.ok) {
        return {
            ok: false,
            source: source,
            path: requestedPath || null,
            windowTitle: target?.["@_windowTitle"] || target?.["@_title"] || null,
            error: result.error || "screenshot failed",
        };
    }
    return {
        ok: true,
        source: result.source,
        path: result.path,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        note: result.note,
    };
}

const ACTION = {
    name: "screenshot",
    // 属性校验走自定义 validate（screenshot 的规则比 schema 表达能力复杂：多 target、按 source 分支）
    schema: null,
    validate: validateScreenshot,
    async run(node, ctx) {
        const env = {
            workspace: ctx.workspace,
            resolve: (target) => ctx.fs.resolve(target),
        };
        const logger = ctx.logger;
        const targets = normalizeScreenshotTargets(node);
        // 多目标写法：<screenshot><target .../><target .../></screenshot>
        if (targets.length > 0) {
            logger.info("Capturing " + targets.length + " screenshot target(s)");
            const results = [];
            for (let index = 0; index < targets.length; index += 1) {
                const target = targets[index];
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const result = await captureOneTarget(env, target);
                    result.index = index;
                    results.push(result);
                } catch (error) {
                    results.push({
                        ok: false,
                        index: index,
                        source: target?.["@_source"] || "screen",
                        error: error.message,
                    });
                }
            }
            const succeeded = results.filter((item) => item.ok);
            const failed = results.filter((item) => !item.ok);
            // 全部失败才算整个动作失败；部分成功时把失败项也返回给模型。
            return {
                ok: succeeded.length > 0,
                action: "screenshot",
                multi: true,
                count: results.length,
                succeeded: succeeded.length,
                failed: failed.length,
                results: results,
                paths: succeeded.map((item) => item.path),
            };
        }
        // 旧写法：单个 screenshot 目标
        const source = node?.["@_source"] || "screen";
        const requestedPath = node?.["@_path"];
        logger.info("Capturing screenshot:", source, requestedPath || "(default)");
        try {
            // 越界路径先拦下来。注意：迁移前这里故意把校验放在 try 之外（像 read/write 一样抛栈），
            // 但插件动作的执行统一由 registry 兜底（抛栈会被转成 { ok:false, error }），
            // 因此这里直接按插件契约返回结构化失败，行为更可预期。
            if (requestedPath) {
                env.resolve(requestedPath);
            }
            const result = await captureOneTarget(env, node);
            if (!result.ok) {
                return {
                    ok: false,
                    action: "screenshot",
                    source: source,
                    error: result.error || "screenshot failed",
                };
            }
            return {
                ok: true,
                action: "screenshot",
                source: result.source,
                path: result.path,
                width: result.width,
                height: result.height,
                bytes: result.bytes,
                note: result.note,
            };
        } catch (error) {
            logger.error("Screenshot failed:", error.message);
            return {
                ok: false,
                action: "screenshot",
                source: source,
                error: error.message,
            };
        }
    },
    meta: {
        prompt: {
            group: "system",
            usage: '<screenshot>\n  <target source="window" windowTitle="Visual Studio Code" path="screenshots/vscode.png"/>\n  <target source="screen" path="screenshots/desktop.png"/>\n</screenshot>',
            note:
                "截取桌面 / 指定窗口 / CDP 浏览器页面，一次最多 8 个 target；" +
                "path 必须是相对 Workspace 的路径，省略时存到 screenshots/。",
            priority: 80,
        },
        permission: ["system:screen", "system:window"],
        mutating: true,
        timeoutMs: 300000,
        summary: (result) =>
            "screenshot " +
            (result.count ? result.succeeded + "/" + result.count : result.source || "") +
            (result.path ? " " + result.path : ""),
        collectImages,
        fastPath: tryExtractScreenshotManually,
    },
};

function setup(ctx) {
    ctx.actions.register(ACTION);
}

module.exports = {
    setup,
    // 供测试与 parse 层复用
    validateScreenshot,
    tryExtractScreenshotManually,
};
