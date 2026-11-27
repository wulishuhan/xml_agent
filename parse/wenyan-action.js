/**
 * 文言文动作协议解析器（实验协议 wenyan）
 *
 * 格式：一次回复只给一个动作。首字为动词，字段以空格或 ｜（半角 |）分隔，
 * 正文裹以「」（可含换行，勿含 」）。紧凑写法与 ｜ 写法等价：
 *
 *   阅 a.js                          观文件或目录
 *   阅 a.js 100 4000                  续读：带偏移与上限
 *   书 a.js「console.log(1);」        新建或整体重写
 *   改 a.js「旧」「新」 全            局部更易，多组并列；全=全部替换
 *   行 npm test                      执行命令
 *   摄 screen shot.png               截图
 *   答「最终答复」                    给用户的话
 *   毕                               事竟
 *
 * 旧写法（阅｜a.js｜100｜4000 等）继续兼容。
 *
 * 设计取舍：不另建 schema，参数校验直接复用 BUILTIN_ACTION_SCHEMAS，
 * 因此与 xml/json 共用一个执行层，行为完全一致；本文件只负责"文言 → {action, params}"。
 */

const { BUILTIN_ACTION_SCHEMAS, validateParams } = require("./action-schema");

/** 单字动词 → 内置动作名。 */
const VERB_TO_ACTION = Object.freeze({
    阅: "read", // 观
    书: "write", // 写
    改: "edit", // 易
    行: "exec", // 行
    摄: "screenshot", // 照
    答: "answer", // 对
    毕: "done", // 竟
});

function toInt(value) {
    const n = Number(String(value).trim());
    return Number.isFinite(n) ? Math.trunc(n) : value;
}

/**
 * 把模型回复解析为 { action, params }（或抛错）。
 * @param {string} response 模型本轮回复
 */
function extractWenyanAction(response) {
    let src = String(response === undefined || response === null ? "" : response).trim();

    // 容忍模型给动作套 ``` 围栏（有些平台会吞裸动词，模型自发加围栏）
    if (src.startsWith("```")) {
        src = src
            .replace(/^```[A-Za-z]*\s*/, "")
            .replace(/\s*```\s*$/, "")
            .trim();
    }
    if (!src) {
        throw new Error("returned empty response");
    }

    // 先把所有「正文」抠出来（非贪婪、跨行），换成空串，剩下的就是"动词｜参数"骨架。
    // 这样正文里即使含 ｜ 或换行也不会被切碎。
    const quoted = [];
    const head = src.replace(/「([\s\S]*?)」/g, (_match, content) => {
        quoted.push(content);
        return "";
    });

    const fields = head.split(/[｜|]/).map((s) => s.trim());
    const first = fields[0] || "";
    const verb = first.charAt(0);
    const action = VERB_TO_ACTION[verb];
    if (!action) {
        throw new Error("Unknown Wenyan Action: " + (first || src.slice(0, 12)));
    }

    // 动词后的同字段残片。紧凑写法（无 ｜）按空白拆参数，省掉分隔符：
    //   阅 a.js 100 4000 / 摄 screen shot.png / 改 a.js「旧」「新」 全
    // 行（exec）例外：整串都是命令，不能拆。旧 ｜ 写法与「动词+空格+单参数」保持不变。
    const parts = [];
    const rest = first.slice(1).trim();
    const compact = fields.length === 1 && /\s/.test(rest);
    if (rest) {
        if (
            compact &&
            (action === "read" || action === "write" || action === "edit" || action === "screenshot")
        ) {
            parts.push(...rest.split(/\s+/).filter(Boolean));
        } else {
            parts.push(rest);
        }
    }
    for (let i = 1; i < fields.length; i += 1) {
        parts.push(fields[i]);
    }
    // 「」被替换成空串后留下的空字段，从尾部去掉
    while (parts.length && parts[parts.length - 1] === "") {
        parts.pop();
    }

    let params;
    switch (action) {
        case "read": {
            params = { path: parts[0] };
            if (parts[1] !== undefined && parts[1] !== "") {
                params.offset = toInt(parts[1]);
            }
            if (parts[2] !== undefined && parts[2] !== "") {
                params.limit = toInt(parts[2]);
            }
            break;
        }
        case "write": {
            params = {
                path: parts[0],
                content: quoted.length ? quoted[0] : "",
            };
            break;
        }
        case "edit": {
            const changes = [];
            for (let i = 0; i + 1 < quoted.length; i += 2) {
                changes.push({ old: quoted[i], new: quoted[i + 1] });
            }
            params = { path: parts[0], changes };
            // 「全」表示 all=true
            if (parts.indexOf("全") !== -1) {
                params.all = true;
            }
            break;
        }
        case "exec": {
            // 命令里可能含 ｜，还原时以 ｜ 拼接（提示词里约定命令放在最后一个字段）
            params = { command: joinParts(parts) };
            break;
        }
        case "screenshot": {
            const target = { source: parts[0] || "screen" };
            if (parts[1]) {
                target.path = parts[1];
            }
            if (parts[2]) {
                if (target.source === "window") {
                    target.windowTitle = parts[2];
                } else if (target.source === "browser_page") {
                    target.url = parts[2];
                }
            }
            params = { targets: [target] };
            break;
        }
        case "answer": {
            params = { content: quoted.length ? quoted[0] : joinParts(parts) };
            break;
        }
        case "done":
        default: {
            params = {};
            break;
        }
    }

    const checked = validateParams(BUILTIN_ACTION_SCHEMAS[action], params);
    if (!checked.ok) {
        throw new Error(checked.error);
    }
    return { action, params: checked.value };
}

function joinParts(parts) {
    return parts.join("｜");
}

module.exports = {
    extractWenyanAction,
    VERB_TO_ACTION,
};
