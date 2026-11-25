function getDonePrompt() {
    return `
答案已经给用户看过了。这一轮不要再说别的，也不要再调用动作，只输出：
{"action":"done","params":{}}
`;
}

module.exports = {
    getDonePrompt,
};
