const { BrowserAgent } = require("./browser-agent");

class QwenProvider extends BrowserAgent {
  constructor(options = {}) {
    super({
      ...options,

      inputSelectors: ['[contenteditable="true"]', "#prompt-textarea", "textarea", "message-input-textarea"],
    });
  }

  get name() {
    return "Qwen";
  }

  /**
   * 判断当前 Page 是否是 Qwen
   */
  matchPage(page) {
    return page.url().includes("chat.qwen.ai");
  }

  /**
   * =====================================================
   * 获取最后一条 Qwen Assistant 回复
   *
   * 注意：
   *
   * .chat-response-message
   * 是整个 AI 消息。
   *
   * 里面可能包含：
   *
   *   已经完成思考
   *   <read path="package.json"/>
   *
   * 真正需要给 Agent 的内容是：
   *
   *   .qwen-markdown-text
   *
   * 所以这里不能直接 innerText() 整个 message。
   * =====================================================
   */
  async getLastResponse() {
    if (!this.isPageAlive()) {
      return "";
    }

    const messages = this.page.locator(".response-message-content");

    const count = await messages.count();

    if (count === 0) {
      return "";
    }

    /**
     * 从最后一条消息开始找。
     *
     * 有时候最后一个 message 可能还没有
     * 完全生成，所以这里倒序检查。
     */
    for (let i = count - 1; i >= 0; i--) {
      const message = messages.nth(i);

      const visible = await message.isVisible().catch(() => false);

      if (!visible) {
        continue;
      }

      const answer = message.locator(".qwen-markdown-html");

      const answerCount = await answer.count();

      if (answerCount === 0) {
        continue;
      }

      const text = await answer
        .last()
        .innerText()
        .catch(() => "");

      if (text && text.trim()) {
        return text.trim();
      }
    }

    return "";
  }

  /**
   * 获取当前 Assistant 消息数量
   */
  async getAssistantCount() {
    if (!this.isPageAlive()) {
      return 0;
    }

    return await this.page.locator(".response-message-content").count();
  }

  /**
   * =====================================================
   * 发送消息
   * =====================================================
   */
  async send(message) {
    if (!message || !message.trim()) {
      throw new Error("Message cannot be empty");
    }

    /**
     * 等待真正可用的输入框
     */
    const input = await this.waitForInput();

    console.log("Sending message to Qwen...");

    /**
     * 发送之前记录 Assistant 数量。
     *
     * 后面通过数量变化判断是否产生新回复。
     */
    const oldCount = await this.getAssistantCount();

    /**
     * 一次性填充消息。
     *
     * BrowserAgent.insertMessage()
     * 已经负责：
     *
     * click
     * fill
     * 等待 React 状态同步
     * 检查输入框确实有内容
     */
    await this.insertMessage(input, message);

    /**
     * 再次确认输入框里面有内容
     */
    const finalValue = await this.getInputValue(input);

    if (!finalValue || !finalValue.trim()) {
      throw new Error("Input is empty before sending");
    }

    console.log("Input verified.");

    /**
     * Enter 发送
     */
    console.log("Pressing Enter to send...");

    await input.press("Enter");

    /**
     * 等待输入框清空
     */
    const cleared = await this.waitForInputClear();

    if (!cleared) {
      console.log("Warning: input was not cleared after Enter.");
    }

    /**
     * 等待 Qwen 回复
     */
    return await this.waitResponse(oldCount);
  }

  /**
   * =====================================================
   * 等待 Qwen 回复完成
   * =====================================================
   */
  async waitResponse(oldCount) {
    console.log("Waiting for Qwen response...");

    const timeout = Date.now() + 180000;

    let lastResponse = "";
    let stableCount = 0;

    while (Date.now() < timeout) {
      if (!this.isPageAlive()) {
        throw new Error("Qwen page was closed while waiting for response");
      }

      await this.page.waitForTimeout(500);

      const currentCount = await this.getAssistantCount();

      /**
       * 还没有产生新的 Assistant 消息
       */
      if (currentCount <= oldCount) {
        continue;
      }

      /**
       * 获取真正的 Markdown 最终文本
       */
      const current = await this.getLastResponse();

      /**
       * Qwen 可能刚创建消息，
       * 但是 .qwen-markdown-text 还没有生成。
       */
      if (!current) {
        continue;
      }

      /**
       * 连续多次内容相同，
       * 认为生成完成。
       */
      if (current === lastResponse) {
        stableCount++;
      } else {
        lastResponse = current;
        stableCount = 0;
      }

      /**
       * 连续 4 次相同。
       *
       * 4 × 500ms ≈ 2 秒。
       */
      if (stableCount >= 4) {
        console.log("Qwen response complete.");

        return current;
      }
    }

    throw new Error("Qwen response timeout");
  }
}

module.exports = {
  QwenProvider,
};
