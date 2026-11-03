/**
 * 产物回传通道

动作执行后可能产出文件（当前的 screenshot，将来的录音 / 导出物 / 报表）。
本模块负责两件事，都不属于编排循环本身：

1. collect(result)      —— 按动作声明的 meta.collectImages 收集产物路径；
2. upload(result)       —— 把产物上传给当前 provider，让模型下一轮能"看到"它们。

另外 uploadPreset(images) 处理用户随任务附带的图片，与 upload 共用同一套
"失败不阻断主流程"的约定。

与 Agent 的关系是依赖注入而非继承：Agent 只提供四个能力
（解析动作定义 / 取当前 provider / 相对转绝对 / 发事件），因此本模块可以用
假 provider 单测，不必启动浏览器或 HTTP 服务。

关于事件名：沿用 screenshot.uploaded / screenshot.upload_error。这两个名字
诞生时只有截图需要回传，如今通道已泛化，但既有测试与前端按此订阅，
改名收益低于破坏面，因此保留并在调用处注明。
*/

const fs = require("fs");

/**
 * @param {object} deps
 * @param {(name: string) => object|null} deps.resolveActionDefinition 动作名 → 定义（内置 + 插件）
 * @param {() => object|null} deps.getProvider 取当前 provider 实例
 * @param {(p: string) => string} deps.toAbsolutePath 相对 workspace 路径转绝对路径
 * @param {(type: string, data: object) => void} deps.emit 事件出口
 * @param {() => number} deps.getStep 当前步数（仅用于事件）
 */
function createArtifactsChannel(deps = {}) {
    const resolveActionDefinition = deps.resolveActionDefinition || (() => null);
    const getProvider = deps.getProvider || (() => null);
    const toAbsolutePath = deps.toAbsolutePath || ((target) => target);
    const emit = deps.emit || (() => {});
    const getStep = deps.getStep || (() => 0);

    /**
     * 由动作定义上的 meta.collectImages 决定要回传哪些产物。
     * 编排器不认识具体动作名，新增动作只要声明 collectImages 就能自动获得回传能力。
     */
    function collect(result) {
        if (!result || typeof result !== "object") {
            return [];
        }
        const definition = resolveActionDefinition(result.action);
        const collectFn = definition && definition.meta ? definition.meta.collectImages : null;
        if (typeof collectFn !== "function") {
            return [];
        }
        try {
            const paths = collectFn(result);
            return Array.isArray(paths) ? paths : [];
        } catch (error) {
            // 单个动作的收集函数出错不影响主流程，视为没有产物。
            return [];
        }
    }

    /**
     * 把产物上传给 provider。任何失败只记录在结果与事件里，不抛错、不中断任务。
     */
    async function upload(result) {
        if (!result || !result.ok) {
            return result;
        }
        const relativePaths = collect(result);
        if (relativePaths.length === 0) {
            result.uploaded = false;
            return result;
        }
        const provider = getProvider();
        if (!provider || typeof provider.uploadImages !== "function") {
            result.uploaded = false;
            return result;
        }
        const absolutePaths = relativePaths.map((relativePath) => toAbsolutePath(relativePath));
        try {
            const uploadResult = await provider.uploadImages(absolutePaths);
            result.uploaded = uploadResult && uploadResult.ok !== false;
            result.uploadCount = uploadResult && uploadResult.count ? uploadResult.count : 0;
            result.uploadedPaths = relativePaths;
            emit("screenshot.uploaded", {
                step: getStep(),
                action: result.action,
                path: relativePaths[0],
                paths: relativePaths,
                uploaded: result.uploaded,
                uploadCount: result.uploadCount,
            });
        } catch (error) {
            result.uploaded = false;
            result.uploadError = error.message;
            emit("screenshot.upload_error", {
                step: getStep(),
                action: result.action,
                path: relativePaths[0],
                paths: relativePaths,
                error: error.message,
            });
        }
        return result;
    }

    /**
     * 上传用户随任务附带的图片（第一条 prompt 之前执行）。
     * 失败只记录事件，不阻断任务——模型仍可继续处理文本任务。
     */
    async function uploadPreset(images) {
        const list = Array.isArray(images) ? images : [];
        if (!list.length) {
            return;
        }
        const provider = getProvider();
        if (!provider || typeof provider.uploadImages !== "function") {
            emit("images.upload_skipped", {
                reason: "provider does not support image upload",
                count: list.length,
            });
            return;
        }
        const existing = [];
        const missing = [];
        for (const item of list) {
            const absolute = toAbsolutePath(item);
            if (fs.existsSync(absolute)) {
                existing.push(absolute);
            } else {
                missing.push(item);
            }
        }
        if (missing.length) {
            emit("images.missing", {
                count: missing.length,
                paths: missing,
            });
        }
        if (!existing.length) {
            return;
        }
        try {
            const uploadResult = await provider.uploadImages(existing);
            emit("images.uploaded", {
                count: existing.length,
                uploaded: uploadResult && uploadResult.ok !== false,
                uploadCount: uploadResult && uploadResult.count ? uploadResult.count : 0,
                paths: list,
            });
        } catch (error) {
            emit("images.upload_error", {
                count: existing.length,
                error: error.message,
            });
        }
    }

    return {
        collect,
        upload,
        uploadPreset,
    };
}

module.exports = {
    createArtifactsChannel,
};
