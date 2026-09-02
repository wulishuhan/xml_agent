const { chromium } = require("playwright");

class ChatGPTBrowser {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async start() {
    console.log("Connecting to Chrome...");

    this.browser = await chromium.connectOverCDP("http://127.0.0.1:9222");

    const contexts = this.browser.contexts();

    if (contexts.length === 0) {
      throw new Error("No Chrome context found");
    }

    this.context = contexts[0];

    const pages = this.context.pages();

    if (pages.length === 0) {
      this.page = await this.context.newPage();
    } else {
      this.page = pages.find((page) => page.url().includes("chatgpt.com")) || pages[0];
    }

    await this.page.bringToFront();

    console.log("Connected to Chrome.");
    console.log("Current URL:", this.page.url());

    return this;
  }

  isPageAlive() {
    return this.page && !this.page.isClosed();
  }

  /**
   * 找到 ChatGPT 真正可用的输入框
   */
  async getInput() {
    if (!this.isPageAlive()) {
      throw new Error("ChatGPT page is closed");
    }

    const selectors = ['[contenteditable="true"]', "#prompt-textarea", "textarea"];

    for (const selector of selectors) {
      try {
        const locator = this.page.locator(selector);

        const count = await locator.count();

        for (let i = 0; i < count; i++) {
          const element = locator.nth(i);

          const visible = await element.isVisible().catch(() => false);

          if (!visible) {
            continue;
          }

          const enabled = await element.isEnabled().catch(() => false);

          if (!enabled) {
            continue;
          }

          console.log("Input found:", selector, "index:", i);

          return element;
        }
      } catch (error) {
        // 当前 selector 不可用，继续尝试下一个
      }
    }

    throw new Error("Could not find visible ChatGPT input");
  }

  /**
   * 等待输入框出现
   */
  async waitForInput() {
    const timeout = Date.now() + 60000;

    while (Date.now() < timeout) {
      if (!this.isPageAlive()) {
        throw new Error("ChatGPT page was closed");
      }

      try {
        const input = await this.getInput();

        if (input) {
          return input;
        }
      } catch (error) {
        // 继续等待
      }

      await this.page.waitForTimeout(500);
    }

    throw new Error("ChatGPT input box timeout");
  }

  /**
   * 获取输入框当前内容
   *
   * 注意：
   * 不再用长度和 message.length 比较。
   *
   * contenteditable 的 innerText 可能会：
   * - 多换行
   * - 多空格
   * - 包含 DOM 产生的额外文本
   *
   * 所以这里只判断是否真的有内容。
   */
  async getInputValue(input) {
    return await input.evaluate((element) => {
      const tag = element.tagName.toLowerCase();

      if (tag === "textarea" || tag === "input") {
        return element.value || "";
      }

      return element.innerText || element.textContent || "";
    });
  }

  /**
   * 获取最后一条 Assistant 回复
   */
  async getLastResponse() {
    if (!this.isPageAlive()) {
      return "";
    }

    const messages = this.page.locator('[data-message-author-role="assistant"]');

    const count = await messages.count();

    if (count === 0) {
      return "";
    }

    for (let i = count - 1; i >= 0; i--) {
      const message = messages.nth(i);

      const visible = await message.isVisible().catch(() => false);

      if (!visible) {
        continue;
      }

      const text = await message.innerText().catch(() => "");

      if (text.trim()) {
        return text.trim();
      }
    }

    return "";
  }

  /**
   * 一次性填充消息
   *
   * 不使用：
   * pressSequentially()
   * keyboard.type()
   *
   * 因为我们的 Prompt 是 XML + Markdown + 多行文本，
   * 模拟键盘输入很容易把换行当成 Enter。
   */
  async insertMessage(input, message) {
    console.log("Inserting message...");

    await input.click();

    /**
     * 一次性填充。
     *
     * Playwright fill() 不会模拟一个个按键，
     * 所以 message 里的 \n 不会触发发送。
     */
    await input.fill(message);

    /**
     * 给 ChatGPT 页面一点时间同步 React 状态。
     */
    await this.page.waitForTimeout(300);

    const actual = await this.getInputValue(input);

    console.log("Message length:", message.length);

    console.log("Input DOM length:", actual.length);

    /**
     * 不再要求 actual.length === message.length。
     *
     * contenteditable 的 innerText 经常会和原字符串
     * 长度不同，这是正常现象。
     *
     * 我们只检查输入框是不是有内容。
     */
    if (!actual || !actual.trim()) {
      throw new Error("Message was not inserted into ChatGPT input");
    }

    console.log("Message inserted successfully.");

    return true;
  }

  /**
   * 等待输入框清空
   *
   * 如果 Enter 成功发送，ChatGPT 通常会清空输入框。
   */
  async waitForInputClear() {
    const timeout = Date.now() + 10000;

    while (Date.now() < timeout) {
      if (!this.isPageAlive()) {
        return false;
      }

      try {
        const input = await this.getInput();

        const value = await this.getInputValue(input);

        if (!value || !value.trim()) {
          console.log("Message sent successfully.");

          return true;
        }
      } catch (error) {
        // 输入框暂时不可用也继续等待
      }

      await this.page.waitForTimeout(300);
    }

    return false;
  }

  /**
   * 发送消息
   */
  async send(message) {
    const input = await this.waitForInput();

    console.log("Sending message to ChatGPT...");

    /**
     * 发送前记录最后一条回复。
     *
     * 后面 waitResponse 会判断是否出现新回复。
     */
    const oldResponse = await this.getLastResponse();

    /**
     * 一次性填入完整消息。
     */
    await this.insertMessage(input, message);

    /**
     * 再次确认输入框确实有内容。
     */
    const finalValue = await this.getInputValue(input);

    if (!finalValue || !finalValue.trim()) {
      throw new Error("Input is empty before sending");
    }

    console.log("Input verified.");

    /**
     * =====================================================
     * 关键：
     *
     * 直接 Enter。
     *
     * 因为前面的 fill() 是一次性设置文本，
     * 所以 Prompt 中的换行不会被当成键盘 Enter。
     * =====================================================
     */
    console.log("Pressing Enter to send...");

    await input.press("Enter");

    /**
     * 等待输入框清空。
     */
    const cleared = await this.waitForInputClear();

    if (!cleared) {
      console.log("Warning: input was not cleared after Enter.");
    }

    /**
     * 等待 ChatGPT 生成回复。
     */
    return await this.waitResponse(oldResponse);
  }

  /**
   * 等待 ChatGPT 回复完成
   */
  async waitResponse(oldResponse) {
    console.log("Waiting for ChatGPT response...");

    const timeout = Date.now() + 180000;

    let lastResponse = "";
    let stableCount = 0;

    while (Date.now() < timeout) {
      if (!this.isPageAlive()) {
        throw new Error("ChatGPT page was closed while waiting for response");
      }

      await this.page.waitForTimeout(500);

      const current = await this.getLastResponse();

      /**
       * 还没有 Assistant 回复。
       */
      if (!current) {
        continue;
      }

      /**
       * 还是旧回复。
       */
      if (current === oldResponse) {
        continue;
      }

      /**
       * 回复内容连续几次没有变化，
       * 认为生成结束。
       */
      if (current === lastResponse) {
        stableCount++;
      } else {
        stableCount = 0;
        lastResponse = current;
      }

      if (stableCount >= 3) {
        console.log("ChatGPT response complete.");

        return current;
      }
    }

    throw new Error("ChatGPT response timeout");
  }

  /**
   * 注意：
   *
   * Chrome 是用户自己启动的。
   *
   * connectOverCDP 后：
   *
   * browser.close()
   *
   * 有可能影响外部 Chrome，
   * 所以这里绝对不主动关闭浏览器。
   */
  async close() {
    console.log("Disconnecting from Chrome...");

    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

module.exports = {
  ChatGPTBrowser,
};
