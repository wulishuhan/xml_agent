const { BrowserAgent } = require("./browser-agent");

class ChatGPTProvider extends BrowserAgent {
  constructor(options = {}) {
    super({
      ...options,

      inputSelectors: [".wcDTda_fallbackTextarea", '[contenteditable="true"]', "#prompt-textarea", "textarea"],
    });
  }

  get name() {
    return "ChatGPT";
  }

  async matchPage(page) {
    try {
      const url = page.url();

      return url.includes("chatgpt.com");
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取所有 assistant 消息数量
   */
  async getAssistantCount() {
    if (!this.isPageAlive()) {
      return 0;
    }

    try {
      return await this.page.locator('[data-message-author-role="assistant"]').count();
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
      const messages = this.page.locator('[data-message-author-role="assistant"]');

      const count = await messages.count();

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
   * 获取当前 ChatGPT 回复状态
   *
   * 返回：
   *
   * {
   *   count: assistant 数量,
   *   text: 最后一条回复
   * }
   *
   * 注意：
   * 不把 count 作为唯一判断条件。
   */
  async getResponseState() {
    return {
      count: await this.getAssistantCount(),
      text: await this.getLastResponse(),
    };
  }

  /**
   * 等待 ChatGPT 开始产生新的回复
   *
   * 不能只依赖 assistant count。
   *
   * ChatGPT 页面存在这样的情况：
   *
   * 发送
   *   ↓
   * 模型开始生成
   *   ↓
   * assistant DOM 节点没有立即出现
   *   ↓
   * 但页面实际上已经开始发生变化
   *
   * 因此这里同时支持：
   *
   * 1. assistant count 增加
   * 2. 最后一条回复出现
   * 3. 最后一条回复内容变化
   */
  async waitForResponseStart(oldCount, oldResponse) {
    const start = Date.now();

    // 这里使用 responseTimeout，而不是之前的 60 秒。
    const timeout = this.responseTimeout;

    let lastText = oldResponse || "";

    while (Date.now() - start < timeout) {
      if (!this.isPageAlive()) {
        throw new Error("ChatGPT page was closed while waiting for response");
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
          /*
           * 如果之前没有回复，现在出现了回复
           */
          if (!lastText) {
            return true;
          }

          /*
           * 如果回复发生变化
           */
          if (state.text !== lastText) {
            return true;
          }
        }

        lastText = state.text || lastText;
      } catch (error) {
        // DOM 临时异常：
        // 不要立即终止 Agent
      }

      await this.sleep(this.responsePollInterval);
    }

    throw new Error(`ChatGPT did not start a response within ${timeout}ms`);
  }

  /**
   * 发送消息
   */
  async send(message) {
    if (!message || !message.trim()) {
      throw new Error("ChatGPT message cannot be empty");
    }

    if (!this.isPageAlive()) {
      throw new Error("ChatGPT page is not available");
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
        throw new Error("ChatGPT input not found before pressing Enter");
      }

      await input.press("Enter");
    } catch (error) {
      throw new Error(`ChatGPT failed to send message: ${error.message}`);
    }

    // =========================================================
    // 等待输入框清空
    // =========================================================

    const inputCleared = await this.waitForInputClear();

    if (!inputCleared) {
      /*
       * 输入框没有及时清空并不一定代表发送失败。
       *
       * ChatGPT 有时候页面响应比较慢。
       *
       * 因此这里只警告，不直接终止。
       */
      console.warn("[ChatGPT] Input did not clear within timeout, continuing...");
    }

    // =========================================================
    // 等待 ChatGPT 开始产生回复
    // =========================================================

    await this.waitForResponseStart(oldAssistantCount, oldResponse);

    // =========================================================
    // 等待回复真正完成
    // =========================================================

    const response = await this.waitForStableResponse(() => this.getLastResponse(), {
      timeout: this.responseTimeout,

      // 连续 4 秒没有变化
      // 才认为模型生成完成
      stableTime: this.responseStableTime,

      pollInterval: this.responsePollInterval,
    });

    // =========================================================
    // 最终检查
    // =========================================================

    if (!response || !response.trim()) {
      throw new Error("ChatGPT returned an empty response");
    }

    return response;
  }
}

module.exports = {
  ChatGPTProvider,
};
