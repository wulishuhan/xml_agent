const { chromium } = require("playwright");

class BrowserAgent {
  constructor(options = {}) {
    this.cdpUrl = options.cdpUrl || "http://127.0.0.1:9222";

    this.browser = null;
    this.context = null;
    this.page = null;

    // 子类提供自己的输入框 selector
    this.inputSelectors = options.inputSelectors || [];
  }

  get name() {
    return "BrowserAgent";
  }

  /**
   * 子类实现：
   * 判断一个 Page 是否属于当前 Provider
   */
  matchPage(page) {
    throw new Error("matchPage() must be implemented");
  }

  /**
   * =====================================================
   * Chrome / Page 生命周期
   * =====================================================
   */

  async start() {
    console.log(`Connecting to Chrome for ${this.name}...`);

    this.browser = await chromium.connectOverCDP(this.cdpUrl);

    const contexts = this.browser.contexts();

    if (contexts.length === 0) {
      throw new Error("No Chrome context found");
    }

    this.context = contexts[0];

    const pages = this.context.pages();

    console.log(`Found ${pages.length} browser pages.`);

    this.page = pages.find((page) => this.matchPage(page));

    if (!this.page) {
      throw new Error(`${this.name} page not found. Please open ${this.name} first.`);
    }

    await this.page.bringToFront();

    console.log(`${this.name} page: ${this.page.url()}`);

    await this.waitForInput();

    console.log(`${this.name} ready.`);

    return this;
  }

  isPageAlive() {
    return !!(this.page && !this.page.isClosed());
  }

  /**
   * =====================================================
   * Input
   * =====================================================
   */

  async getInput() {
    if (!this.isPageAlive()) {
      throw new Error(`${this.name} page is closed`);
    }

    for (const selector of this.inputSelectors) {
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
        // 当前 selector 不可用
        // 继续尝试下一个
      }
    }

    throw new Error(`Could not find visible ${this.name} input`);
  }

  async waitForInput() {
    const timeout = Date.now() + 60000;

    while (Date.now() < timeout) {
      if (!this.isPageAlive()) {
        throw new Error(`${this.name} page was closed`);
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

    throw new Error(`${this.name} input box timeout`);
  }

  /**
   * =====================================================
   * Input Value
   * =====================================================
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
   * =====================================================
   * 插入消息
   * =====================================================
   */

  async insertMessage(input, message) {
    console.log(`Inserting message into ${this.name}...`);

    await input.click();

    await input.fill(message);

    await this.page.waitForTimeout(300);

    const actual = await this.getInputValue(input);

    console.log("Message length:", message.length);
    console.log("Input DOM length:", actual.length);

    if (!actual || !actual.trim()) {
      throw new Error(`Message was not inserted into ${this.name} input`);
    }

    console.log("Message inserted successfully.");

    return true;
  }

  /**
   * =====================================================
   * 等待 Input 清空
   * =====================================================
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
        // 暂时不可用，继续等待
      }

      await this.page.waitForTimeout(300);
    }

    return false;
  }

  /**
   * =====================================================
   * 公共 sleep
   * =====================================================
   */

  async sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * =====================================================
   * 关闭连接
   *
   * 不调用 browser.close()
   * 因为 Chrome 是用户自己启动的。
   * =====================================================
   */

  async close() {
    console.log("Disconnecting from Chrome...");

    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

module.exports = {
  BrowserAgent,
};
