const { BrowserChatProvider } = require("./browser-chat");
const { stripCodeToolbarLabels } = require("./markdown-code-clean");
const { balanceMarkdownFences, extractXmlFromCandidate } = require("./markdown-fence-utils");
const { containsActionTag } = require("./action-tag");

const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const NL = String.fromCharCode(10);

const DEEPSEEK_CONVERSATION_PATTERN = new RegExp("/a/chat/s/([0-9a-fA-F-]+)");

const RESPONSE_SELECTOR = ".ds-assistant-message-main-content";
const VIRTUAL_ITEM_ATTR = "data-virtual-list-item-key";

const PROFILE = {
    targetUrl: "https://chat.deepseek.com",
    conversationPathPrefix: "/a/chat/s/",
    conversationIdPattern: DEEPSEEK_CONVERSATION_PATTERN,
    pageUrlIncludes: "chat.deepseek.com",
};

class DeepSeekProvider extends BrowserChatProvider {
    constructor(options = {}) {
        super({
            ...options,
            profile: PROFILE,
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

        // 发送按钮：输入框右侧的圆形主按钮（向上箭头图标）。
        // 用稳定结构定位，避免依赖随机哈希类名。
        this.sendButtonSelectors = [
            'div[role="button"].ds-button--primary.ds-button--circle:has(svg path[d^="M8.3125 0.980206"])',
            'div[role="button"].ds-button--primary.ds-button--circle',
            'div[role="button"][class*="ds-button--primary"][class*="circle"]',
        ];
        // 上传按钮：精确定位到回形针/图片图标的 SVG path 前缀，再逐级放宽。
        this.uploadButtonSelectors = [
            'div[role="button"]:has(svg path[d^="M5.5498 9.75V5H6.9502V9.75"])',
            'div[role="button"].ds-button--capsule.ds-button--iconLabelPrimary',
            'input[type="file"]',
        ];
    }

    get name() {
        return "DeepSeek";
    }

    async getAssistantCount() {
        if (!this.isPageAlive()) {
            return 0;
        }
        try {
            return await this.page.locator(RESPONSE_SELECTOR).count();
        } catch (error) {
            return 0;
        }
    }

    /**
    DeepSeek 用虚拟列表承载历史消息，节点会被回收复用，
    所以用列表项的 data-virtual-list-item-key 做稳定键，而不是下标。
    */
    async getAssistantMessageKeys() {
        if (!this.isPageAlive()) {
            return [];
        }
        try {
            return await this.page.locator(RESPONSE_SELECTOR).evaluateAll((elements) =>
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
            const messages = this.page.locator(RESPONSE_SELECTOR);
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

    async buildFromDom(index) {
        if (!this.isPageAlive()) {
            return "";
        }
        try {
            const messages = this.page.locator(RESPONSE_SELECTOR);
            const count = await messages.count();
            if (index < 0 || index >= count) {
                return "";
            }
            const message = messages.nth(index);
            const text = await message.evaluate((element) => {
                const NBSP = String.fromCharCode(160);
                const NLC = String.fromCharCode(10);
                const BTC = String.fromCharCode(96);
                const FENCEC = BTC + BTC + BTC;
                function normalizeText(value) {
                    return String(value || "")
                        .split(NBSP)
                        .join(" ");
                }
                const TOOLBAR_LABELS = ["复制", "下载", "Copy", "Download", "text", "代码", "Code"];
                function isToolbarLabel(text) {
                    const trimmed = String(text || "").trim();
                    if (!trimmed) {
                        return false;
                    }
                    return TOOLBAR_LABELS.indexOf(trimmed) !== -1;
                }
                function isToolbarElement(node) {
                    if (!node || node.nodeType !== 1) {
                        return false;
                    }
                    const tag = node.tagName.toLowerCase();
                    if (tag === "button" || tag === "svg" || tag === "path" || tag === "i") {
                        return true;
                    }
                    const role = node.getAttribute && node.getAttribute("role");
                    if (role === "button") {
                        return true;
                    }
                    const aria = node.getAttribute && node.getAttribute("aria-label");
                    if (aria && /复制|下载|copy|download/i.test(aria)) {
                        return true;
                    }
                    const cls = (node.getAttribute && node.getAttribute("class")) || "";
                    if (
                        /copy|download|toolbar|action|header|icon/i.test(cls) &&
                        !/code|content|line/i.test(cls)
                    ) {
                        return true;
                    }
                    return false;
                }
                // 提取 <pre> 内代码：优先 .view-line（老结构），回退到 DOM 遍历（新结构）。
                // 遍历时不把行内 span/code 拆行，只按块级 div / br 断行，避免把 function greet 拆散。
                function extractPreCode(preNode) {
                    const lineNodes = Array.from(preNode.querySelectorAll(".view-line"));
                    if (lineNodes.length) {
                        const lines = lineNodes
                            .map((line) => normalizeText(line.textContent))
                            .filter((line) => !isToolbarLabel(line))
                            .join(NLC);
                        if (lines.trim()) {
                            return lines;
                        }
                    }
                    var parts = [];
                    function walk(node) {
                        if (!node) {
                            return;
                        }
                        if (node.nodeType === 3) {
                            var value = normalizeText(node.nodeValue);
                            if (!isToolbarLabel(value)) {
                                parts.push(value);
                            }
                            return;
                        }
                        if (node.nodeType !== 1) {
                            return;
                        }
                        if (isToolbarElement(node)) {
                            return;
                        }
                        var tag = node.tagName.toLowerCase();
                        if (tag === "script" || tag === "style") {
                            return;
                        }
                        var isBlock = tag === "div" || tag === "p" || tag === "pre";
                        if (isBlock) {
                            if (parts.length && parts[parts.length - 1] !== NLC) {
                                parts.push(NLC);
                            }
                        }
                        if (tag === "br") {
                            parts.push(NLC);
                            return;
                        }
                        for (var i = 0; i < node.childNodes.length; i++) {
                            walk(node.childNodes[i]);
                        }
                        if (isBlock) {
                            parts.push(NLC);
                        }
                    }
                    walk(preNode);
                    var out = parts.join("");
                    var triple = NLC + NLC + NLC;
                    while (out.indexOf(triple) !== -1) {
                        out = out.split(triple).join(NLC + NLC);
                    }
                    return out.replace(/^[\s]+|[\s]+$/g, "");
                }
                function render(node, listDepth) {
                    if (!node) {
                        return "";
                    }
                    if (node.nodeType === 3) {
                        var value = normalizeText(node.nodeValue);
                        if (isToolbarLabel(value)) {
                            return "";
                        }
                        return value;
                    }
                    if (node.nodeType !== 1) {
                        return "";
                    }
                    var tag = node.tagName.toLowerCase();
                    if (tag === "script" || tag === "style") {
                        return "";
                    }
                    if (tag === "br") {
                        return NLC;
                    }
                    if (tag === "pre") {
                        var code = extractPreCode(node);
                        return FENCEC + NLC + code + NLC + FENCEC + NLC;
                    }
                    var childNodes = Array.from(node.childNodes);
                    if (tag === "ul" || tag === "ol") {
                        var items = childNodes
                            .filter((c) => c.nodeType === 1 && c.tagName.toLowerCase() === "li")
                            .map((c) => render(c, (listDepth || 0) + 1))
                            .join("");
                        return items + NLC;
                    }
                    if (tag === "li") {
                        var inner = childNodes.map((c) => render(c, listDepth || 0)).join("");
                        var indent = "  ".repeat(Math.max(0, (listDepth || 1) - 1));
                        return indent + "- " + inner.trim() + NLC;
                    }
                    var children = childNodes.map((c) => render(c, listDepth || 0)).join("");
                    if (tag === "h1" || tag === "h2" || tag === "h3") {
                        return NLC + "#".repeat(Number(tag.slice(1))) + " " + children.trim() + NLC;
                    }
                    if (tag === "strong" || tag === "b") {
                        return "**" + children + "**";
                    }
                    if (tag === "em" || tag === "i") {
                        return "*" + children + "*";
                    }
                    if (tag === "code") {
                        return BTC + children + BTC;
                    }
                    if (tag === "p" || tag === "div") {
                        return children + NLC;
                    }
                    return children;
                }
                var rendered = render(element, 0);
                // 折叠过多空行
                var tri = NLC + NLC + NLC;
                while (rendered.indexOf(tri) !== -1) {
                    rendered = rendered.split(tri).join(NLC + NLC);
                }
                return rendered.trim();
            });
            return balanceMarkdownFences(stripCodeToolbarLabels(text || ""));
        } catch (error) {
            return "";
        }
    }

    async extractOne(index) {
        if (!this.isPageAlive()) {
            return "";
        }
        try {
            const messages = this.page.locator(RESPONSE_SELECTOR);
            const count = await messages.count();
            if (index < 0 || index >= count) {
                return "";
            }
            const domText = await this.buildFromDom(index);
            if (domText && domText.trim()) {
                const xmlFromDom = extractXmlFromCandidate(domText);
                if (xmlFromDom) {
                    return balanceMarkdownFences(xmlFromDom);
                }
                return balanceMarkdownFences(domText);
            }
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

    async getLastResponse() {
        if (!this.isPageAlive()) {
            return "";
        }
        try {
            const messages = this.page.locator(RESPONSE_SELECTOR);
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

    // ------------------------------------------------------------
    // 发送钩子
    // ------------------------------------------------------------

    /** 发送前同时记录稳定键列表：虚拟列表会回收节点，只比下标不可靠。 */
    async captureResponseSnapshot() {
        this.activeResponseKey = null;
        const keys = await this.getAssistantMessageKeys();
        return {
            keys,
            count: keys.length,
            text: await this.getLastResponse(),
        };
    }

    /**
    三级降级提交：坐标点击（绕过遮罩）→ 选择器点击 → 回车。
    附件上传后按钮会短暂禁用，先等它恢复。
    */
    async deliverMessage() {
        await this.waitForSendButtonReady(60000);

        let sent = false;

        try {
            sent = await this.clickSendButtonByCoords();
        } catch (error) {
            sent = false;
        }

        if (!sent) {
            try {
                sent = await this.clickSendButton();
            } catch (error) {
                sent = false;
            }
        }

        if (!sent) {
            try {
                const input = await this.getInput();
                if (!input) {
                    throw new Error("DeepSeek input not found before pressing Enter");
                }
                await input.press("Enter");
            } catch (error) {
                throw new Error("DeepSeek failed to send message: " + error.message);
            }
        }
    }

    /**
    与其他平台不同，DeepSeek 把"输入框未清空"判定为发送未生效并直接报错，
    避免继续长时间空等一条永远不会来的回复。
    */
    async afterDelivered() {
        const inputCleared = await this.waitForInputClear();
        if (!inputCleared) {
            throw new Error(
                "DeepSeek send did not take effect: input box was not cleared after clicking send/Enter."
            );
        }
    }

    /**
    先按稳定键定位这次的新回复；键检测失败时退回"条数/文本变化"判定，
    并从中反推出一个可用的键。
    */
    async collectResponse(before) {
        const oldKeys = before.keys || [];

        try {
            this.activeResponseKey = await this.waitForNewResponseKey(oldKeys);
        } catch (error) {
            // 空回复要原样抛出，让上层重试，而不是在这里再等一轮超时。
            if (this.isEmptyResponseError(error)) {
                throw error;
            }

            await this.waitForResponseStart(before.count, before.text);
            const keys = await this.getAssistantMessageKeys();
            for (const key of keys) {
                if (!oldKeys.includes(key)) {
                    this.activeResponseKey = key;
                    break;
                }
            }
        }

        return this.waitForFinalResponse(() => {
            if (!this.activeResponseKey) {
                return "";
            }
            return this.getResponseByKey(this.activeResponseKey);
        });
    }

    // ------------------------------------------------------------
    // 图片上传
    // ------------------------------------------------------------

    /**
    统计页面上缩略图 img 的数量（用于校验上传是否成功、是否叠加）。
    DeepSeek 的图片缩略图统一使用类名 _9f130b7。
    */
    async countImageThumbs() {
        if (!this.isPageAlive()) {
            return 0;
        }
        return this.page.evaluate(() => {
            const list = Array.from(document.querySelectorAll("img._9f130b7"));
            let visible = 0;
            for (const img of list) {
                const r = img.getBoundingClientRect();
                if (r.width >= 20 && r.height >= 20) {
                    visible += 1;
                }
            }
            return visible;
        });
    }

    /**
    清空输入区中尚未发送的图片附件（避免多次上传叠加）。
    待发附件结构：div._6d1b417 > .ds-animated-size-item
    每项内的删除按钮：div.c8b3f8a6（内含 ds-icon 的 × 图标）。
    只处理待发区，不影响聊天历史中的图片。
    */
    async clearPendingAttachments() {
        if (!this.isPageAlive()) {
            return 0;
        }
        let removed = 0;
        for (let guard = 0; guard < 20; guard += 1) {
            const handles = await this.page
                .locator("div._6d1b417 .ds-animated-size-item")
                .elementHandles();
            let clicked = false;
            for (const handle of handles) {
                const visible = await handle.isVisible().catch(() => false);
                if (!visible) {
                    continue;
                }
                const del = await handle.$("div.c8b3f8a6");
                if (!del) {
                    continue;
                }
                try {
                    await del.click({ timeout: 3000 });
                    removed += 1;
                    clicked = true;
                    await this.sleep(300);
                    break;
                } catch (error) {
                    // 尝试下一个
                }
            }
            if (!clicked) {
                break;
            }
        }
        return removed;
    }

    /**
    上传图片并校验增量：缩略图数量必须恰好增加本次图片数，
    否则说明有残留附件或上传未完成。
    */
    async uploadImages(imagePaths) {
        if (!this.isPageAlive()) {
            const recovered = await this.ensurePageAlive();
            if (!recovered || !this.isPageAlive()) {
                throw new Error("DeepSeek page is not available for upload");
            }
        }

        // 先清理输入区残留的待发附件，避免多次上传叠加
        await this.clearPendingAttachments();

        // 记录上传前的缩略图数量，用于上传后校验增量
        const beforeCount = await this.countImageThumbs();
        const result = await super.uploadImages(imagePaths, this.uploadButtonSelectors);

        if (!result.ok) {
            throw new Error("DeepSeek upload failed: " + (result.reason || "unknown"));
        }

        const expected = imagePaths.length;
        let actualDelta = 0;

        for (let attempt = 0; attempt < 20; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop
            const current = await this.countImageThumbs();
            actualDelta = current - beforeCount;
            if (actualDelta >= expected) {
                break;
            }
            // eslint-disable-next-line no-await-in-loop
            await this.sleep(500);
        }

        if (actualDelta !== expected) {
            throw new Error(
                "DeepSeek upload count mismatch: expected " +
                    expected +
                    " new image(s) but detected " +
                    actualDelta +
                    ". There may be leftover attachments in the input box."
            );
        }

        return result;
    }

    // ------------------------------------------------------------
    // 发送按钮
    // ------------------------------------------------------------

    /**
    通过鼠标坐标点击发送按钮。
    DeepSeek 的发送按钮上覆盖了 ds-focus-ring 层，locator.click() 会被拦截，
    因此用 boundingBox 中心点做真实鼠标点击。
    */
    async clickSendButtonByCoords() {
        if (!this.isPageAlive()) {
            return false;
        }
        const box = await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
            for (const button of buttons) {
                const path = button.querySelector("svg path");
                const d = path ? path.getAttribute("d") || "" : "";
                if (!d.startsWith("M8.3125 0.980206")) {
                    continue;
                }
                const rect = button.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) {
                    continue;
                }
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
            return null;
        });
        if (!box) {
            return false;
        }
        await this.page.mouse.click(box.x, box.y);
        return true;
    }

    /**
    等待发送按钮从 disabled 状态恢复（附件上传/处理完成）。
    上传图片后按钮会带 ds-button--disabled 类，此时点击无效。
    */
    async waitForSendButtonReady(timeout) {
        const limit = timeout || 60000;
        const start = Date.now();
        while (Date.now() - start < limit) {
            if (!this.isPageAlive()) {
                return false;
            }
            // eslint-disable-next-line no-await-in-loop
            const ready = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
                for (const button of buttons) {
                    const path = button.querySelector("svg path");
                    const d = path ? path.getAttribute("d") || "" : "";
                    if (!d.startsWith("M8.3125 0.980206")) {
                        continue;
                    }
                    const rect = button.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) {
                        continue;
                    }
                    const disabled =
                        button.className.indexOf("ds-button--disabled") !== -1 ||
                        button.getAttribute("aria-disabled") === "true";
                    return !disabled;
                }
                return false;
            });
            if (ready) {
                return true;
            }
            // eslint-disable-next-line no-await-in-loop
            await this.sleep(500);
        }
        return false;
    }

    async clickSendButton() {
        if (!this.isPageAlive()) {
            return false;
        }
        for (const selector of this.sendButtonSelectors) {
            try {
                const locator = this.page.locator(selector);
                const count = await locator.count();
                for (let index = count - 1; index >= 0; index -= 1) {
                    const candidate = locator.nth(index);
                    if (!(await candidate.isVisible().catch(() => false))) {
                        continue;
                    }
                    const disabled = await candidate
                        .evaluate((el) => {
                            const aria = el.getAttribute("aria-disabled");
                            return aria === "true" || el.classList.contains("ds-button--disabled");
                        })
                        .catch(() => false);
                    if (disabled) {
                        continue;
                    }
                    await candidate.click({ timeout: 5000 });
                    return true;
                }
            } catch (error) {
                // 尝试下一个选择器
            }
        }
        return false;
    }
}

module.exports = {
    DeepSeekProvider,
    balanceMarkdownFences,
    extractXmlFromCandidate,
    stripCodeToolbarLabels,
    // provider 元数据：注册表据此创建实例、解析访问地址与会话 id。
    meta: {
        id: "deepseek",
        label: "DeepSeek",
        defaultTargetUrl: "https://chat.deepseek.com",
        conversationIdPattern: DEEPSEEK_CONVERSATION_PATTERN,
        supportsImages: true,
        create: (options) => new DeepSeekProvider(options),
    },
};
