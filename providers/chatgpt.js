const { BrowserAgent } = require("../core/browser-agent");

class ChatGPTProvider extends BrowserAgent {
  constructor(options = {}) {
    super({
      ...options,

      inputSelectors: ['[contenteditable="true"]', "#prompt-textarea", "textarea"],
    });
  }

  get name() {
    return "ChatGPT";
  }

  matchPage(page) {
    return page.url().includes("chatgpt.com");
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

  async send(message) {
    const input = await this.waitForInput();

    console.log("Sending message to ChatGPT...");

    const oldResponse = await this.getLastResponse();

    await this.insertMessage(input, message);

    const finalValue = await this.getInputValue(input);

    if (!finalValue || !finalValue.trim()) {
      throw new Error("Input is empty before sending");
    }

    console.log("Input verified.");
    console.log("Pressing Enter to send...");

    await input.press("Enter");

    const cleared = await this.waitForInputClear();

    if (!cleared) {
      console.log("Warning: input was not cleared after Enter.");
    }

    return await this.waitResponse(oldResponse);
  }

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

      if (!current) {
        continue;
      }

      if (current === oldResponse) {
        continue;
      }

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
}

module.exports = {
  ChatGPTProvider,
};
