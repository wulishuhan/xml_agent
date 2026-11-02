/**
XML 协议用到的字符常量（叶子模块，不依赖任何项目内模块）

单独成文件的原因：内置动作的 fastPath（手写快速解析器）也需要这些常量，
而 parse/xml-parse.js 又要（惰性）require 内置动作表，直接互相 require 会形成循环。
把它们下沉成叶子模块后，依赖图是单向的：
    xml-chars / xml-text  ←  xml-parse  ←  actions  ←  runtime
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
