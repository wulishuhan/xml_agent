/**
WebUI 请求入参归一化（从 server.js 提取）

两个纯函数：
- normalizeConversationId：把"纯 id"或"完整会话 URL"规范化为 conversationId，
  正则来自各 provider 自己声明的元数据（providers/<name>.js 的 meta.conversationIdPattern）。
- normalizeImages：用户随任务附带的图片路径去重、去空、限 8 张。

提取出来是为了让路由模块（webui/routes/*.js）共用同一份实现，
server.js 只需要把它们继续 re-export 出去（保持既有调用方兼容）。
*/

const providers = require("../providers");

const MAX_IMAGES = 8;

/**
规范化用户传入的 images：只接受相对 workspace 的路径或绝对路径字符串数组。
上限 8 张，非法项直接丢弃，避免恶意/脏数据进入 Agent。
*/
function normalizeImages(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const images = [];
    for (const item of raw) {
        if (typeof item !== "string") {
            continue;
        }
        const trimmed = item.trim();
        if (!trimmed) {
            continue;
        }
        if (images.indexOf(trimmed) === -1) {
            images.push(trimmed);
        }
        if (images.length >= MAX_IMAGES) {
            break;
        }
    }
    return images;
}

/**
把用户传入的 conversationId 规范化。
允许的输入：
1. 纯 conversation id，例如 9efa4714-38db-4038-a971-226570f7155d
2. 完整的会话 URL，例如 https://chat.deepseek.com/a/chat/s/<id>
以下情况返回 null（表示按新会话处理）：
- 空字符串
- 是一个 URL 但无法提取出会话 id（例如新会话入口 https://chat.deepseek.com）
*/
function normalizeConversationId(provider, raw) {
    return providers.normalizeConversationId(provider, raw);
}

module.exports = {
    MAX_IMAGES,
    normalizeImages,
    normalizeConversationId,
};
