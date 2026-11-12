const { BrowserAgent } = require("./browser-agent");
const { getActionTagNames } = require("./action-tag");
const { collectFiberCandidates } = require("./dom/fiber");

const DEFAULT_CONVERSATION_PATTERN = new RegExp("/c/([0-9a-zA-Z-]+)");
const TRAILING_SLASH_PATTERN = new RegExp("/+$");

/**
空回复错误码。

"平台挂出了回复、但一直没有可读内容"和"键检测失败、需要降级重试"是两件事：
前者重试才有意义，不能被 provider 的 catch 分支当成普通失败吞掉再等一轮超时。
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";

/**
平台画像：网页版对话 provider 之间真正的差异只有这几个常量。
子类通过 `super({ ...options, profile: PROFILE })` 注入。
*/
const DEFAULT_CHAT_PROFILE = {
    // 用户没配置 targetUrls 时的默认访问地址
    targetUrl: "",
    // 会话地址前缀，如 /c/、/s/、/a/chat/s/
    conversationPathPrefix: "/c/",
    // 从 URL 里抠会话 id 的正则，与 meta 共用同一个值
    conversationIdPattern: DEFAULT_CONVERSATION_PATTERN,
    // matchPage 的判据：页面 URL 含这个片段即认为属于本平台
    pageUrlIncludes: "",
};

/**
网页版对话 provider 基类。

它只负责"所有平台都长一个样"的部分：
- 用URL/会话id 互推地址（profile 驱动，不再各写一份正则）；
- 判断某个页面标签是否属于本平台；
- 响应轮询与稳定判定的通用骨架；
- `send()` 的固定时序（快照 → 写入 → 提交 → 判定 → 取回复）。

平台差异留给子类覆盖这 4 个钩子：
- `deliverMessage()`：怎么把消息发出去（Enter / 发送按钮 / 坐标点击）
- `afterDelivered()`：发送后如何判定"确实发出去了"
- `captureResponseSnapshot()`：发送前记录哪些状态用于对比新旧回复
- `collectResponse(before)`：怎么等到并取出这次的新回复
*/
class BrowserChatProvider extends BrowserAgent {
    constructor(options = {}) {
        const profile = Object.assign({}, DEFAULT_CHAT_PROFILE, options.profile || {});
        super(
            Object.assign({}, options, {
                targetUrl: options.targetUrl !== undefined ? options.targetUrl : profile.targetUrl,
            })
        );
        this.profile = profile;
        this.conversationIdPattern = profile.conversationIdPattern || DEFAULT_CONVERSATION_PATTERN;
    }

    get name() {
        return "BrowserChat";
    }

    // ------------------------------------------------------------
    // 地址与会话 id：profile 驱动，避免四份手写正则
    // ------------------------------------------------------------

    /**
    当前页面标签是否属于本平台。
    默认按 URL 片段判断，少数平台可覆盖。
    */
    async matchPage(page) {
        if (!this.profile.pageUrlIncludes) {
            return false;
        }
        try {
            return page.url().includes(this.profile.pageUrlIncludes);
        } catch (error) {
            return false;
        }
    }

    /**
    从会话 URL 解析会话 id。正则来自 profile（与 meta.conversationIdPattern 同一个值），
    于是"哪段是会话 id"这件事只有一处定义。
    */
    getConversationIdFromUrl(url) {
        if (!url || typeof url !== "string") {
            return null;
        }
        const match = url.match(this.conversationIdPattern);
        return match ? match[1] : null;
    }

    /**
    会话地址 = 站点根地址 + 会话前缀 + 会话 id。
    前缀是唯一需要子类声明的东西（/c/、/s/、/a/chat/s/）。
    */
    buildTargetUrl() {
        const base = this.targetUrl || this.profile.targetUrl || "";
        if (!this.conversationId) {
            return base;
        }
        return (
            base.replace(TRAILING_SLASH_PATTERN, "") +
            this.profile.conversationPathPrefix +
            this.conversationId
        );
    }

    // ------------------------------------------------------------
    // 响应轮询
    // ------------------------------------------------------------

    /**
    当前回复的"计数 + 文本"快照。子类可加入平台特有的稳定键。
    */
    async getResponseState() {
        return {
            count: await this.getAssistantCount(),
            text: await this.getLastResponse(),
        };
    }

    /**
    等待"这次发送确实触发了新回复"。
    两种成立条件：助手消息条数增加，或最后一条文本从空变非空 / 内容变了。
    */
    async waitForResponseStart(oldCount, oldResponse) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        let lastText = oldResponse || "";

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error(this.name + " page was closed while waiting for response");
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
            } catch (error) {
                // DOM 正在抖动，继续轮询
            }

            await this.sleep(this.responsePollInterval);
        }

        throw new Error(this.name + " did not start a response within " + timeout + "ms");
    }

    /**
    以本 provider 的轮询参数等待回复稳定。子类取回复的方式通过 getResponse 传入。
    */
    async waitForFinalResponse(getResponse) {
        return this.waitForStableResponse(getResponse, {
            timeout: this.responseTimeout,
            stableTime: this.responseStableTime,
            pollInterval: this.responsePollInterval,
        });
    }

    // ------------------------------------------------------------
    // 发送：固定时序 + 四个平台钩子
    // ------------------------------------------------------------

    /**
    发送一条消息并等待完整回复。

    时序是四个平台共同的部分，读这一段就能知道一次发送发生了什么；
    平台差异被折叠进钩子，不再散落在四份几乎相同的 send() 里。
    */
    async send(message) {
        this.assertMessage(message);
        await this.ensureReady();

        // 先记录"发送前"的状态，之后靠它区分新回复与历史回复
        const before = await this.captureResponseSnapshot();

        await this.insertMessage(message);
        await this.deliverMessage();
        await this.afterDelivered();

        this.refreshConversationId();

        const response = await this.collectResponse(before);

        if (!response || !response.trim()) {
            throw new Error(this.name + " returned an empty response");
        }

        this.refreshConversationId();

        return response;
    }

    assertMessage(message) {
        if (!message || !message.trim()) {
            throw new Error(this.name + " message cannot be empty");
        }
    }

    /**
    页面丢了先尝试自动恢复，恢复不了才抛错 —— 避免 agent 直接重试失败。
    */
    async ensureReady() {
        if (this.isPageAlive()) {
            return;
        }
        const recovered = await this.ensurePageAlive();
        if (!recovered || !this.isPageAlive()) {
            throw new Error(this.name + " page is not available");
        }
    }

    /**
    发送前快照。默认只要条数 + 文本；用稳定键识别回复的平台会覆盖它。
    */
    async captureResponseSnapshot() {
        return {
            count: await this.getAssistantCount(),
            text: await this.getLastResponse(),
        };
    }

    /**
    默认提交方式：回车。点击式/多级降级的平台覆盖它。
    实现方在"所有方式都失败"时必须抛错，不能静默返回。
    */
    async deliverMessage() {
        await this.page.keyboard.press("Enter");
    }

    /**
    默认发送后校验：输入框是否清空。清空与否只影响日志，不阻断等待。
    DeepSeek 覆盖为"未清空即判定发送未生效"。
    */
    async afterDelivered() {
        const cleared = await this.waitForInputClear(5000);
        if (!cleared) {
            console.warn(
                "[" +
                    this.name +
                    "] Input did not clear within 5000ms; waiting for response without retrying send"
            );
        }
    }

    /**
    默认取回复：等到响应开始，再等到文本稳定。
    需要按稳定键定位回复的平台覆盖它。
    */
    async collectResponse(before) {
        await this.waitForResponseStart(before.count, before.text);
        return this.waitForFinalResponse(() => this.getLastResponse());
    }

    // ------------------------------------------------------------
    // 稳定键（虚拟列表 / 元素复用场景）
    // ------------------------------------------------------------

    /**
    空占位的"活动签名"：返回一个会随思考过程变化的短字符串。

    为什么要它：GLM 深度思考时，正文一直是空的（思考内容在折叠块里），
    只按空回复时长兜底会把正常的长思考误判成失败。
    只要签名在变，就说明模型还在工作，空回复计时应当重置。
    默认返回空串 —— 不做平台特定判断时，就是纯时长兜底。
    */
    async getPendingSignature(key) {
        return "";
    }

    /**
    等待出现一条新的、内容非空的助手回复，返回它的稳定键。

    这里额外守一个边界：平台有时会先挂出一个**空占位**（GLM 的"正在思考"就是典型），
    占位本身不带任何回答内容。若只按"新键出现"判定，调用方要么拿到空回复，
    要么一直空转到 responseTimeout。所以：
    - 只有取到非空正文才算"新回复成立"；
    - 空占位持续超过 responseContentGrace 就明确报错，让上层重试而不是干等。
    */
    async waitForNewResponseKey(oldKeys) {
        const start = Date.now();
        const timeout = this.responseTimeout;
        const previous = new Set(oldKeys || []);
        // 空占位的计时起点：键变了、或活动签名还在变，都重新计时
        let pendingKey = null;
        let pendingSignature = "";
        let pendingSince = 0;

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error(this.name + " page was closed while waiting for response");
            }

            const keys = await this.getAssistantMessageKeys();
            let emptyKey = null;

            for (const key of keys) {
                if (previous.has(key)) {
                    continue;
                }

                const response = await this.getResponseByKey(key);

                if (response && response.trim()) {
                    return key;
                }

                // 新回复已出现，但暂时读不到内容
                emptyKey = key;
            }

            if (emptyKey) {
                // 思考过程还在增长时签名会变，说明模型仍在工作，重新计时
                const signature = await this.getPendingSignature(emptyKey);

                if (pendingKey !== emptyKey || pendingSignature !== signature) {
                    pendingKey = emptyKey;
                    pendingSignature = signature;
                    pendingSince = Date.now();
                } else if (Date.now() - pendingSince >= this.responseContentGrace) {
                    const error = new Error(
                        this.name +
                            " produced an empty response: no readable content within " +
                            this.responseContentGrace +
                            "ms"
                    );

                    error.code = EMPTY_RESPONSE_CODE;
                    throw error;
                }
            } else {
                pendingKey = null;
                pendingSignature = "";
                pendingSince = 0;
            }

            // 元素被复用（条数不变但最后一条换了内容）时，键的变化是唯一线索
            const reusedKey = await this.detectReusedResponseKey(oldKeys || [], keys);

            if (reusedKey) {
                return reusedKey;
            }

            await this.sleep(this.responsePollInterval);
        }

        throw new Error(
            this.name + " did not create a new assistant response within " + timeout + "ms"
        );
    }

    /**
    默认不做元素复用检测。Svelte 类页面（如 GLM）会复用 DOM 节点，覆盖此方法。
    */
    async detectReusedResponseKey(oldKeys, currentKeys) {
        return null;
    }

    /**
    空回复错误要不要继续往上抛。
    provider 的 collectResponse 通常会 catch 键检测失败并降级到"条数/文本"判定，
    但空回复降级只会在超时上再叠一层超时，所以必须原样抛出，交给 agent 重试。
    */
    isEmptyResponseError(error) {
        return !!error && error.code === EMPTY_RESPONSE_CODE;
    }

    /**
    按稳定键取回复正文。键 → 索引的解析留给子类（各平台键格式不同）。
    */
    async getResponseByKey(key) {
        const index = await this.getAssistantIndexByKey(key);
        if (index < 0) {
            return "";
        }
        return this.extractOne(index);
    }

    // ------------------------------------------------------------
    // 输入框
    // ------------------------------------------------------------

    /**
    在"当前真正可见可编辑"的输入框里逐级尝试。
    不能直接用 BrowserAgent.getInput 的缓存 Locator：这些站点的输入框会在
    hydration / 发送 / 虚拟键盘切换时整块替换，缓存句柄会指向已隐藏的旧节点。
    */
    async findVisibleInput(selectors, attempts = 3) {
        if (!this.isPageAlive()) {
            throw new Error("[" + this.name + "] page is not available");
        }
        const candidates = Array.isArray(selectors) ? selectors : this.inputSelectors;

        for (let attempt = 0; attempt < attempts; attempt++) {
            for (const selector of candidates) {
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
                    // 页面正在切换 DOM，换下一个选择器
                }
            }

            await this.sleep(150);
        }

        return null;
    }

    // ------------------------------------------------------------
    // fiber 兜底提取
    // ------------------------------------------------------------

    /**
    DOM 提取失败时的兜底：从 React fiber 上捞候选文本。
    默认用三向 BFS；Qwen 覆盖为只向下的窄遍历。
    */
    async extractFromReactFiber(elementHandle) {
        try {
            return await elementHandle.evaluate(collectFiberCandidates, getActionTagNames());
        } catch (error) {
            return [];
        }
    }
}

module.exports = {
    BrowserChatProvider,
    DEFAULT_CHAT_PROFILE,
    DEFAULT_CONVERSATION_PATTERN,
    TRAILING_SLASH_PATTERN,
    EMPTY_RESPONSE_CODE,
};
