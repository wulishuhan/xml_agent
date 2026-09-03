const { chromium } = require("playwright");

class BrowserAgent {
  constructor(options = {}) {
    this.cdpUrl = options.cdpUrl || process.env.XML_AGENT_CDP_URL || "http://127.0.0.1:9222";

    this.context = null;
    this.page = null;
    this.browser = null;

    // =========================================================
    // Response wait configuration
    // =========================================================

    // 单次回复最大允许时间
    // 默认 10 分钟
    this.responseTimeout = this.getNumberOption(options.responseTimeout, process.env.XML_AGENT_RESPONSE_TIMEOUT_MS, 10 * 60 * 1000);

    // 回复连续稳定多久以后认为生成完成
    // 默认 4 秒
    this.responseStableTime = this.getNumberOption(options.responseStableTime, process.env.XML_AGENT_RESPONSE_STABLE_TIME_MS, 4000);

    // 检查间隔
    // 原来 500ms，这里改成 1000ms
    // 长文本情况下可以明显减少 DOM 读取压力
    this.responsePollInterval = this.getNumberOption(options.responsePollInterval, process.env.XML_AGENT_RESPONSE_POLL_INTERVAL_MS, 1000);

    // 没有任何回复出现时允许等待多久
    // 默认 60 秒
    this.responseInitialTimeout = this.getNumberOption(options.responseInitialTimeout, process.env.XML_AGENT_RESPONSE_INITIAL_TIMEOUT_MS, 60 * 1000);

    this.inputSelectors = options.inputSelectors || [];
  }

  getNumberOption(optionValue, envValue, defaultValue) {
    const value = optionValue ?? envValue;

    if (value === undefined || value === null || value === "") {
      return defaultValue;
    }

    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
      return defaultValue;
    }

    return number;
  }

  get name() {
    return "BrowserAgent";
  }

  matchPage(page) {
    throw new Error("matchPage() must be implemented");
  }

  async start() {
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl);

      const contexts = this.browser.contexts();

      if (!contexts.length) {
        throw new Error("No browser context found");
      }

      this.context = contexts[0];

      const pages = this.context.pages();

      if (!pages.length) {
        throw new Error("No browser page found");
      }

      this.page = null;

      for (const page of pages) {
        try {
          if (await this.matchPage(page)) {
            this.page = page;
            break;
          }
        } catch (error) {
          console.warn(`[${this.name}] Failed to inspect page:`, error.message);
        }
      }

      if (!this.page) {
        throw new Error(`No matching ${this.name} page found`);
      }

      await this.page.bringToFront();

      await this.waitForInput();

      console.log(`[${this.name}] Connected successfully`);
    } catch (error) {
      this.page = null;
      this.context = null;
      this.browser = null;

      throw new Error(`[${this.name}] Failed to start browser agent: ${error.message}`);
    }
  }

  isPageAlive() {
    return !!this.page && !this.page.isClosed();
  }

  async getInput() {
    if (!this.isPageAlive()) {
      throw new Error(`${this.name} page is not available`);
    }

    for (const selector of this.inputSelectors) {
      try {
        const locator = this.page.locator(selector).first();

        if (!(await locator.count())) {
          continue;
        }

        if (!(await locator.isVisible())) {
          continue;
        }

        if (await locator.isDisabled()) {
          continue;
        }

        return locator;
      } catch (error) {
        // 某个 selector 失败不应该影响其他 selector
        continue;
      }
    }

    return null;
  }

  async waitForInput(timeout = 60 * 1000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (!this.isPageAlive()) {
        throw new Error(`${this.name} page was closed while waiting for input`);
      }

      try {
        const input = await this.getInput();

        if (input) {
          return input;
        }
      } catch (error) {
        // 页面 DOM 临时异常，继续等待
      }

      await this.sleep(500);
    }

    throw new Error(`${this.name} input not found within ${timeout}ms`);
  }

  async getInputValue(input) {
    if (!input) {
      return "";
    }

    try {
      const tagName = await input.evaluate((element) => {
        return element.tagName.toLowerCase();
      });

      if (tagName === "input" || tagName === "textarea") {
        return await input.inputValue();
      }

      return await input.innerText();
    } catch (error) {
      try {
        return await input.textContent();
      } catch (error2) {
        return "";
      }
    }
  }

  async insertMessage(message) {
    if (!this.isPageAlive()) {
      throw new Error(`${this.name} page is not available`);
    }

    const input = await this.getInput();

    if (!input) {
      throw new Error(`${this.name} input not found`);
    }

    try {
      await input.click();

      await input.fill(message);

      await this.sleep(300);

      const actualValue = await this.getInputValue(input);

      if (!actualValue || !actualValue.trim()) {
        throw new Error("Input value is empty after fill");
      }

      return true;
    } catch (error) {
      throw new Error(`${this.name} failed to insert message: ${error.message}`);
    }
  }

  async waitForInputClear(timeout = 10 * 1000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (!this.isPageAlive()) {
        throw new Error(`${this.name} page was closed while waiting for input clear`);
      }

      try {
        const input = await this.getInput();

        if (!input) {
          await this.sleep(300);
          continue;
        }

        const value = await this.getInputValue(input);

        if (!value || !value.trim()) {
          return true;
        }
      } catch (error) {
        // DOM 短暂异常，继续检查
      }

      await this.sleep(300);
    }

    return false;
  }

  /**
   * 通用的回复等待器
   *
   * getResponse:
   *   async () => string
   *
   * 逻辑：
   *
   * 1. 最多等待 responseTimeout
   * 2. 回复出现之前，最多等待 responseInitialTimeout
   * 3. 回复出现后，如果内容发生变化，则重新计算稳定时间
   * 4. 内容连续稳定 responseStableTime 后，认为回复完成
   * 5. 页面关闭立即报错
   * 6. 某一次 DOM 读取失败不会直接导致整个 Agent 崩溃
   */
  async waitForStableResponse(getResponse, options = {}) {
    const timeout = options.timeout ?? this.responseTimeout;

    const stableTime = options.stableTime ?? this.responseStableTime;

    const pollInterval = options.pollInterval ?? this.responsePollInterval;

    const initialTimeout = options.initialTimeout ?? this.responseInitialTimeout;

    const startTime = Date.now();

    let firstResponseTime = null;
    let lastResponse = null;
    let lastChangeTime = null;

    let lastError = null;

    while (true) {
      if (!this.isPageAlive()) {
        throw new Error(`${this.name} page was closed while waiting for response`);
      }

      const now = Date.now();

      // =======================================================
      // 总超时
      // =======================================================

      if (now - startTime >= timeout) {
        throw new Error(`${this.name} response timeout after ${timeout}ms`);
      }

      let response = null;

      try {
        response = await getResponse();
        lastError = null;
      } catch (error) {
        lastError = error;

        // DOM 偶发读取失败，不立即退出
        await this.sleep(pollInterval);
        continue;
      }

      if (response && response.trim()) {
        if (firstResponseTime === null) {
          firstResponseTime = now;
          lastChangeTime = now;
          lastResponse = response;
        } else if (response !== lastResponse) {
          // ===================================================
          // 内容发生变化
          // ===================================================

          lastResponse = response;
          lastChangeTime = now;
        } else {
          // ===================================================
          // 内容没有变化
          // ===================================================

          const stableDuration = now - lastChangeTime;

          if (stableDuration >= stableTime) {
            return response;
          }
        }
      } else {
        // =====================================================
        // 回复还没有出现
        // =====================================================

        if (now - startTime >= initialTimeout) {
          throw new Error(`${this.name} did not receive any response within ${initialTimeout}ms`);
        }
      }

      await this.sleep(pollInterval);
    }

    // 理论上不会走到这里
    if (lastError) {
      throw lastError;
    }
  }

  async sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async close() {
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

module.exports = {
  BrowserAgent,
};
