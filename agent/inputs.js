/**
输入归一化

用户任务可能带一组图片路径（相对 workspace 或绝对路径）。
这里只做「去空、去重、限数、保序」，不碰文件系统 —— 是否存在由上游校验。
*/

const MAX_PRESET_IMAGES = 8;

function normalizePresetImages(raw) {
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

        if (images.length >= MAX_PRESET_IMAGES) {
            break;
        }
    }

    return images;
}

module.exports = {
    MAX_PRESET_IMAGES,
    normalizePresetImages,
};
