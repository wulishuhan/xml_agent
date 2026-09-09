const { chromium } = require("playwright");
const { spawn } = require("child_process");
const { promises: fs } = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

class BrowserAgent {
    constructor(options = {}) {
        this.cdpUrl = options.cdpUrl || process.env.XML_AGENT_CDP_URL || "http://127.0.0.1:9222";

        this.context = null;
        this.page = null;
        this.browser = null;
        this.chromeProcess = null;
        this.autoStart = options.autoStart !== undefined ? options.autoStart : true;
        this.startTimeout = options.startTimeout || 30000;
        this.retryInterval = options.retryInterval || 1000;
        this.chromePath =
            options.chromePath ||
            process.env.CHROME_PATH ||
            process.env.XML_AGENT_CHROME_PATH ||
            "";

        this.responseTimeout = this.getNumberOption(
            options.responseTimeout,
            process.env.XML_AGENT_RESPONSE_TIMEOUT_MS,
            10 * 60 * 1000
        );
        this.responseStableTime = this.getNumberOption(
            options.responseStableTime,
            process.env.XML_AGENT_RESPONSE_STABLE_TIME_MS,
            4000
        );
        this.responsePollInterval = this.getNumberOption(
            options.responsePollInterval,
            process.env.XML_AGENT_RESPONSE_POLL_INTERVAL_MS,
            1000
        );
        this.responseInitialTimeout = this.getNumberOption(
            options.responseInitialTimeout,
            process.env.XML_AGENT_RESPONSE_INITIAL_TIMEOUT_MS,
            60 * 1000
        );

        this.inputSelectors = options.inputSelectors || [];
        this.targetUrl =
            options.targetUrl !== undefined ? options.targetUrl : "https://chatgpt.com";

        // 默认保持兼容行为：复用已有 Provider 页面。
        // Session 场景可以设置为 false，让每个 Session 创建独立页面。
        this.reuseExistingPage =
            options.reuseExistingPage !== undefined ? options.reuseExistingPage : true;

        this._cachedInput = null;
        this._cachedInputTimestamp = 0;
        this._inputCacheTTL = 5000;
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

    async checkCdpServer(cdpUrl) {
        try {
            const url = new URL(cdpUrl);
            const host = url.hostname || "127.0.0.1";
            const port = parseInt(url.port) || 9222;
            const healthUrl = "http://" + host + ":" + port + "/json/version";

            return new Promise((resolve) => {
                const request = http.get(healthUrl, { timeout: 3000 }, (response) => {
                    response.resume();
                    resolve(response.statusCode === 200);
                });

                request.on("timeout", () => {
                    request.destroy();
                    resolve(false);
                });

                request.on("error", () => {
                    resolve(false);
                });
            });
        } catch (error) {
            return false;
        }
    }

    async startChromeCdpServer() {
        const chromePath = this.chromePath;

        if (!chromePath) {
            throw new Error(
                "Could not find Chrome executable. Please install Chrome or set CHROME_PATH environment variable or chromePath in config."
            );
        }

        const url = new URL(this.cdpUrl);
        const port = parseInt(url.port) || 9222;
        const userDataDir = path.join(os.tmpdir(), "chrome-agent-profile-" + port);

        console.log(
            "[" + this.name + "] Starting Chrome with remote debugging on port " + port + "..."
        );
        console.log("[" + this.name + "] Chrome path: " + chromePath);

        const args = [
            "--remote-debugging-port=" + port,
            "--user-data-dir=" + userDataDir,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-default-apps",
            "--disable-extensions",
            "--disable-component-update",
            "--disable-client-side-phishing-detection",
            "--disable-crash-reporter",
            "--disable-breakpad",
            "--no-startup-window",
        ];

        this.chromeProcess = spawn(chromePath, args, {
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
            windowsHide: true,
        });

        if (!this.chromeProcess) {
            throw new Error("Failed to spawn Chrome process");
        }

        this.chromeProcess.unref();

        console.log(
            "[" + this.name + "] Chrome process started with PID: " + this.chromeProcess.pid
        );

        const startTime = Date.now();

        while (Date.now() - startTime < this.startTimeout) {
            const isReady = await this.checkCdpServer(this.cdpUrl);

            if (isReady) {
                console.log("[" + this.name + "] CDP server is ready at " + this.cdpUrl);
                return true;
            }

            await this.sleep(this.retryInterval);
        }

        throw new Error("Chrome CDP server did not start within " + this.startTimeout + "ms");
    }

    async ensurePage() {
        if (!this.browser) {
            throw new Error("Browser not connected");
        }

        const contexts = this.browser.contexts();

        if (!contexts || contexts.length === 0) {
            console.log("[" + this.name + "] No context found, creating new context...");
            this.context = await this.browser.newContext();
        } else {
            this.context = contexts[0];
        }

        const pages = this.context.pages();

        // Session 隔离模式：不要抢占其他 Session 已经使用的页面。
        // 在同一个 BrowserContext 中创建新页面，可以继续复用已有登录状态。
        if (!this.reuseExistingPage) {
            console.log("[" + this.name + "] Creating an isolated page for this session...");

            this.page = await this.context.newPage();

            if (this.targetUrl) {
                console.log("[" + this.name + "] Navigating to " + this.targetUrl + "...");

                try {
                    await this.page.goto(this.targetUrl, {
                        waitUntil: "domcontentloaded",
                        timeout: 30000,
                    });
                } catch (error) {
                    console.warn(
                        "[" +
                        this.name +
                        "] Navigation to " +
                        this.targetUrl +
                        " timed out, continuing..."
                    );
                }
            }
        } else if (!pages || pages.length === 0) {
            console.log("[" + this.name + "] No page found, creating new page...");

            this.page = await this.context.newPage();

            if (this.targetUrl) {
                console.log("[" + this.name + "] Navigating to " + this.targetUrl + "...");

                try {
                    await this.page.goto(this.targetUrl, {
                        waitUntil: "domcontentloaded",
                        timeout: 30000,
                    });
                } catch (error) {
                    console.warn(
                        "[" +
                        this.name +
                        "] Navigation to " +
                        this.targetUrl +
                        " timed out, continuing..."
                    );
                }
            }
        } else {
            this.page = null;

            for (const page of pages) {
                try {
                    if (await this.matchPage(page)) {
                        this.page = page;
                        break;
                    }
                } catch (error) {
                    console.warn("[" + this.name + "] Failed to inspect page: " + error.message);
                }
            }

            if (!this.page) {
                const availableUrls = pages.map((page) => {
                    try {
                        return page.url();
                    } catch (error) {
                        return "unknown";
                    }
                });

                throw new Error(
                    "[" +
                    this.name +
                    "] No matching page found for " +
                    this.targetUrl +
                    ". Available pages: " +
                    availableUrls.join(", ")
                );
            }
        }

        if (!this.page) {
            throw new Error("Failed to get or create a page");
        }

        try {
            await this.page.bringToFront();
        } catch (error) {
            console.warn("[" + this.name + "] Could not bring page to front: " + error.message);
        }

        this._cachedInput = null;
        return this.page;
    }

    async start() {
        try {
            const isRunning = await this.checkCdpServer(this.cdpUrl);

            if (isRunning) {
                console.log("[" + this.name + "] CDP server already running at " + this.cdpUrl);
            } else if (this.autoStart) {
                console.log("[" + this.name + "] CDP server not running, attempting to start...");
                await this.startChromeCdpServer();
            } else {
                throw new Error(
                    "CDP server not running at " + this.cdpUrl + " and autoStart is disabled"
                );
            }

            this.browser = await chromium.connectOverCDP(this.cdpUrl);
            console.log("[" + this.name + "] Connected to CDP server");

            await this.ensurePage();
            await this.waitForInput();

            console.log("[" + this.name + "] Connected successfully");
        } catch (error) {
            this.page = null;
            this.context = null;
            this.browser = null;

            throw new Error("[" + this.name + "] Failed to start browser agent: " + error.message);
        }
    }

    isPageAlive() {
        return !!this.page && !this.page.isClosed();
    }

    async getInput(useCache = true) {
        if (!this.isPageAlive()) {
            throw new Error("[" + this.name + "] page is not available");
        }

        if (useCache && this._cachedInput) {
            try {
                const isVisible = await this._cachedInput.isVisible().catch(() => false);
                const isEnabled = !(await this._cachedInput.isDisabled().catch(() => false));

                if (isVisible && isEnabled) {
                    return this._cachedInput;
                }
            } catch (error) {
                // 缓存失效，继续查找
            }

            this._cachedInput = null;
        }

        for (const selector of this.inputSelectors) {
            try {
                const locator = this.page.locator(selector).first();

                if (!(await locator.count())) continue;
                if (!(await locator.isVisible())) continue;
                if (await locator.isDisabled()) continue;

                console.log("[" + this.name + "] Found input using selector: " + selector);

                this._cachedInput = locator;
                this._cachedInputTimestamp = Date.now();

                return locator;
            } catch (error) {
                continue;
            }
        }

        return null;
    }

    async waitForInput(timeout) {
        timeout = timeout || 60 * 1000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error("[" + this.name + "] page was closed while waiting for input");
            }

            try {
                const input = await this.getInput();

                if (input) {
                    return input;
                }
            } catch (error) {
                // continue
            }

            await this.sleep(500);
        }

        throw new Error("[" + this.name + "] input not found within " + timeout + "ms");
    }

    async getInputValue(input) {
        if (!input) return "";

        try {
            const tagName = await input.evaluate(function (element) {
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
        console.log("[" + this.name + "] Inserting message: " + JSON.stringify(message));

        if (!this.isPageAlive()) {
            throw new Error("[" + this.name + "] page is not available");
        }

        const input = await this.getInput(true);

        if (!input) {
            throw new Error("[" + this.name + "] input not found");
        }

        try {
            await input.focus({ timeout: 5000 });
            await this.sleep(200);
        } catch (focusError) {
            try {
                await input.click({ timeout: 5000 });
                await this.sleep(200);
            } catch (clickError) {
                await input.evaluate((el) => {
                    el.focus();

                    if (el.isContentEditable) {
                        const range = document.createRange();
                        const sel = window.getSelection();

                        if (el.childNodes.length > 0) {
                            range.setStartAfter(el.childNodes[el.childNodes.length - 1]);
                        } else {
                            range.setStart(el, 0);
                        }

                        range.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                });

                await this.sleep(200);
            }
        }

        let fillSuccess = false;

        try {
            await input.fill(message);
            await this.sleep(300);
            fillSuccess = true;
        } catch (fillError) {
            console.warn("[" + this.name + "] Fill failed: " + fillError.message);

            try {
                await input.evaluate((el, msg) => {
                    if (el.isContentEditable) {
                        el.innerHTML = "";
                        el.textContent = msg;
                    } else {
                        el.value = msg;
                    }

                    const event = new Event("input", { bubbles: true });
                    el.dispatchEvent(event);
                }, message);

                await this.sleep(300);
                fillSuccess = true;
            } catch (evaluateError) {
                console.warn("[" + this.name + "] Evaluate fill failed: " + evaluateError.message);
            }
        }

        const actualValue = await this.getInputValue(input);

        if (!actualValue || !actualValue.trim()) {
            try {
                await input.click({ timeout: 3000 });
                await this.sleep(200);
                await this.page.keyboard.type(message);
                await this.sleep(300);

                const finalValue = await this.getInputValue(input);

                if (finalValue && finalValue.trim()) {
                    fillSuccess = true;
                }
            } catch (e) {
                throw new Error("[" + this.name + "] failed to insert message: all methods failed");
            }

            if (!fillSuccess) {
                throw new Error(
                    "[" + this.name + "] failed to insert message: input value is empty after fill"
                );
            }
        }

        return true;
    }

    async waitForInputClear(timeout) {
        timeout = timeout || 10 * 1000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
            if (!this.isPageAlive()) {
                throw new Error(
                    "[" + this.name + "] page was closed while waiting for input clear"
                );
            }

            try {
                const input = await this.getInput(true);

                if (!input) {
                    await this.sleep(300);
                    continue;
                }

                const value = await this.getInputValue(input);

                if (!value || !value.trim()) {
                    this._cachedInput = null;
                    return true;
                }
            } catch (error) {
                // continue
            }

            await this.sleep(300);
        }

        return false;
    }

    async waitForStableResponse(getResponse, options) {
        options = options || {};

        const timeout = options.timeout || this.responseTimeout;
        const stableTime = options.stableTime || this.responseStableTime;
        const pollInterval = options.pollInterval || this.responsePollInterval;
        const initialTimeout = options.initialTimeout || this.responseInitialTimeout;

        const startTime = Date.now();
        let firstResponseTime = null;
        let lastResponse = "";
        let lastChangeTime = null;

        while (true) {
            if (!this.isPageAlive()) {
                throw new Error("[" + this.name + "] page was closed while waiting for response");
            }

            const now = Date.now();

            if (now - startTime >= timeout) {
                throw new Error("[" + this.name + "] response timeout after " + timeout + "ms");
            }

            let response = "";

            try {
                response = await getResponse();
            } catch (error) {
                await this.sleep(pollInterval);
                continue;
            }

            response = typeof response === "string" ? response.trim() : "";

            if (!response) {
                if (now - startTime >= initialTimeout) {
                    throw new Error(
                        "[" +
                        this.name +
                        "] did not receive any response within " +
                        initialTimeout +
                        "ms"
                    );
                }

                await this.sleep(pollInterval);
                continue;
            }

            if (firstResponseTime === null) {
                firstResponseTime = now;
                lastResponse = response;
                lastChangeTime = now;
                await this.sleep(pollInterval);
                continue;
            }

            if (response !== lastResponse) {
                lastResponse = response;
                lastChangeTime = now;
                await this.sleep(pollInterval);
                continue;
            }

            const stableDuration = now - lastChangeTime;

            if (stableDuration >= stableTime) {
                return response;
            }

            await this.sleep(pollInterval);
        }
    }

    async sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    async close() {
        if (this.browser) {
            try {
                // await this.browser.close();
            } catch (error) {
                console.warn(
                    "[" + this.name + "] Error closing browser connection: " + error.message
                );
            }
        }

        if (this.chromeProcess && !this.chromeProcess.killed) {
            try {
                // this.chromeProcess.kill();

                console.log("[" + this.name + "] Chrome process killed: " + this.chromeProcess.pid);
            } catch (error) {
                console.warn("[" + this.name + "] Error killing Chrome process: " + error.message);
            }
        }

        this.page = null;
        this.context = null;
        this.browser = null;
        this._cachedInput = null;
        this.chromeProcess = null;
    }
}

module.exports = {
    BrowserAgent,
};
