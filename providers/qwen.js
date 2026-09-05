
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

  // 判断当前页面是不是 Qwen
  async matchPage(page) {
    try {
      const url = page.url();
      return url.includes("chat.qwen.ai");
    } catch (error) {
      return false;
    }
  }

  /**
  
  获取所有 assistant 消息数量
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
  
  获取最后一条 assistant 回复
  
  修复：移除 markdown 代码块中的行号（margin 元素）
  */
  async getLastResponse() {
    if (!this.isPageAlive()) {
      return "";
    }

    try {
      let messages = this.page.locator(".response-message-content");
      let count = await messages.count();

      // 如果第一种 DOM 不存在，尝试备用 selector
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

      // 去除markdown的代码块的头部和行号
      await last.evaluate((element) => {
        // 查找qwen-markdown-code-header，然后去除
        const headers = element.querySelectorAll('.qwen-markdown-code-header');
        headers.forEach((header) => {
          header.remove();
        });
        // 查找所有 .qwen-markdown-code-body 内的 .margin-view-overlays
        const codeBlocks = element.querySelectorAll('.qwen-markdown-code-body');
        codeBlocks.forEach((codeBlock) => {
          const marginElements = codeBlock.querySelectorAll('.margin-view-overlays');
          marginElements.forEach((margin) => {
            margin.remove();
          });
        });
      });

      const text = await last.innerText().catch(() => "");
      return (text || "").trim();
    } catch (error) {
      return "";
    }
  }

  /**
  
  获取当前 Qwen 回复状态
  */
  async getResponseState() {
    return {
      count: await this.getAssistantCount(),
      text: await this.getLastResponse(),
    };
  }

  /**
  
  等待 Qwen 开始产生新的回复
  */
  async waitForResponseStart(oldCount, oldResponse) {
    const start = Date.now();
    const timeout = this.responseTimeout;
    let lastText = oldResponse || "";

    while (Date.now() - start < timeout) {
      if (!this.isPageAlive()) {
        throw new Error("Qwen page was closed while waiting for response");
      }

      try {
        const state = await this.getResponseState();

        if (state.count > oldCount) {
          return true;
        }

        if (state.text && state.text.trim()) {
          if (!lastText) {
            return true;
          }
          if (state.text !== lastText) {
            return true;
          }
        }

        lastText = state.text || lastText;
      } catch (error) {
        // DOM 临时异常，继续等待
      }

      await this.sleep(this.responsePollInterval);
    }

    throw new Error("Qwen did not start a response within " + timeout + "ms");
  }

  /**
  
  发送消息
  */
  async send(message) {
    if (!message || !message.trim()) {
      throw new Error("Qwen message cannot be empty");
    }

    if (!this.isPageAlive()) {
      throw new Error("Qwen page is not available");
    }

    const oldAssistantCount = await this.getAssistantCount();
    const oldResponse = await this.getLastResponse();

    await this.insertMessage(message);

    try {
      const input = await this.getInput();
      if (!input) {
        throw new Error("Qwen input not found before pressing Enter");
      }
      await input.press("Enter");
    } catch (error) {
      throw new Error("Qwen failed to send message: " + error.message);
    }

    const inputCleared = await this.waitForInputClear();
    if (!inputCleared) {
      console.warn("[Qwen] Input did not clear within timeout, continuing...");
    }

    await this.waitForResponseStart(oldAssistantCount, oldResponse);

    const response = await this.waitForStableResponse(() => this.getLastResponse(), {
      timeout: this.responseTimeout,
      stableTime: this.responseStableTime,
      pollInterval: this.responsePollInterval,
    });

    if (!response || !response.trim()) {
      throw new Error("Qwen returned an empty response");
    }

    return response;
  }
}

module.exports = {
  QwenProvider,
};
