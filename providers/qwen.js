const { BrowserAgent } = require("./browser-agent");

class QwenProvider extends BrowserAgent {
  constructor(options = {}) {
    super({
      ...options,

      inputSelectors: [".message-input-textarea", '[contenteditable="true"]', "#prompt-textarea", "textarea"],
    });
  }

  get name() {
    return "Qwen";
  }

  /**
   * 判断当前页面是不是 Qwen
   */
  async matchPage(page) {
    try {
      const url = page.url();

      return url.includes("chat.qwen.ai");
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取所有 assistant 消息数量
   *
   * 注意：
   * 不把 assistant count 作为唯一判断条件。
   */
  async getAssistantCount() {
    if (!this.isPageAlive()) {
      return 0;
    }

    try {
      return await this.page.locator(".response-message-content").count();
    } catch (error) {
      return 0;
    }
  }

  /**
   * 获取最后一条 assistant 回复
   */
  async getLastResponse() {
    if (!this.isPageAlive()) {
      return "";
    }

    try {
      let messages = this.page.locator(".response-message-content");

      let count = await messages.count();

      /**
       * 如果第一种 DOM 不存在，
       * 尝试备用 selector。
       */
      if (!count) {
        messages = this.page.locator(".qwen-markdown-html");

        count = await messages.count();
      }

      if (!count) {
        return "";
      }

      const last = messages.nth(count - 1);

      const visible = await last.isVisible().catch(() => false);

      if (!visible) {
        return "";
      }

      const text = await last.innerText().catch(() => "");

      return (text || "").trim();
    } catch (error) {
      return "";
    }
  }

  /**
   * 获取当前 Qwen 回复状态
   *
   * 返回：
   *
   * {
   *   count: assistant 数量,
   *   text: 最后一条回复
   * }
   *
   * 不把 count 作为唯一判断条件。
   */
  async getResponseState() {
    return {
      count: await this.getAssistantCount(),
      text: await this.getLastResponse(),
    };
  }

  /**
   * 等待 Qwen 开始产生新的回复
   *
   * 不能只依赖 assistant count。
   *
   * 同时支持：
   *
   * 1. assistant count 增加
   * 2. 最后一条回复出现
   * 3. 最后一条回复内容发生变化
   */
  async waitForResponseStart(oldCount, oldResponse) {
    const start = Date.now();

    /**
     * 使用 responseTimeout，
     * 而不是之前固定的 responseInitialTimeout。
     */
    const timeout = this.responseTimeout;

    let lastText = oldResponse || "";

    while (Date.now() - start < timeout) {
      if (!this.isPageAlive()) {
        throw new Error("Qwen page was closed while waiting for response");
      }

      try {
        const state = await this.getResponseState();

        // =====================================================
        // 情况 1：
        // assistant 数量增加
        // =====================================================

        if (state.count > oldCount) {
          return true;
        }

        // =====================================================
        // 情况 2：
        // 当前已经出现回复
        // =====================================================

        if (state.text && state.text.trim()) {
          /**
           * 之前没有回复，
           * 现在出现了回复。
           */
          if (!lastText) {
            return true;
          }

          /**
           * 回复内容发生变化。
           */
          if (state.text !== lastText) {
            return true;
          }
        }

        /**
         * 保存最新文本。
         */
        lastText = state.text || lastText;
      } catch (error) {
        /**
         * Qwen DOM 在生成过程中可能发生临时变化。
         *
         * 不要因为一次 DOM 异常直接终止 Agent。
         */
      }

      await this.sleep(this.responsePollInterval);
    }

    throw new Error(`Qwen did not start a response within ${timeout}ms`);
  }

  /**
   * 发送消息
   */
  async send(message) {
    if (!message || !message.trim()) {
      throw new Error("Qwen message cannot be empty");
    }

    if (!this.isPageAlive()) {
      throw new Error("Qwen page is not available");
    }

    // =========================================================
    // 发送前保存状态
    // =========================================================

    const oldAssistantCount = await this.getAssistantCount();

    const oldResponse = await this.getLastResponse();

    // =========================================================
    // 输入消息
    // =========================================================

    await this.insertMessage(message);

    // =========================================================
    // 发送消息
    // =========================================================

    try {
      const input = await this.getInput();

      if (!input) {
        throw new Error("Qwen input not found before pressing Enter");
      }

      await input.press("Enter");
    } catch (error) {
      throw new Error(`Qwen failed to send message: ${error.message}`);
    }

    // =========================================================
    // 等待输入框清空
    // =========================================================

    const inputCleared = await this.waitForInputClear();

    if (!inputCleared) {
      /**
       * 输入框没有及时清空，
       * 不一定代表发送失败。
       */
      console.warn("[Qwen] Input did not clear within timeout, continuing...");
    }

    // =========================================================
    // 等待 Qwen 开始产生回复
    // =========================================================

    await this.waitForResponseStart(oldAssistantCount, oldResponse);

    // =========================================================
    // 等待回复真正完成
    // =========================================================

    const response = await this.waitForStableResponse(() => this.getLastResponse(), {
      timeout: this.responseTimeout,

      // 连续稳定一段时间，
      // 才认为模型生成完成。
      stableTime: this.responseStableTime,

      // 轮询间隔。
      pollInterval: this.responsePollInterval,
    });

    // =========================================================
    // 最终检查
    // =========================================================

    if (!response || !response.trim()) {
      throw new Error("Qwen returned an empty response");
    }

    return response;
  }
}

module.exports = {
  QwenProvider,
};
