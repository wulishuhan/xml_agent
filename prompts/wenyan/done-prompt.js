/**
 * 文言文协议收尾提示词（实验协议 wenyan）
 * 答案已给用户后，再要一轮结束动作。
 */
function getDonePrompt() {
    return `
答案已达。此轮只书：
毕
`;
}

module.exports = {
    getDonePrompt,
};
