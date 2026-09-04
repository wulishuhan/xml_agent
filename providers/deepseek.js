const { BrowserAgent } = require("./browser-agent");

class DeepSeekProvider extends BrowserAgent {
  constructor(options = {}) {
    super({
      ...options,

      inputSelectors: ['[contenteditable="true"]', "#prompt-textarea", "textarea"],
    });
  }

  get name() {
    return "DeepSeek";
  }

  //  判断当前页面是不是 DeepSeek
  async matchPage(page) {
    try {
      const url = page.url();

      return url.includes("chat.deepseek.com");
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
      return await this.page.locator(".ds-assistant-message-main-content").count();
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
      let messages = this.page.locator(".ds-assistant-message-main-content");

      let count = await messages.count();

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
   * 获取当前 DeepSeek 回复状态
   * 返回：
   * {
   *   count: assistant 数量,
   *   text: 最后一条回复
   * }
   */
  async getResponseState() {
    return {
      count: await this.getAssistantCount(),
      text: await this.getLastResponse(),
    };
  }

  /**
   * 等待 DeepSeek 开始产生新的回复
   * 1. assistant count 增加
   * 2. 最后一条回复出现
   * 3. 最后一条回复内容发生变化
   */
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

        // 情况 1：
        // assistant 数量增加

        if (state.count > oldCount) {
          return true;
        }

        // 情况 2：
        // 当前已经出现回复

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
         * DeepSeek DOM 在生成过程中可能发生临时变化。
         * 不要因为一次 DOM 异常直接终止 Agent。
         */
      }

      await this.sleep(this.responsePollInterval);
    }

    throw new Error(`DeepSeek did not start a response within ${timeout}ms`);
  }

  /**
   * 发送消息
   */
  async send(message) {
    if (!message || !message.trim()) {
      throw new Error("DeepSeek message cannot be empty");
    }

    if (!this.isPageAlive()) {
      throw new Error("DeepSeek page is not available");
    }

    // 发送前保存状态

    const oldAssistantCount = await this.getAssistantCount();

    const oldResponse = await this.getLastResponse();

    // 输入消息

    await this.insertMessage(message);

    // 发送消息

    try {
      const input = await this.getInput();

      if (!input) {
        throw new Error("DeepSeek input not found before pressing Enter");
      }

      await input.press("Enter");
    } catch (error) {
      throw new Error(`DeepSeek failed to send message: ${error.message}`);
    }

    // 等待输入框清空

    const inputCleared = await this.waitForInputClear();

    if (!inputCleared) {
      /**
       * 输入框没有及时清空，
       * 不一定代表发送失败。
       */
      console.warn("[DeepSeek] Input did not clear within timeout, continuing...");
    }

    // 等待 DeepSeek 开始产生回复

    await this.waitForResponseStart(oldAssistantCount, oldResponse);

    // 等待回复真正完成

    const response = await this.waitForStableResponse(() => this.getLastResponse(), {
      timeout: this.responseTimeout,

      // 连续稳定一段时间，
      // 才认为模型生成完成。
      stableTime: this.responseStableTime,

      // 轮询间隔。
      pollInterval: this.responsePollInterval,
    });

    // 最终检查

    if (!response || !response.trim()) {
      throw new Error("DeepSeek returned an empty response");
    }

    return response;
  }
}

module.exports = {
  DeepSeekProvider,
};
