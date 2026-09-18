const { BrowserAgent } = require("./browser-agent");
const DEEPSEEK_CONVERSATION_PATTERN = new RegExp("/a/chat/s/([0-9a-fA-F-]+)");
const TRAILING_SLASH_PATTERN = new RegExp("/+$");
const ACTION_TAG_NAMES = ["write", "read", "exec", "answer", "done"];
function containsActionTag(value) {
    if (typeof value !== "string") {
        return false;
    }
    return ACTION_TAG_NAMES.some((name) => value.includes("<" + name));
}
function balanceMarkdownFences(value) {
    if (value == null) {
        return "";
    }
    const text = String(value);
    const fence = "```";
    let count = 0;
    let index = 0;

    while ((index = text.indexOf(fence, index)) !== -1) {
        count++;
        index += fence.length;
    }

    if (count === 0 || count % 2 === 0) {
        return text;
    }

    const lastFence = text.lastIndexOf(fence);
    const lineStart = text.lastIndexOf("\n", lastFence - 1) + 1;
    const fenceLine = text.slice(lineStart, lastFence + fence.length);
    const suffix = text.slice(lastFence + fence.length);

    if (/[^\s`]/.test(fenceLine.slice(fence.length))) {
        return text + "\n" + fence;
    }

    const codeLike =
        /\b(const|let|var|function|return|class|import|export|if|for|while)\b/.test(suffix) ||
        /[;{}()[\]<>]=?/.test(suffix) ||
        /\n\s+\S/.test(suffix);

    if (codeLike) {
        return text + "\n" + fence;
    }

    return text.slice(0, lastFence).trimEnd();
}
function extractXmlFromCandidate(value) {
    if (value == null) {
        return null;
    }
    let text = String(value).trim();

    if (!text) {
        return null;
    }

    text = text
        .replace(/^```(?:xml|XML)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    const actionPattern = new RegExp("<(read|write|exec|answer|done)(?:\\s[^>]*)?>");
    const match = text.match(actionPattern);

    if (!match) {
        return null;
    }

    if (match.index > 0) {
        text = text.slice(match.index).trim();
    }

    return text || null;
}
class DeepSeekProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
            inputSelectors: [
                'div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"][data-placeholder]',
                'div[contenteditable="true"]',
                "[role='textbox']",
                "textarea",
                "#prompt-textarea",
                ".ds-textarea",
            ],
        });
        this.activeResponseKey = null;
    }

    get name() {
        return "DeepSeek";
    }

    async matchPage(page) {
        try {
            return page.url().includes("chat.deepseek.com");
        } catch (error) {
            return false;
        }
    }

    getConversationIdFromUrl(url) {
        if (!url || typeof url !== "string") {
            return null;
        }

        const match = url.match(DEEPSEEK_CONVERSATION_PATTERN);
        return match ? match[1] : null;
    }

    buildTargetUrl() {
        const base = this.targetUrl || "https://chat.deepseek.com";

        if (!this.conversationId) {
            return base;
        }

        return base.replace(TRAILING_SLASH_PATTERN, "") + "/a/chat/s/" + this.conversationId;
    }

    async getAssistantCount() {
        if (!this.isPageAlive()) {
            return 0;
        }

        try {
            return await this.page.locator(".ds-assistant-message-main-content").count();
        } catch (error) {
            return 0;
        }
    }

    async getAssistantMessageKeys() {
        if (!this.isPageAlive()) {
            return [];
        }

        try {
            return await this.page
                .locator(".ds-assistant-message-main-content")
                .evaluateAll((elements) =>
                    elements.map((element, index) => {
                        const item = element.closest("[data-virtual-list-item-key]");

                        return item
                            ? String(item.getAttribute("data-virtual-list-item-key"))
                            : "index:" + index;
                    })
                );
        } catch (error) {
            return [];
        }
    }

    async getAssistantIndexByKey(key) {
        if (!key) {
            return -1;
        }

        try {
            const messages = this.page.locator(".ds-assistant-message-main-content");
            const count = await messages.count();

            for (let index = 0; index < count; index++) {
                const currentKey = await messages
                    .nth(index)
                    .evaluate((element) => {
                        const item = element.closest("[data-virtual-list-item-key]");

                        return item
                            ? String(item.getAttribute("data-virtual-list-item-key"))
                            : null;
                    })
                    .catch(() => null);

                if (currentKey === String(key)) {
                    return index;
                }
            }
        } catch (error) {}

        return -1;
    }

    async extractFromReactFiber(elementHandle) {
        try {
            return await elementHandle.evaluate((element) => {
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

                function addCandidate(value, source, key, depth) {
                    if (typeof value !== "string" || value.length < 40) {
                        return;
                    }

                    const trimmed = value.trim();

                    if (!trimmed) {
                        return;
                    }

                    const action = containsAction(trimmed);
                    const normalized = trimmed;

                    candidates.push({
                        value: normalized,
                        source,
                        key,
                        depth,
                        length: normalized.length,
                        hasAction: action,
                        score:
                            (action ? 10000000 : 0) +
                            Math.max(0, 100000 - depth * 1000) +
                            Math.min(normalized.length, 50000),
                    });
                }

                function containsAction(value) {
                    return (
                        value.includes("<write") ||
                        value.includes("<read") ||
                        value.includes("<exec") ||
                        value.includes("<answer") ||
                        value.includes("<done")
                    );
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

                        if (
                            value &&
                            typeof value === "object" &&
                            depth < 8 &&
                            !objectSeen.has(value)
                        ) {
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
                        queue.push({
                            node: node.child,
                            depth: depth + 1,
                        });
                    }

                    if (node.sibling) {
                        queue.push({
                            node: node.sibling,
                            depth,
                        });
                    }

                    if (node.return) {
                        queue.push({
                            node: node.return,
                            depth: Math.max(0, depth - 1),
                        });
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
            });
        } catch (error) {
            return [];
        }
    }

    async buildFromDom(index) {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            const messages = this.page.locator(".ds-assistant-message-main-content");

            const count = await messages.count();

            if (index < 0 || index >= count) {
                return "";
            }

            const message = messages.nth(index);

            const text = await message.evaluate((element) => {
                function normalizeText(value) {
                    return String(value || "").replace(/\u00a0/g, " ");
                }

                function render(node) {
                    if (!node) {
                        return "";
                    }

                    if (node.nodeType === Node.TEXT_NODE) {
                        return normalizeText(node.nodeValue);
                    }

                    if (node.nodeType !== Node.ELEMENT_NODE) {
                        return "";
                    }

                    const tag = node.tagName.toLowerCase();

                    if (tag === "script" || tag === "style") {
                        return "";
                    }

                    if (tag === "br") {
                        return "\n";
                    }

                    if (tag === "pre") {
                        const lines = Array.from(node.querySelectorAll(".view-line"))
                            .map((line) => normalizeText(line.textContent))
                            .join("\n");

                        const code = lines || normalizeText(node.textContent);

                        return "```\n" + code + "\n```\n";
                    }

                    const children = Array.from(node.childNodes).map(render).join("");

                    if (tag === "h1" || tag === "h2" || tag === "h3") {
                        return (
                            "\n" + "#".repeat(Number(tag.slice(1))) + " " + children.trim() + "\n"
                        );
                    }

                    if (tag === "strong" || tag === "b") {
                        return "**" + children + "**";
                    }

                    if (tag === "em" || tag === "i") {
                        return "*" + children + "*";
                    }

                    if (tag === "code") {
                        return "`" + children + "`";
                    }

                    if (tag === "p" || tag === "div" || tag === "li") {
                        return children + "\n";
                    }

                    return children;
                }

                return render(element)
                    .replace(/\n{4,}/g, "\n\n")
                    .trim();
            });

            return balanceMarkdownFences(text || "");
        } catch (error) {
            return "";
        }
    }

    async extractOne(index) {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            const messages = this.page.locator(".ds-assistant-message-main-content");

            const count = await messages.count();

            if (index < 0 || index >= count) {
                return "";
            }

            // 优先使用 DOM 提取，因为 DOM 文本直接来自页面渲染结果，
            // 是准确的当前消息内容。React Fiber 可能包含缓存的旧数据
            // （如父组件传递的 system prompt），导致返回错误的响应。
            const domText = await this.buildFromDom(index);

            if (domText && domText.trim()) {
                const xmlFromDom = extractXmlFromCandidate(domText);

                if (xmlFromDom) {
                    return balanceMarkdownFences(xmlFromDom);
                }

                // 如果 DOM 文本不包含 XML action，但仍然有内容，直接返回
                return balanceMarkdownFences(domText);
            }

            // DOM 提取失败或为空时，回退到 React Fiber 提取
            const message = messages.nth(index);
            const fiberCandidates = await this.extractFromReactFiber(message);

            for (const candidate of fiberCandidates) {
                const xml = extractXmlFromCandidate(candidate.value);

                if (xml) {
                    return balanceMarkdownFences(xml);
                }
            }

            for (const candidate of fiberCandidates) {
                if (candidate.value && candidate.value.length >= 40) {
                    return balanceMarkdownFences(candidate.value);
                }
            }

            return "";
        } catch (error) {
            return "";
        }
    }

    async getResponseByKey(key) {
        const index = await this.getAssistantIndexByKey(key);

        if (index < 0) {
            return "";
        }

        return this.extractOne(index);
    }

    async getLastResponse() {
        if (!this.isPageAlive()) {
            return "";
        }

        try {
            const messages = this.page.locator(".ds-assistant-message-main-content");
            const count = await messages.count();

            if (!count) {
                return "";
            }

            if (this.activeResponseKey) {
                const active = await this.getResponseByKey(this.activeResponseKey);

                if (active) {
                    return active;
                }
            }

            return this.extractOne(count - 1);
        } catch (error) {
            return "";
        }
    }

    async getResponseState() {
        return {
            count: await this.getAssistantCount(),
            text: await this.getLastResponse(),
        };
    }

    async waitForNewResponseKey(oldKeys) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        const previous = new Set(oldKeys || []);

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error("DeepSeek page was closed while waiting for response");
            }

            const keys = await this.getAssistantMessageKeys();

            for (const key of keys) {
                if (previous.has(key)) {
                    continue;
                }

                const response = await this.getResponseByKey(key);

                if (response && response.trim()) {
                    return key;
                }
            }

            await this.sleep(this.responsePollInterval);
        }

        throw new Error(
            "DeepSeek did not create a new assistant response within " + timeout + "ms"
        );
    }

    async waitForResponseStart(oldCount, oldResponse) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        let lastText = oldResponse || "";

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error("DeepSeek page was closed while waiting for response");
            }

            try {
                const state = await this.getResponseState();

                if (state.count > oldCount) {
                    return true;
                }

                if (state.text && state.text.trim()) {
                    if (!lastText || state.text !== lastText) {
                        return true;
                    }
                }

                lastText = state.text || lastText;
            } catch (error) {}

            await this.sleep(this.responsePollInterval);
        }

        throw new Error("DeepSeek did not start a response within " + timeout + "ms");
    }

    async send(message) {
        if (!message || !message.trim()) {
            throw new Error("DeepSeek message cannot be empty");
        }

        if (!this.isPageAlive()) {
            const recovered = await this.ensurePageAlive();

            if (!recovered || !this.isPageAlive()) {
                throw new Error("DeepSeek page is not available");
            }
        }

        this.activeResponseKey = null;

        const oldAssistantKeys = await this.getAssistantMessageKeys();
        const oldAssistantCount = oldAssistantKeys.length;
        const oldResponse = await this.getLastResponse();

        await this.insertMessage(message);

        try {
            const input = await this.getInput();

            if (!input) {
                throw new Error("DeepSeek input not found before pressing Enter");
            }

            await input.press("Enter");
        } catch (error) {
            throw new Error("DeepSeek failed to send message: " + error.message);
        }

        const inputCleared = await this.waitForInputClear();

        if (!inputCleared) {
            console.warn("[DeepSeek] Input did not clear within timeout, continuing...");
        }

        this.refreshConversationId();

        try {
            this.activeResponseKey = await this.waitForNewResponseKey(oldAssistantKeys);
        } catch (error) {
            await this.waitForResponseStart(oldAssistantCount, oldResponse);

            const keys = await this.getAssistantMessageKeys();

            for (const key of keys) {
                if (!oldAssistantKeys.includes(key)) {
                    this.activeResponseKey = key;
                    break;
                }
            }
        }

        const response = await this.waitForStableResponse(
            () => {
                if (!this.activeResponseKey) {
                    return "";
                }

                return this.getResponseByKey(this.activeResponseKey);
            },
            {
                timeout: this.responseTimeout,
                stableTime: this.responseStableTime,
                pollInterval: this.responsePollInterval,
            }
        );

        if (!response || !response.trim()) {
            throw new Error("DeepSeek returned an empty response");
        }

        this.refreshConversationId();

        return response;
    }
}
module.exports = {
    DeepSeekProvider,
    balanceMarkdownFences,
    extractXmlFromCandidate,
};
