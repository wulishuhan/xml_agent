/**
XML 协议用到的字符常量（叶子模块，不依赖任何项目内模块）

单独成文件是为了让 xml-parser 与 xml-text 共用同一套字符，而不产生循环依赖。
*/

const CHAR_LT = String.fromCharCode(60);
const CHAR_GT = String.fromCharCode(62);
const CHAR_SLASH = String.fromCharCode(47);
const CHAR_BANG = String.fromCharCode(33);
const CHAR_LBRACK = String.fromCharCode(91);
const CHAR_RBRACK = String.fromCharCode(93);
const CHAR_DQUOTE = String.fromCharCode(34);
const CHAR_TICK = String.fromCharCode(96);
const FENCE = CHAR_TICK + CHAR_TICK + CHAR_TICK;

module.exports = {
    CHAR_LT,
    CHAR_GT,
    CHAR_SLASH,
    CHAR_BANG,
    CHAR_LBRACK,
    CHAR_RBRACK,
    CHAR_DQUOTE,
    CHAR_TICK,
    FENCE,
};
