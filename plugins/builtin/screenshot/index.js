/**
 * 内置插件：screenshot（action）
 *
 * 从内建动作迁入插件（P2，v1.1.0）：实现与迁移前逐行一致，只是执行上下文从
 * `ctx.runtime` 换成了插件能拿到的能力门面：
 *
 * | 迁移前                | 迁移后                          |
 * | --------------------- | ------------------------------- |
 * | runtime.getWorkspace()| ctx.workspace                   |
 * | runtime.resolvePath() | ctx.fs.resolve()（同一套越界保护）|
 * | logger                | ctx.logger（带 [plugin:screenshot] 前缀）|
 *
 * 因此"截图"现在是一个可以被单独启停、单独授权（system:screen / system:window）、
 * 单独审计的插件能力，而不是写死在 Runtime 里的第 6 个动作。
 *
 * 注意：`activation: "manual"` —— 该动作的用法文档已经写在系统提示词里
 * （prompts/system-prompt.js），不再由插件提示词区块重复注入，避免提示词膨胀。
 *
 * 本次落地后新增的一致性：
 * - 通过权限面板 deny `system:screen` 即可整体关闭截图能力；
 * - 失败/成功都带 plugin 与 durationMs，审计日志里能看出它是插件动作。
 */

// 截图引擎随插件走（engine/），核心目录不再有截图实现。
// 这样删掉整个插件目录即可彻底移除这项能力，内核不留残骸。
const { takeScreenshot } = require("./engine/take-screenshot");
const actionSchemas = require("../../../parse/action-schema");
const SCREENSHOT_SCHEMA =
    actionSchemas.SCREENSHOT_SCHEMA || actionSchemas.BUILTIN_ACTION_SCHEMAS.screenshot;

/**
 * 收集结果里所有可上传的图片路径（相对 workspace）。
 * 兼容单图（result.path）与多图（result.paths / result.results）。
 * Agent 通过动作声明的 meta.collectImages 调用它，因此"上传给模型"这条通道
 * 对内置插件与第三方插件是同一套。
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

// 执行单个截图目标。参数已经由 JSON Schema 校验并补全默认值。
async function captureOneTarget(env, target) {
    const source = target.source;
    const requestedPath = target.path;
    const windowTitle = target.windowTitle || target.title || null;
    // 若显式指定路径，先做 workspace 越界校验，避免写到工作区之外。
    if (requestedPath) {
        env.resolve(requestedPath);
    }
    const result = await takeScreenshot({
        workspace: env.workspace,
        path: requestedPath,
        source,
        url: target.url,
        selector: target.selector,
        fullPage: target.fullPage,
        windowTitle,
    });
    if (!result.ok) {
        return {
            ok: false,
            source,
            path: requestedPath || null,
            windowTitle,
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
    schema: SCREENSHOT_SCHEMA,
    async run(params, ctx) {
        const env = {
            workspace: ctx.workspace,
            resolve: (target) => ctx.fs.resolve(target),
        };
        const logger = ctx.logger;
        const targets = params.targets;
        logger.info("Capturing " + targets.length + " screenshot target(s)");

        // 保留旧的结果结构：单目标返回单图字段，多目标返回 results / paths 汇总。
        if (targets.length === 1) {
            const target = targets[0];
            const source = target.source;
            const requestedPath = target.path;
            try {
                // 越界路径先拦下来。插件执行器会把异常转成结构化失败。
                if (requestedPath) {
                    env.resolve(requestedPath);
                }
                const result = await captureOneTarget(env, target);
                if (!result.ok) {
                    return {
                        ok: false,
                        action: "screenshot",
                        source,
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
                    source,
                    error: error.message,
                };
            }
        }

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
                    index,
                    source: target.source,
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
            results,
            paths: succeeded.map((item) => item.path),
        };
    },
    meta: {
        prompt: {
            group: "system",
            usage: '{"action":"screenshot","params":{"targets":[{"source":"window","windowTitle":"Visual Studio Code","path":"screenshots/vscode.png"},{"source":"screen","path":"screenshots/desktop.png"}]}}',
            note:
                "params.targets 是 1-8 个目标对象的数组，可截取桌面 / 指定窗口 / CDP 浏览器页面；" +
                "window 来源必须提供 windowTitle 或 title，path 必须是相对 Workspace 的路径，省略时存到 screenshots/。",
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
    },
};

function setup(ctx) {
    ctx.actions.register(ACTION);
}

module.exports = {
    setup,
};
