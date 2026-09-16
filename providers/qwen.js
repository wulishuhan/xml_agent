const { BrowserAgent } = require("./browser-agent");

const QWEN_CONVERSATION_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");
const TRAILING_SLASH_PATTERN = new RegExp("/+$/");

const LT = String.fromCharCode(60);
const BACKTICK = String.fromCharCode(96);

const ACTION_TAG_NAMES = ["write", "read", "exec", "answer", "done"];

function containsActionTag(text) {
    if (!text || typeof text !== "string") return false;
    for (const tag of ACTION_TAG_NAMES) {
        if (text.indexOf(LT + tag) !== -1) return true;
    }
    return false;
}

/**

从 React fiber 树上挖候选长字符串。

关键修复（v3）：

v2 用 full BFS（child + sibling + return 三向遍历），

结果是它会向上爬到更早的对话节点甚至用户 prompt 上，

抓到 1325 字符的旧内容，而不是最新这条 assistant 回复。

v3 改为"只向下走 child"：

起点是当前 response-message-content 节点自身的 fiber

只沿 child 方向向下遍历，不碰 sibling，也不碰 return

这样只能看到"属于最后这条消息"的子树，抓不到更早的消息

同时仍然保留 element 自身 props 的扫描，作为第一优先级。
*/
function extractFromReactFiber(elementHandle) {
    return elementHandle.evaluate((element) => {
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

        const actionTagNames = ["write", "read", "exec", "answer", "done"];
        const LT = String.fromCharCode(60);

        function hasAction(text) {
            if (typeof text !== "string") return false;
            for (const tag of actionTagNames) {
                if (text.indexOf(LT + tag) !== -1) return true;
            }
            return false;
        }

        function recordString(source, key, value, depth) {
            if (typeof value !== "string") return;
            if (value.length < 100) return;

            const isAction = hasAction(value);
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

                // 只往下走 child
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
    });
}

function extractXmlFromCandidate(raw) {
    if (!raw || typeof raw !== "string") return null;

    const LT = String.fromCharCode(60);
    const BT = String.fromCharCode(96);

    let text = raw.trim();

    const fence = BT + BT + BT;
    const reStart = new RegExp("^" + fence + "xml\s", "i");
    const reStartAny = new RegExp("^" + fence + "\s");
    const reEnd = new RegExp("\s*" + fence + "$");

    text = text.replace(reStart, "").replace(reStartAny, "").replace(reEnd, "");
    text = text.trim();

    const actionTags = ["write", "read", "exec", "answer", "done"];
    let startIdx = -1;

    for (const tag of actionTags) {
        const needle = LT + tag;
        const i = text.indexOf(needle);
        if (i !== -1 && (startIdx === -1 || i < startIdx)) {
            startIdx = i;
        }
    }

    if (startIdx === -1) return null;

    return text.substring(startIdx).trim();
}

function parseFenceLine(line) {
    if (!line) return null;

    let i = 0;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) {
        i++;
    }

    if (line.length - i < 3) return null;
    if (line[i] !== BACKTICK) return null;
    if (line[i + 1] !== BACKTICK) return null;
    if (line[i + 2] !== BACKTICK) return null;

    const rest = line.substring(i + 3);

    return { isOpen: rest.trim().length > 0 };
}

function balanceMarkdownFences(text) {
    if (!text || typeof text !== "string") {
        return text || "";
    }

    const lines = text.split("\n");
    const indices = [];
    const isOpenArr = [];

    for (let i = 0; i < lines.length; i++) {
        const p = parseFenceLine(lines[i]);
        if (!p) continue;
        indices.push(i);
        isOpenArr.push(p.isOpen);
    }

    if (indices.length === 0) return text;

    const stack = [];
    const remove = new Set();

    for (let k = 0; k < indices.length; k++) {
        const idx = indices[k];
        if (isOpenArr[k]) {
            stack.push(idx);
        } else if (stack.length > 0) {
            stack.pop();
        } else {
            remove.add(idx);
        }
    }

    const unclosed = stack.length > 0;

    if (remove.size === 0 && !unclosed) return text;

    const result = [];
    for (let i = 0; i < lines.length; i++) {
        if (!remove.has(i)) result.push(lines[i]);
    }

    if (unclosed) result.push(BACKTICK + BACKTICK + BACKTICK);

    return result.join("\n");
}

class QwenProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
            inputSelectors: [
                ".message-input-textarea",
                'div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"]',
                '[contenteditable="true"]',
                "[role='textbox']",
                "#prompt-textarea",
                "textarea",
            ],
        });
    }

    get name() {
        return "Qwen";
    }

    async matchPage(page) {
        try {
            const url = page.url();
            return url.includes("chat.qwen.ai");
        } catch (error) {
            return false;
        }
    }

    getConversationIdFromUrl(url) {
        if (!url || typeof url !== "string") return null;
        const match = url.match(QWEN_CONVERSATION_PATTERN);
        return match ? match[1] : null;
    }

    buildTargetUrl() {
        const base = this.targetUrl || "https://chat.qwen.ai";
        if (!this.conversationId) return base;
        const trimmed = base.replace(TRAILING_SLASH_PATTERN, "");
        return trimmed + "/c/" + this.conversationId;
    }

    async getAssistantCount() {
        if (!this.isPageAlive()) return 0;
        try {
            return await this.page.locator(".response-message-content").count();
        } catch (error) {
            return 0;
        }
    }

    async getGenerationState() {
        if (!this.isPageAlive()) {
            return { generating: false, sendVisible: false, stopVisible: false };
        }

        try {
            return await this.page.evaluate(() => {
                const sendBtn = document.querySelector("[aria-label='发送']");
                const stopBtn =
                    document.querySelector("[aria-label='停止']") ||
                    document.querySelector("[aria-label='Stop']");

                function isVisible(el) {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (style.display === "none" || style.visibility === "hidden") return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                }

                return {
                    sendExists: !!sendBtn,
                    stopExists: !!stopBtn,
                    sendVisible: isVisible(sendBtn),
                    stopVisible: isVisible(stopBtn),
                    generating: isVisible(stopBtn) && !isVisible(sendBtn),
                };
            });
        } catch (error) {
            return { generating: false, sendVisible: false, stopVisible: false };
        }
    }

    async waitForGenerationComplete(getResponse, options) {
        options = options || {};

        const startTimeout = options.startTimeout || 60000;
        const finishTimeout = options.finishTimeout || this.responseTimeout;
        const pollInterval = options.pollInterval || this.responsePollInterval;
        const stableTime = options.stableTime || this.responseStableTime;

        const start = Date.now();
        let started = false;

        while (Date.now() - start < startTimeout) {
            if (!this.isPageAlive()) {
                throw new Error("[Qwen] page was closed while waiting for generation start");
            }

            const state = await this.getGenerationState();

            if (state.stopVisible) {
                started = true;
                break;
            }

            try {
                const text = await getResponse();
                if (text && text.trim()) {
                    started = true;
                    break;
                }
            } catch (error) {}

            await this.sleep(pollInterval);
        }

        if (!started) {
            return await this.waitForStableResponse(getResponse, {
                timeout: finishTimeout,
                stableTime,
                pollInterval,
            });
        }

        const finishStart = Date.now();
        let sawStopVisible = true;
        let lastState = null;

        while (Date.now() - finishStart < finishTimeout) {
            if (!this.isPageAlive()) {
                throw new Error("[Qwen] page was closed while waiting for generation finish");
            }

            const state = await this.getGenerationState();
            lastState = state;

            if (state.stopVisible) sawStopVisible = true;

            if (sawStopVisible && !state.stopVisible && state.sendVisible) break;

            await this.sleep(pollInterval);
        }

        if (!lastState || lastState.stopVisible) {
            return await this.waitForStableResponse(getResponse, {
                timeout: finishTimeout,
                stableTime,
                pollInterval,
            });
        }

        return await this.waitForStableResponse(getResponse, {
            timeout: finishTimeout,
            stableTime,
            pollInterval,
        });
    }

    async buildFromDom(lastLocator) {
        return await lastLocator.evaluate((element) => {
            const clone = element.cloneNode(true);

            clone
                .querySelectorAll(".qwen-markdown-code-header-wrapper, .qwen-markdown-code-header")
                .forEach((el) => el.remove());

            clone.querySelectorAll(".margin-view-overlays").forEach((el) => el.remove());

            function rebuild(node) {
                if (!node) return "";
                if (node.nodeType === 3) return node.textContent || "";
                if (node.nodeType !== 1) return "";

                const tag = (node.tagName || "").toLowerCase();

                if (tag === "pre") {
                    const fence = String.fromCharCode(96, 96, 96);
                    const viewLines = node.querySelectorAll(".view-line");
                    let codeText = "";
                    if (viewLines.length > 0) {
                        const arr = [];
                        viewLines.forEach((l) => arr.push(l.textContent || ""));
                        codeText = arr.join("\n");
                    } else {
                        codeText = node.textContent || "";
                    }
                    return "\n" + fence + "\n" + codeText + "\n" + fence + "\n";
                }

                if (tag === "h1") return "\n# " + (node.textContent || "") + "\n";
                if (tag === "h2") return "\n## " + (node.textContent || "") + "\n";
                if (tag === "h3") return "\n### " + (node.textContent || "") + "\n";
                if (tag === "strong" || tag === "b") {
                    const star = String.fromCharCode(42, 42);
                    return star + (node.textContent || "") + star;
                }
                if (tag === "em" || tag === "i") {
                    const star = String.fromCharCode(42);
                    return star + (node.textContent || "") + star;
                }
                if (tag === "code") {
                    if (node.closest && node.closest("pre")) return node.textContent || "";
                    const tick = String.fromCharCode(96);
                    return tick + (node.textContent || "") + tick;
                }
                if (tag === "br") return "\n";

                let out = "";
                for (let i = 0; i < node.childNodes.length; i++) {
                    out += rebuild(node.childNodes[i]);
                }
                return out;
            }

            let out = "";
            for (let i = 0; i < clone.childNodes.length; i++) {
                out += rebuild(clone.childNodes[i]);
            }
            return out;
        });
    }

    async extractOne(index, totalCount) {
        const messages = this.page.locator(".response-message-content");
        const target = messages.nth(index);

        const visible = await target.isVisible().catch(() => false);
        if (!visible) {
            return { text: "", fromFiber: false, hasAction: false };
        }

        let fiberResult = null;
        try {
            fiberResult = await extractFromReactFiber(target);
        } catch (error) {
            console.warn("[Qwen] fiber extraction failed:", error.message);
        }

        if (fiberResult && fiberResult.top && fiberResult.top.value) {
            const actionCandidate = fiberResult.candidates.find((c) => c.isAction);

            if (actionCandidate) {
                const xmlPart = extractXmlFromCandidate(actionCandidate.value);
                if (xmlPart) {
                    return {
                        text: balanceMarkdownFences(xmlPart),
                        fromFiber: true,
                        hasAction: true,
                    };
                }
            }

            const fallbackCandidate = fiberResult.top;
            return {
                text: String(fallbackCandidate.value || "").trim(),
                fromFiber: true,
                hasAction: false,
            };
        }

        const rebuilt = await this.buildFromDom(target);
        const normalized = (rebuilt || "")
            .replace(/\u00A0/g, " ")
            .replace(/\n{4,}/g, "\n\n\n")
            .trim();

        return {
            text: balanceMarkdownFences(normalized),
            fromFiber: false,
            hasAction: containsActionTag(normalized),
        };
    }

    /**

获取最后一条 assistant 回复。

v3 关键修复：

extractFromReactFiber 现在只沿 child 向下遍历，不再横跨 sibling/return

因此拿到的就是"最后一条消息"自身的内容，不会混入用户 prompt 或更早消息

只要最后一条消息能提取到 Action 就直接返回

多段合并逻辑只在前一条没有 Action 时才触发
*/
    async getLastResponse() {
        if (!this.isPageAlive()) return "";

        try {
            let messages = this.page.locator(".response-message-content");
            let count = await messages.count();

            if (!count) {
                messages = this.page.locator(".qwen-markdown-html");
                count = await messages.count();
            }

            if (!count) return "";

            const lastIndex = count - 1;
            const last = await this.extractOne(lastIndex, count);

            if (last.hasAction) {
                return last.text;
            }

            // 兜底：回溯最近几条合并（应对长输出拆成多条消息的场景）
            const backLimit = Math.min(count, 4);
            const parts = [];

            for (let i = count - backLimit; i < count; i++) {
                if (i === lastIndex) {
                    if (last.text) parts.push(last.text);
                    continue;
                }

                try {
                    const item = await this.extractOne(i, count);
                    if (item.text) parts.push(item.text);
                } catch (error) {}
            }

            const merged = parts.join("\n").trim();

            if (containsActionTag(merged)) {
                const xmlPart = extractXmlFromCandidate(merged);
                if (xmlPart) {
                    return balanceMarkdownFences(xmlPart);
                }
            }

            return last.text || "";
        } catch (error) {
            console.warn("[Qwen] getLastResponse failed:", error.message);
            return "";
        }
    }

    async getResponseState() {
        return {
            count: await this.getAssistantCount(),
            text: await this.getLastResponse(),
        };
    }

    async waitForResponseStart(oldCount, oldResponse) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        let lastText = oldResponse || "";

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error("Qwen page was closed while waiting for response");
            }

            try {
                const state = await this.getResponseState();

                if (state.count > oldCount) return true;

                if (state.text && state.text.trim()) {
                    if (!lastText) return true;
                    if (state.text !== lastText) return true;
                }

                lastText = state.text || lastText;
            } catch (error) {}

            await this.sleep(this.responsePollInterval);
        }

        throw new Error("Qwen did not start a response within " + timeout + "ms");
    }

    async send(message) {
        if (!message || !message.trim()) {
            throw new Error("Qwen message cannot be empty");
        }

        if (!this.isPageAlive()) {
            const recovered = await this.ensurePageAlive();
            if (!recovered || !this.isPageAlive()) {
                throw new Error("Qwen page is not available");
            }
        }

        const oldAssistantCount = await this.getAssistantCount();
        const oldResponse = await this.getLastResponse();

        await this.insertMessage(message);

        try {
            const input = await this.getInput();
            if (!input) throw new Error("Qwen input not found before pressing Enter");
            await input.press("Enter");
        } catch (error) {
            throw new Error("Qwen failed to send message: " + error.message);
        }

        const inputCleared = await this.waitForInputClear();
        if (!inputCleared) {
            console.warn("[Qwen] Input did not clear within timeout, continuing...");
        }

        this.refreshConversationId();

        await this.waitForResponseStart(oldAssistantCount, oldResponse);

        const response = await this.waitForGenerationComplete(() => this.getLastResponse(), {
            startTimeout: 60000,
            finishTimeout: this.responseTimeout,
            pollInterval: this.responsePollInterval,
            stableTime: this.responseStableTime,
        });

        if (!response || !response.trim()) {
            throw new Error("Qwen returned an empty response");
        }

        this.refreshConversationId();

        return response;
    }
}

module.exports = {
    QwenProvider,
    balanceMarkdownFences,
    extractXmlFromCandidate,
};
