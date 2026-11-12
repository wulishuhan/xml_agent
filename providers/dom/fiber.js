/**
在浏览器上下文里运行的 React fiber 扫描器。

这里的函数会被 Playwright 序列化后送进页面执行（`elementHandle.evaluate(fn)`），
因此它们**必须自包含**：不能引用模块作用域的变量、常量或 require 的结果。
action 标签清单同样不能在页面里 require，但可以传参 ——
调用方把 `getActionTagNames()`（内置 ∪ 插件动作）当第二个参数传进来，
不传时退回内置动作清单。

两种扫描策略对应两类页面：

- `collectFiberCandidates`：三向 BFS（child / sibling / return）。
  DeepSeek 与 GLM 使用，能覆盖被虚拟列表包住的历史消息。
- `collectChildFiberCandidate`：只向下走 child。
  Qwen 使用。它曾因三向遍历爬到更早的对话节点，抓到上一条甚至用户 prompt，
  所以收窄成"只看当前消息自身子树"。
*/

/**
三向 BFS 收集候选字符串，按"是否含 Action > 深度浅 > 长度"打分排序。
返回最多 8 条去重候选。

`actionTagNames` 由调用方传入：插件动作是开放集合，页面里没法 require，
只能在 evaluate 时把清单当参数送进来（不传就用内置动作兜底）。
*/
function collectFiberCandidates(element, actionTagNames) {
    const actionTags =
        Array.isArray(actionTagNames) && actionTagNames.length
            ? actionTagNames
            : ["write", "edit", "read", "exec", "answer", "done", "screenshot"];

    const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber"));
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps"));

    if (!fiberKey && !propsKey) {
        return [];
    }

    const candidates = [];
    const seen = new Set();
    const objectSeen = new Set();
    const MAX_NODES = 2500;
    const MAX_DEPTH = 40;

    function containsAction(value) {
        for (const tag of actionTags) {
            if (value.indexOf("<" + tag) !== -1) {
                return true;
            }
        }

        return false;
    }

    function addCandidate(value, source, key, depth) {
        if (typeof value !== "string") {
            return;
        }

        const trimmed = value.trim();

        if (!trimmed) {
            return;
        }

        const action = containsAction(trimmed);

        // 动作可能很短（<wechat-status/>），这类必须留下；
        // 短的非动作字符串才是噪声。
        if (!action && trimmed.length < 40) {
            return;
        }

        candidates.push({
            value: trimmed,
            source,
            key,
            depth,
            length: trimmed.length,
            hasAction: action,
            score:
                (action ? 10000000 : 0) +
                Math.max(0, 100000 - depth * 1000) +
                Math.min(trimmed.length, 50000),
        });
    }

    function scanObject(object, source, depth) {
        if (!object || typeof object !== "object" || objectSeen.has(object)) {
            return;
        }

        objectSeen.add(object);

        for (const key of Object.keys(object)) {
            let value;

            try {
                value = object[key];
            } catch (error) {
                continue;
            }

            addCandidate(value, source, key, depth);

            if (value && typeof value === "object" && depth < 8 && !objectSeen.has(value)) {
                scanObject(value, source + "." + key, depth + 1);
            }
        }
    }

    if (propsKey) {
        scanObject(element[propsKey], "domProps", 0);
    }

    const root = fiberKey ? element[fiberKey] : null;

    if (!root) {
        candidates.sort((a, b) => b.score - a.score);
        return candidates.slice(0, 8);
    }

    const queue = [{ node: root, depth: 0 }];

    while (queue.length && seen.size < MAX_NODES) {
        const item = queue.shift();
        const node = item.node;
        const depth = item.depth;

        if (!node || seen.has(node) || depth > MAX_DEPTH) {
            continue;
        }

        seen.add(node);

        scanObject(node.memoizedProps, "memoizedProps", depth);
        scanObject(node.pendingProps, "pendingProps", depth);

        if (node.child) {
            queue.push({ node: node.child, depth: depth + 1 });
        }

        if (node.sibling) {
            queue.push({ node: node.sibling, depth });
        }

        if (node.return) {
            queue.push({ node: node.return, depth: Math.max(0, depth - 1) });
        }
    }

    candidates.sort((a, b) => b.score - a.score);

    const unique = [];
    const values = new Set();

    for (const candidate of candidates) {
        if (values.has(candidate.value)) {
            continue;
        }

        values.add(candidate.value);
        unique.push(candidate);

        if (unique.length >= 8) {
            break;
        }
    }

    return unique;
}

/**
只沿 child 向下走。返回 `{ top, candidates, totalCandidates }`，
`top` 是得分最高的唯一候选，供调用方直接取正文。
*/
function collectChildFiberCandidate(element, actionTagNames) {
    function findReactKey(el, prefix) {
        if (!el) return null;
        for (const k in el) {
            if (k.indexOf(prefix) === 0) return k;
        }
        return null;
    }

    const FIBER_PREFIX = "__react" + "Fiber";
    const PROPS_PREFIX = "__react" + "Props";

    const candidates = [];

    const actionTags =
        Array.isArray(actionTagNames) && actionTagNames.length
            ? actionTagNames
            : ["write", "edit", "read", "exec", "answer", "done", "screenshot"];
    const LT = String.fromCharCode(60);

    function hasAction(text) {
        if (typeof text !== "string") return false;
        for (const tag of actionTags) {
            if (text.indexOf(LT + tag) !== -1) return true;
        }
        return false;
    }

    function recordString(source, key, value, depth) {
        if (typeof value !== "string") return;

        const isAction = hasAction(value);

        // 100 字符的门槛是按 <write> + CDATA 那种长动作定的；
        // 插件动作往往只有几十个字符（<browse-nav url="…"/>），
        // 按长度一刀切会把它们全丢掉，所以命中动作时豁免长度限制。
        if (!isAction && value.length < 100) return;

        // 分数：Action 特征优先，深度浅优先，长度次要
        const score =
            (isAction ? 1000000 : 0) +
            (1000 - Math.min(depth, 999)) * 100 +
            Math.min(value.length, 99);
        candidates.push({ source, key, value, isAction, depth, score });
    }

    function scanProps(source, props, depth) {
        if (!props || typeof props !== "object") return;
        for (const key in props) {
            try {
                recordString(source, key, props[key], depth);
            } catch (e) {}
        }
    }

    // 1) element 自身 props
    const propsKey = findReactKey(element, PROPS_PREFIX);
    if (propsKey) {
        scanProps("elementProps", element[propsKey], 0);
    }

    // 2) 从 element 的 fiber 出发，只向下走 child
    const fiberKey = findReactKey(element, FIBER_PREFIX);
    if (fiberKey) {
        const seen = new Set();
        const stack = [{ node: element[fiberKey], depth: 0 }];
        let steps = 0;
        const MAX_STEPS = 2000;
        const MAX_DEPTH = 30;

        while (stack.length > 0 && steps < MAX_STEPS) {
            const item = stack.pop();
            const node = item.node;
            const depth = item.depth;

            if (!node || seen.has(node)) continue;
            seen.add(node);
            steps++;

            if (depth > MAX_DEPTH) continue;

            try {
                scanProps("fiberChild", node.memoizedProps, depth);
            } catch (e) {}

            if (node.child) {
                stack.push({ node: node.child, depth: depth + 1 });
            }
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);

    const seenValues = new Set();
    const unique = [];

    for (const c of candidates) {
        const key = c.value.substring(0, 200);
        if (seenValues.has(key)) continue;
        seenValues.add(key);
        unique.push(c);
        if (unique.length >= 5) break;
    }

    return {
        top: unique[0],
        candidates: unique,
        totalCandidates: candidates.length,
    };
}

module.exports = {
    collectFiberCandidates,
    collectChildFiberCandidate,
};
