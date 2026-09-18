

const { BrowserAgent } = require("./browser-agent");

const GLM_CONVERSATION_PATTERN = new RegExp("/(?:c|s)/([0-9a-zA-Z-]+)");
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

class GlmProvider extends BrowserAgent {
    constructor(options = {}) {
        super({
            ...options,
            inputSelectors: [
                "#chat-input",
                "textarea#chat-input",
                "div[contenteditable='true']",
                "[contenteditable='true']",
                "[role='textbox']",
                "textarea",
            ],
        });
    }

    get name() {
        return "GLM";
    }

    async matchPage(page) {
        try {
            return page.url().includes("chat.z.ai");
        } catch (error) {
            return false;
        }
    }

    getConversationIdFromUrl(url) {
        if (!url || typeof url !== "string") {
            return null;
        }

        const match = url.match(GLM_CONVERSATION_PATTERN);
        return match ? match[1] : null;
    }

    buildTargetUrl() {
        const base = this.targetUrl || "https://chat.z.ai";

        if (!this.conversationId) {
            return base;
        }

        return base.replace(TRAILING_SLASH_PATTERN, "") + "/s/" + this.conversationId;
    }

    async getAssistantMessages() {
        if (!this.isPageAlive()) {
            return null;
        }

        try {
            return this.page.locator(".chat-assistant");
        } catch (error) {
            return null;
        }
    }

    async getAssistantCount() {
        const messages = await this.getAssistantMessages();

        if (!messages) {
            return 0;
        }

        try {
            return await messages.count();
        } catch (error) {
            return 0;
        }
    }

    /**
     * GLM (Svelte) may reuse DOM elements instead of creating new ones.
     * Use text content hash as a stable key for tracking responses.
     */
    async getAssistantMessageKeys() {
        if (!this.isPageAlive()) {
            return [];
        }

        try {
            const messages = this.page.locator(".chat-assistant");
            return await messages.evaluateAll((elements) =>
                elements.map((element, index) => {
                    const text = (element.textContent || "").trim();
                    // Use first 100 chars + length as a simple hash-like key
                    const hash = text.length + ":" + text.substring(0, 100);
                    return "glm:" + index + ":" + hash;
                })
            );
        } catch (error) {
            return [];
        }
    }

    async getAssistantIndexByKey(key) {
        if (!key || !key.startsWith("glm:")) {
            return -1;
        }

        try {
            const parts = key.split(":");
            const index = parseInt(parts[1], 10);

            if (isNaN(index) || index < 0) {
                return -1;
            }

            const messages = this.page.locator(".chat-assistant");
            const count = await messages.count();

            if (index >= count) {
                return -1;
            }

            return index;
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
            const messages = this.page.locator(".chat-assistant");
            const count = await messages.count();

            if (index < 0 || index >= count) {
                return "";
            }

            const message = messages.nth(index);

            const text = await message.evaluate((element) => {
                // Remove thinking/reasoning blocks
                const clone = element.cloneNode(true);
                clone
                    .querySelectorAll(".thinking-chain-container, .thinking-block")
                    .forEach((node) => node.remove());

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
                        return "\n" + "#".repeat(Number(tag.slice(1))) + " " + children.trim() + "\n";
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

                return render(clone)
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
            const messages = this.page.locator(".chat-assistant");
            const count = await messages.count();

            if (index < 0 || index >= count) {
                return "";
            }

            // Prioritize DOM extraction to avoid stale React Fiber data
            const domText = await this.buildFromDom(index);

            if (domText && domText.trim()) {
                const xmlFromDom = extractXmlFromCandidate(domText);

                if (xmlFromDom) {
                    return balanceMarkdownFences(xmlFromDom);
                }

                return balanceMarkdownFences(domText);
            }

            // Fallback to React Fiber extraction
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
            const messages = this.page.locator(".chat-assistant");
            const count = await messages.count();

            if (!count) {
                return "";
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

    /**
     * Detect generation state by checking stop/send button visibility.
     * GLM uses Svelte, similar pattern to Qwen.
     */
    async getGenerationState() {
        if (!this.isPageAlive()) {
            return { generating: false, sendVisible: false, stopVisible: false };
        }

        try {
            return await this.page.evaluate(() => {
                // Look for stop/generate button indicators
                const stopBtn =
                    document.querySelector("[aria-label='停止']") ||
                    document.querySelector("[aria-label='Stop']") ||
                    document.querySelector("button[class*='stop']") ||
                    document.querySelector("[data-testid='stop-button']");

                const sendBtn =
                    document.querySelector("#send-message-button") ||
                    document.querySelector("[aria-label='发送']") ||
                    document.querySelector("[aria-label='Send']");

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

    async waitForNewResponseKey(oldKeys) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        const previous = new Set(oldKeys || []);

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error("GLM page was closed while waiting for response");
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

            // Also check if text content changed (element reuse scenario)
            const currentKeys = keys;
            if (currentKeys.length === oldKeys.length) {
                // Same number of elements - check if last one changed
                const lastOldKey = oldKeys[oldKeys.length - 1];
                const lastNewKey = currentKeys[currentKeys.length - 1];

                if (lastOldKey && lastNewKey && lastOldKey !== lastNewKey) {
                    // Content changed even though count is same
                    const response = await this.getResponseByKey(lastNewKey);
                    if (response && response.trim()) {
                        return lastNewKey;
                    }
                }
            }

            await this.sleep(this.responsePollInterval);
        }

        throw new Error(
            "GLM did not create a new assistant response within " + timeout + "ms"
        );
    }

    async waitForResponseStart(oldCount, oldResponse) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        let lastText = oldResponse || "";

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error("GLM page was closed while waiting for response");
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

        throw new Error("GLM did not start a response within " + timeout + "ms");
    }

    async getGLMInput() {
        if (!this.isPageAlive()) {
            throw new Error("[GLM] page is not available");
        }

        const selectors = [
            "#chat-input",
            "textarea#chat-input",
            "div[contenteditable='true']",
            "[contenteditable='true']",
            "[role='textbox']",
            "textarea",
        ];

        for (let attempt = 0; attempt < 3; attempt++) {
            for (const selector of selectors) {
                try {
                    const locator = this.page.locator(selector);
                    const count = await locator.count();

                    for (let index = 0; index < count; index++) {
                        const candidate = locator.nth(index);

                        if (!(await candidate.isVisible().catch(() => false))) {
                            continue;
                        }

                        if (await candidate.isDisabled().catch(() => false)) {
                            continue;
                        }

                        const box = await candidate.boundingBox().catch(() => null);

                        if (!box || box.width <= 0 || box.height <= 0) {
                            continue;
                        }

                        return candidate;
                    }
                } catch (error) {
                    // Continue searching during hydration or DOM updates
                }
            }

            await this.sleep(150);
        }

        return null;
    }

    async insertMessage(message) {
        if (!message || !message.trim()) {
            throw new Error("[GLM] message cannot be empty");
        }

        if (!this.isPageAlive()) {
            throw new Error("[GLM] page is not available");
        }

        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            const input = await this.getGLMInput();

            if (!input) {
                await this.sleep(300);
                continue;
            }

            try {
                await input.click({ timeout: 3000 }).catch(() => input.focus({ timeout: 3000 }));

                const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
                const isContentEditable = await input.evaluate((el) => el.isContentEditable);

                if (isContentEditable || tagName === "div") {
                    await input.evaluate((el, msg) => {
                        el.focus();
                        el.textContent = msg;
                        el.dispatchEvent(
                            new InputEvent("input", {
                                bubbles: true,
                                inputType: "insertText",
                                data: msg,
                            })
                        );
                    }, message);
                } else {
                    await input.evaluate((el, msg) => {
                        const setter = Object.getOwnPropertyDescriptor(
                            HTMLTextAreaElement.prototype,
                            "value"
                        ).set;

                        setter.call(el, msg);
                        el.dispatchEvent(
                            new InputEvent("input", {
                                bubbles: true,
                                cancelable: true,
                                inputType: "insertText",
                                data: msg,
                            })
                        );
                    }, message);
                }

                await this.sleep(300);

                const actualValue = await this.getInputValue(input);

                if (actualValue && actualValue.trim()) {
                    return true;
                }

                lastError = new Error("[GLM] input value is empty after insertion");
            } catch (error) {
                lastError = error;
                this._cachedInput = null;
                await this.sleep(300);
            }
        }

        throw new Error(
            "[GLM] failed to insert message: " + (lastError ? lastError.message : "input not found")
        );
    }

    async send(message) {
        if (!message || !message.trim()) {
            throw new Error("GLM message cannot be empty");
        }

        if (!this.isPageAlive()) {
            const recovered = await this.ensurePageAlive();

            if (!recovered || !this.isPageAlive()) {
                throw new Error("GLM page is not available");
            }
        }

        const oldAssistantKeys = await this.getAssistantMessageKeys();
        const oldAssistantCount = oldAssistantKeys.length;
        const oldResponse = await this.getLastResponse();

        await this.insertMessage(message);

        let sent = false;
        let sendError = null;

        try {
            const sendButton = this.page.locator("#send-message-button").first();

            if (
                (await sendButton.count()) > 0 &&
                (await sendButton.isVisible()) &&
                !(await sendButton.isDisabled().catch(() => false))
            ) {
                await sendButton.click();
                sent = true;
            }
        } catch (error) {
            sendError = error;
        }

        if (!sent) {
            try {
                await this.page.keyboard.press("Enter");
                sent = true;
            } catch (error) {
                sendError = error;
            }
        }

        if (!sent) {
            const input = await this.getGLMInput();

            if (input) {
                try {
                    await input.press("Enter");
                    sent = true;
                } catch (error) {
                    sendError = error;
                }
            }
        }

        if (!sent) {
            throw new Error(
                "GLM failed to send message: " + (sendError ? sendError.message : "unknown error")
            );
        }

        const inputCleared = await this.waitForInputClear(5000);

        if (!inputCleared) {
            console.warn(
                "[GLM] Input did not clear within 5000ms; waiting for response without retrying send"
            );
        }

        this.refreshConversationId();

        let activeResponseKey = null;

        // Try key-based detection first (handles both new elements and content changes)
        try {
            activeResponseKey = await this.waitForNewResponseKey(oldAssistantKeys);
        } catch (error) {
            // Fallback to text-change detection
            await this.waitForResponseStart(oldAssistantCount, oldResponse);

            const keys = await this.getAssistantMessageKeys();

            // Find any key that differs from old keys
            for (let i = 0; i < keys.length; i++) {
                if (i >= oldAssistantKeys.length || keys[i] !== oldAssistantKeys[i]) {
                    activeResponseKey = keys[i];
                    break;
                }
            }

            // If no difference found, use last key
            if (!activeResponseKey && keys.length > 0) {
                activeResponseKey = keys[keys.length - 1];
            }
        }

        const response = await this.waitForStableResponse(
            () => {
                if (!activeResponseKey) {
                    return this.getLastResponse();
                }

                return this.getResponseByKey(activeResponseKey);
            },
            {
                timeout: this.responseTimeout,
                stableTime: this.responseStableTime,
                pollInterval: this.responsePollInterval,
            }
        );

        if (!response || !response.trim()) {
            throw new Error("GLM returned an empty response");
        }

        this.refreshConversationId();

        return response;
    }
}

module.exports = {
    GlmProvider,
    balanceMarkdownFences,
    extractXmlFromCandidate,
};
