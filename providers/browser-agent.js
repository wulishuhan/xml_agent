const { chromium } = require("playwright");
const { spawn } = require("child_process");
const { promises: fs } = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
// 按浏览器类型返回候选可执行文件路径（与 electron/chrome-finder.js 保持一致语义，
// 但这里不依赖 Electron，供纯 Node / WebUI 运行时使用）。
function normalizeBrowserType(value) {
    const text = String(value || "")
        .trim()
        .toLowerCase();
    if (text === "edge" || text === "msedge" || text === "microsoft-edge") {
        return "edge";
    }
    return "chrome";
}
function detectBrowserTypeFromPath(filePath) {
    const base = path.basename(String(filePath || "")).toLowerCase();
    if (base.indexOf("msedge") !== -1 || base === "microsoft edge") {
        return "edge";
    }
    return "chrome";
}
function getBrowserCandidates(browserType) {
    const type = normalizeBrowserType(browserType);
    if (type === "edge") {
        if (process.platform === "win32") {
            const programFiles = process.env.ProgramFiles || "C:\Program Files";
            const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\Program Files (x86)";
            const localAppData = process.env.LOCALAPPDATA || "";
            return [
                path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
                path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
                path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
                path.join(programFiles, "Microsoft", "Edge Beta", "Application", "msedge.exe"),
                path.join(programFiles, "Microsoft", "Edge Dev", "Application", "msedge.exe"),
            ];
        }
        if (process.platform === "darwin") {
            return [
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
                "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
            ];
        }
        return [
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/microsoft-edge-beta",
            "/usr/bin/microsoft-edge-dev",
            "/opt/microsoft/msedge/msedge",
        ];
    }
    if (process.platform === "win32") {
        const programFiles = process.env.ProgramFiles || "C:\Program Files";
        const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\Program Files (x86)";
        const localAppData = process.env.LOCALAPPDATA || "";
        return [
            path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
            path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
            path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
            path.join(programFiles, "Google", "Chrome Beta", "Application", "chrome.exe"),
            path.join(programFiles, "Google", "Chrome SxS", "Application", "chrome.exe"),
        ];
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ];
    }
    return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ];
}
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
        // 浏览器类型：chrome（默认）| edge
        this.browserType = normalizeBrowserType(
            options.browserType !== undefined
                ? options.browserType
                : process.env.BROWSER_TYPE || process.env.XML_AGENT_BROWSER_TYPE
        );
        this.chromePath =
            options.chromePath ||
            (this.browserType === "edge"
                ? process.env.BROWSER_EDGE_PATH ||
                  process.env.EDGE_PATH ||
                  process.env.XML_AGENT_EDGE_PATH
                : process.env.CHROME_PATH || process.env.XML_AGENT_CHROME_PATH) ||
            "";
        this.focusCdpPage =
            options.focusCdpPage !== undefined
                ? options.focusCdpPage
                : process.env.BROWSER_FOCUS_CDP_PAGE !== "false";
        // 是否在启动浏览器时显示浏览器窗口（有界面模式）。
        // 默认 true，用户可看到 Agent 正在使用的浏览器。
        this.headless =
            options.headless !== undefined
                ? options.headless === true
                : process.env.BROWSER_HEADLESS === "true";
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
        this.conversationId = options.conversationId || null;
        this.currentConversationId = this.conversationId;
        this.reuseExistingPage =
            options.reuseExistingPage !== undefined ? options.reuseExistingPage : true;
        if (this.conversationId) {
            this.reuseExistingPage = false;
        }
        this.navigationTimeout = this.getNumberOption(
            options.navigationTimeout,
            process.env.XML_AGENT_NAVIGATION_TIMEOUT_MS,
            45000
        );
        this.inputTimeout = this.getNumberOption(
            options.inputTimeout,
            process.env.XML_AGENT_INPUT_TIMEOUT_MS,
            120000
        );
        this.diagnosticsEnabled =
            options.diagnosticsEnabled !== undefined ? options.diagnosticsEnabled : true;
        this.diagnosticsIntervalMs = this.getNumberOption(
            options.diagnosticsIntervalMs,
            process.env.XML_AGENT_DIAGNOSTICS_INTERVAL_MS,
            10000
        );
        this.continueOnNavigationTimeout =
            options.continueOnNavigationTimeout !== undefined
                ? options.continueOnNavigationTimeout
                : true;
        this._cachedInput = null;
        this._cachedInputTimestamp = 0;
        this._inputCacheTTL = 5000;
        this._recoveringPromise = null;
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
    /**
当前浏览器类型的人类可读名称。
*/
    getBrowserLabel() {
        return this.browserType === "edge" ? "Edge" : "Chrome";
    }
    /**
自动探测浏览器可执行文件路径。
优先使用显式传入/环境变量中的路径；否则按平台常见安装路径查找。
*/
    resolveBrowserPath() {
        if (this.chromePath && this.chromePath.trim()) {
            return this.chromePath.trim();
        }
        const candidates = getBrowserCandidates(this.browserType);
        // 追加环境变量兜底路径
        if (this.browserType === "edge") {
            if (process.env.BROWSER_EDGE_PATH) candidates.unshift(process.env.BROWSER_EDGE_PATH);
            if (process.env.EDGE_PATH) candidates.unshift(process.env.EDGE_PATH);
        } else {
            if (process.env.BROWSER_CHROME_PATH)
                candidates.unshift(process.env.BROWSER_CHROME_PATH);
            if (process.env.CHROME_PATH) candidates.unshift(process.env.CHROME_PATH);
        }
        const fsSync = require("fs");
        for (const candidate of candidates) {
            try {
                if (candidate && fsSync.statSync(candidate).isFile()) {
                    return candidate;
                }
            } catch (error) {
                continue;
            }
        }
        return "";
    }
    matchPage(page) {
        throw new Error("matchPage() must be implemented");
    }
    getConversationIdFromUrl(url) {
        return null;
    }
    buildTargetUrl() {
        return this.targetUrl;
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
    /**
构造启动参数。Chrome 与 Edge 均基于 Chromium。
注意：不要加 --no-startup-window，否则浏览器只在后台运行、不显示任何窗口，
用户会以为浏览器没有启动。默认使用有界面模式（headless=false）启动，
让用户可以看到 Agent 正在操作的浏览器窗口。
*/
    buildLaunchArgs(port, userDataDir) {
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
            // 显式带一个空白页，确保有可见窗口
            "about:blank",
        ];
        if (this.browserType === "edge") {
            args.push("--disable-features=msEdgeSidebarV2,msEdgeIdentityFeatures,EdgeCollections");
            args.push("--disable-edge-shopping");
        }
        if (this.headless) {
            // 仅在用户明确要求无界面模式时才添加
            args.push("--headless=new");
            args.push("--disable-gpu");
        }
        return args;
    }
    async startChromeCdpServer() {
        const browserPath = this.resolveBrowserPath();
        const label = this.getBrowserLabel();
        if (!browserPath) {
            throw new Error(
                "Could not find " +
                    label +
                    " executable. Please install " +
                    label +
                    " or set " +
                    (this.browserType === "edge" ? "BROWSER_EDGE_PATH" : "CHROME_PATH") +
                    " environment variable or browser path in config."
            );
        }
        const url = new URL(this.cdpUrl);
        const port = parseInt(url.port) || 9222;
        const profilePrefix =
            this.browserType === "edge" ? "edge-agent-profile-" : "chrome-agent-profile-";
        const userDataDir = path.join(os.tmpdir(), profilePrefix + port);
        console.log(
            "[" +
                this.name +
                "] Starting " +
                label +
                " with remote debugging on port " +
                port +
                "..."
        );
        console.log("[" + this.name + "] " + label + " path: " + browserPath);
        const args = this.buildLaunchArgs(port, userDataDir);
        this.chromeProcess = spawn(browserPath, args, {
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
            // 有界面模式必须让窗口可见；windowsHide 会隐藏控制台/窗口句柄，
            // 这里设为 headless 时才隐藏。
            windowsHide: this.headless === true,
        });
        if (!this.chromeProcess) {
            throw new Error("Failed to spawn " + label + " process");
        }
        this.chromeProcess.unref();
        console.log(
            "[" + this.name + "] " + label + " process started with PID: " + this.chromeProcess.pid
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
        throw new Error(label + " CDP server did not start within " + this.startTimeout + "ms");
    }
    async openNewPageForTarget() {
        const url = this.buildTargetUrl();
        console.log("[" + this.name + "] Creating new page for target: " + url);
        this.page = await this.context.newPage();
        if (url) {
            try {
                await this.page.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: this.navigationTimeout,
                });
            } catch (error) {
                const msg =
                    "[" +
                    this.name +
                    "] Navigation to " +
                    url +
                    " timed out after " +
                    this.navigationTimeout +
                    "ms, continuing...";
                if (this.continueOnNavigationTimeout) {
                    console.warn(msg);
                } else {
                    throw new Error(msg);
                }
            }
        }
        return this.page;
    }
    getPageConversationId(page) {
        if (!page) {
            return null;
        }
        try {
            return this.getConversationIdFromUrl(page.url());
        } catch (error) {
            return null;
        }
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
        if (this.conversationId) {
            for (const page of pages) {
                const pageCid = this.getPageConversationId(page);
                if (pageCid && pageCid === this.conversationId) {
                    console.log(
                        "[" +
                            this.name +
                            "] Found existing page for conversation " +
                            this.conversationId
                    );
                    this.page = page;
                    break;
                }
            }
            if (!this.page) {
                console.log(
                    "[" +
                        this.name +
                        "] No page found for conversation " +
                        this.conversationId +
                        ", creating new one"
                );
                await this.openNewPageForTarget();
            }
        } else if (!this.reuseExistingPage) {
            console.log("[" + this.name + "] Creating an isolated page for this session...");
            await this.openNewPageForTarget();
        } else if (!pages || pages.length === 0) {
            console.log("[" + this.name + "] No page found, creating new page...");
            await this.openNewPageForTarget();
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
                console.log(
                    "[" +
                        this.name +
                        "] No matching page found for " +
                        this.targetUrl +
                        ", creating a new page. Available pages: " +
                        availableUrls.join(", ")
                );
                await this.openNewPageForTarget();
            }
        }
        if (!this.page) {
            throw new Error("Failed to get or create a page");
        }
        if (this.focusCdpPage) {
            try {
                await this.page.bringToFront();
            } catch (error) {
                console.warn("[" + this.name + "] Could not bring page to front: " + error.message);
            }
        } else {
            console.log("[" + this.name + "] focusCdpPage disabled, skipping bringToFront");
        }
        this._cachedInput = null;
        return this.page;
    }
    refreshConversationId() {
        if (!this.isPageAlive()) {
            return this.currentConversationId;
        }
        try {
            const url = this.page.url();
            const cid = this.getConversationIdFromUrl(url);
            if (cid) {
                this.currentConversationId = cid;
            }
            return this.currentConversationId;
        } catch (error) {
            return this.currentConversationId;
        }
    }
    async ensurePageAlive() {
        if (this.isPageAlive()) {
            return true;
        }
        if (this._recoveringPromise) {
            return this._recoveringPromise;
        }
        const self = this;
        this._recoveringPromise = (async function () {
            console.log("[" + self.name + "] Page is not alive, attempting to recover...");
            self.page = null;
            self.context = null;
            self._cachedInput = null;
            try {
                if (self.currentConversationId) {
                    self.conversationId = self.currentConversationId;
                    self.reuseExistingPage = false;
                }
                const isRunning = await self.checkCdpServer(self.cdpUrl);
                if (!isRunning) {
                    if (self.autoStart) {
                        await self.startChromeCdpServer();
                    } else {
                        console.warn(
                            "[" + self.name + "] CDP server not running and autoStart disabled"
                        );
                        return false;
                    }
                }
                self.browser = await chromium.connectOverCDP(self.cdpUrl);
                await self.ensurePage();
                await self.waitForInput();
                const cid = self.refreshConversationId();
                if (cid && !self.conversationId) {
                    self.conversationId = cid;
                }
                const url = self.page ? self.page.url() : "(none)";
                console.log("[" + self.name + "] Page recovered: " + url);
                return self.isPageAlive();
            } catch (error) {
                console.error("[" + self.name + "] Failed to recover page: " + error.message);
                self.page = null;
                self.context = null;
                self.browser = null;
                return false;
            }
        })();
        try {
            return await this._recoveringPromise;
        } finally {
            this._recoveringPromise = null;
        }
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
            console.log(
                "[" + this.name + "] Connected to CDP server (" + this.getBrowserLabel() + ")"
            );
            await this.ensurePage();
            const pageUrl = this.isPageAlive() ? this.page.url() : "(none)";
            console.log("[" + this.name + "] Page URL: " + pageUrl);
            await this.waitForInput();
            const cid = this.refreshConversationId();
            if (cid && !this.conversationId) {
                this.conversationId = cid;
            }
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
    async collectDiagnostics() {
        const info = {
            url: "(unknown)",
            title: "(unknown)",
            contentEditables: 0,
            textareas: 0,
            roleTextboxes: 0,
            buttons: 0,
        };
        if (!this.isPageAlive()) {
            return info;
        }
        try {
            info.url = this.page.url();
        } catch (error) {}
        try {
            info.title = await this.page.title();
        } catch (error) {}
        try {
            info.contentEditables = await this.page.locator('[contenteditable="true"]').count();
        } catch (error) {}
        try {
            info.textareas = await this.page.locator("textarea").count();
        } catch (error) {}
        try {
            info.roleTextboxes = await this.page.locator("[role='textbox']").count();
        } catch (error) {}
        try {
            info.buttons = await this.page.locator("button").count();
        } catch (error) {}
        return info;
    }
    async waitForInput(timeout) {
        const effectiveTimeout = timeout || this.inputTimeout;
        const start = Date.now();
        let lastDiagnosticsAt = 0;
        while (Date.now() - start < effectiveTimeout) {
            if (!this.isPageAlive()) {
                throw new Error("[" + this.name + "] page was closed while waiting for input");
            }
            try {
                const input = await this.getInput();
                if (input) {
                    return input;
                }
            } catch (error) {}
            const now = Date.now();
            if (this.diagnosticsEnabled && now - lastDiagnosticsAt >= this.diagnosticsIntervalMs) {
                lastDiagnosticsAt = now;
                try {
                    const diag = await this.collectDiagnostics();
                    console.log(
                        "[" +
                            this.name +
                            "] Waiting for input " +
                            Math.round((now - start) / 1000) +
                            "s" +
                            " | url=" +
                            diag.url +
                            " | title=" +
                            diag.title +
                            " | contenteditable=" +
                            diag.contentEditables +
                            " | textarea=" +
                            diag.textareas +
                            " | role=textbox=" +
                            diag.roleTextboxes +
                            " | buttons=" +
                            diag.buttons
                    );
                } catch (error) {}
            }
            await this.sleep(500);
        }
        throw new Error("[" + this.name + "] input not found within " + effectiveTimeout + "ms");
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
    /**
    通用的图片上传：点击上传按钮，在弹出的文件选择器中设置文件。
    - imagePaths: 本地图片绝对路径数组
    - buttonSelectors: 上传按钮候选选择器（按顺序尝试）
    返回 { ok, count, reason }
    */
    async uploadImages(imagePaths, buttonSelectors) {
        const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
        if (!paths.length) {
            return { ok: true, count: 0 };
        }
        if (!this.isPageAlive()) {
            return { ok: false, count: 0, reason: "page is not available" };
        }
        const selectors = Array.isArray(buttonSelectors) ? buttonSelectors : [];
        let button = null;
        for (const selector of selectors) {
            try {
                const locator = this.page.locator(selector);
                const count = await locator.count();
                for (let index = 0; index < count; index += 1) {
                    const candidate = locator.nth(index);
                    if (!(await candidate.isVisible().catch(() => false))) {
                        continue;
                    }
                    button = candidate;
                    break;
                }
            } catch (error) {
                // 继续尝试下一个选择器
            }
            if (button) {
                break;
            }
        }
        if (!button) {
            return { ok: false, count: 0, reason: "upload button not found" };
        }
        try {
            const [chooser] = await Promise.all([
                this.page.waitForEvent("filechooser", { timeout: 10000 }),
                button.click({ timeout: 5000 }),
            ]);
            await chooser.setFiles(paths);
            await this.sleep(800);
            return { ok: true, count: paths.length };
        } catch (error) {
            try {
                const input = this.page.locator('input[type="file"]').last();
                if ((await input.count()) > 0) {
                    await input.setInputFiles(paths);
                    await this.sleep(800);
                    return { ok: true, count: paths.length };
                }
            } catch (innerError) {
                // ignore
            }
            return { ok: false, count: 0, reason: error.message };
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
            } catch (error) {}
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
                // 这里连接的是外部 CDP 浏览器。close() 会清理 Playwright 创建的上下文并断开连接，
                // 但不会把通过 CDP 连接的外部浏览器进程作为本地 Playwright browser 关闭。
                await this.browser.close();
            } catch (error) {
                console.warn(
                    "[" + this.name + "] Error closing browser connection: " + error.message
                );
            }
        }
        if (this.chromeProcess && !this.chromeProcess.killed) {
            try {
                console.log(
                    "[" + this.name + "] Browser process remains running: " + this.chromeProcess.pid
                );
            } catch (error) {
                console.warn(
                    "[" + this.name + "] Error handling browser process: " + error.message
                );
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
    normalizeBrowserType,
    detectBrowserTypeFromPath,
    getBrowserCandidates,
};
