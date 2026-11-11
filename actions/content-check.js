/**
写入前的内容校验（write / edit 共用）

只校验能被确定性判定的类型：JSON 写坏了，后续所有依赖它的命令都会失败，
而 JSON.parse 给出的位置信息正好是模型能立刻用上的线索。
其它类型（js / md …）不做语法检查 —— 那要靠 exec 跑一次才知道，
在这里猜只会产生假阳性。
*/

function validateContent(filePath, content) {
    if (filePath.endsWith(".json")) {
        try {
            JSON.parse(content);
        } catch (error) {
            throw new Error("Invalid JSON content: " + error.message);
        }
    }
}

module.exports = {
    validateContent,
};
