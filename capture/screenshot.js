/**
截图引擎（平台分派）

按 source 分发：browser（走 CDP）/ screen / window（走各平台命令）。
Windows 的窗口枚举与 PowerShell 脚本在 ./windows.js，
子进程工具在 ./proc.js。

导出的工具函数（getPngSize / runCommand / buildWindowsScript 等）保持兼容，
既有调用方与测试仍可从本文件取。
*/

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PLATFORM = process.platform;

const MAX_SCREENSHOT_BYTES = 40 * 1024 * 1024;

const { ensureDirFor, runCommand } = require("./proc");
const {
    buildCSharpSource,
    buildWindowsScript,
    materializeWindowsScript,
    listWindows,
} = require("./windows");

function getPngSize(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        if (
            buffer.length >= 24 &&
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4e &&
            buffer[3] === 0x47
        ) {
            return {
                width: buffer.readUInt32BE(16),
                height: buffer.readUInt32BE(20),
            };
        }
    } catch (error) {
        // ignore
    }
    return { width: 0, height: 0 };
}
function describeFile(filePath, source, extra) {
    const dims = getPngSize(filePath);
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SCREENSHOT_BYTES) {
        try {
            fs.unlinkSync(filePath);
        } catch (error) {
            // ignore
        }
        return {
            ok: false,
            source: source,
            error:
                "screenshot too large (" +
                stat.size +
                " bytes, limit " +
                MAX_SCREENSHOT_BYTES +
                ")",
        };
    }
    const result = {
        ok: true,
        source: source,
        path: filePath,
        width: dims.width,
        height: dims.height,
        bytes: stat.size,
    };
    if (extra) {
        Object.keys(extra).forEach(function (key) {
            if (extra[key] !== undefined) {
                result[key] = extra[key];
            }
        });
    }
    return result;
}
// PowerShell 脚本不再包含 here-string，C# 源码通过 -CSharpFile 参数传入。

async function captureBrowserPage(options) {
    const { chromium } = require("playwright");
    const cdpUrl =
        options.cdpUrl ||
        process.env.BROWSER_CDP_URL ||
        process.env.XML_AGENT_CDP_URL ||
        "http://127.0.0.1:9222";
    const timeout = options.timeout || 30000;
    const navigationTimeout = options.navigationTimeout || 45000;
    let browser = null;
    let page = null;
    let tempPage = false;
    let context = null;
    try {
        browser = await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
        return {
            ok: false,
            source: "browser_page",
            error: "Unable to connect to CDP at " + cdpUrl + ": " + error.message,
        };
    }
    try {
        const contexts = browser.contexts();
        context = contexts && contexts.length > 0 ? contexts[0] : await browser.newContext();
        if (options.url) {
            page = await context.newPage();
            tempPage = true;
            await page.goto(options.url, {
                waitUntil: "domcontentloaded",
                timeout: navigationTimeout,
            });
        } else {
            const pages = context.pages();
            let selected = null;
            for (let index = pages.length - 1; index >= 0; index -= 1) {
                let currentUrl = "";
                try {
                    currentUrl = pages[index].url();
                } catch (error) {
                    currentUrl = "";
                }
                if (currentUrl && currentUrl !== "about:blank") {
                    selected = pages[index];
                    break;
                }
            }
            if (!selected && pages.length > 0) {
                selected = pages[pages.length - 1];
            }
            if (!selected) {
                selected = await context.newPage();
                tempPage = true;
            }
            page = selected;
        }
        if (options.selector) {
            const locator = page.locator(options.selector).first();
            await locator.screenshot({ path: options.outputPath, timeout: timeout });
        } else {
            const screenshotOptions = {
                path: options.outputPath,
                type: "png",
                timeout: timeout,
            };
            if (options.fullPage === true) {
                screenshotOptions.fullPage = true;
            }
            if (options.clip) {
                screenshotOptions.clip = options.clip;
            }
            // fullPage 截图会让页面滚动，先保存当前位置，截图后恢复，避免影响用户正在看的页面。
            let scrollBefore = null;
            if (screenshotOptions.fullPage) {
                scrollBefore = await page
                    .evaluate(function () {
                        return { x: window.scrollX, y: window.scrollY };
                    })
                    .catch(function () {
                        return null;
                    });
            }
            await page.screenshot(screenshotOptions);
            if (scrollBefore) {
                await page
                    .evaluate(function (pos) {
                        window.scrollTo(pos.x, pos.y);
                    }, scrollBefore)
                    .catch(function () {});
            }
        }
        let pageUrl = null;
        try {
            pageUrl = page.url();
        } catch (error) {
            pageUrl = null;
        }
        return describeFile(options.outputPath, "browser_page", { url: pageUrl });
    } catch (error) {
        return {
            ok: false,
            source: "browser_page",
            error: error.message,
        };
    } finally {
        if (tempPage && page) {
            try {
                await page.close();
            } catch (error) {
                // ignore
            }
        }
        if (browser) {
            try {
                await browser.close();
            } catch (error) {
                // ignore
            }
        }
    }
}
async function captureWindows(options, source) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmlagent-shot-"));
    const scriptPath = path.join(tempDir, "capture.ps1");
    const csharpPath = path.join(tempDir, "capture.cs");
    try {
        // C# 源码单独写文件，PowerShell 用 -CSharpFile 参数读取，避免 here-string 解析问题。
        fs.writeFileSync(csharpPath, buildCSharpSource(), "utf8");
        fs.writeFileSync(scriptPath, materializeWindowsScript(), "utf8");
        const args = [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-OutputPath",
            options.outputPath,
            "-Mode",
            source,
            "-CSharpFile",
            csharpPath,
        ];
        if (source === "window") {
            const title = typeof options.windowTitle === "string" ? options.windowTitle : "";
            if (!title.trim()) {
                return {
                    ok: false,
                    source: source,
                    error: "windowTitle is required for source=window",
                };
            }
            // 窗口标题可能包含中文等 Unicode 字符，写入 UTF-8 文件而不是命令行参数，
            // 避免 Windows 命令行编码导致标题匹配失败。
            const titleFile = path.join(tempDir, "window-title.txt");
            fs.writeFileSync(titleFile, title, "utf8");
            args.push("-WindowTitleFile", titleFile);
        }
        const result = await runCommand("powershell.exe", args, {
            timeout: options.timeout || 30000,
        });
        if (!result.ok || !fs.existsSync(options.outputPath)) {
            const message = (result.stderr || result.error || "capture failed").toString().trim();
            return { ok: false, source: source, error: message };
        }
        return describeFile(options.outputPath, source);
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            // ignore
        }
    }
}
async function captureMac(options, source) {
    const args = ["-x", options.outputPath];
    const result = await runCommand("screencapture", args, {
        timeout: options.timeout || 30000,
    });
    if (!result.ok || !fs.existsSync(options.outputPath)) {
        const message = (result.stderr || result.error || "screencapture failed").toString().trim();
        return { ok: false, source: source, error: message };
    }
    return describeFile(options.outputPath, source, {
        note: source === "window" ? "window mode falls back to full screen on macOS" : undefined,
    });
}
async function captureLinux(options, source) {
    const candidates = [
        { command: "grim", args: [options.outputPath] },
        { command: "scrot", args: ["-o", options.outputPath] },
        { command: "import", args: ["-window", "root", options.outputPath] },
    ];
    let lastError = "no screenshot tool found (tried grim, scrot, import)";
    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        // eslint-disable-next-line no-await-in-loop
        const result = await runCommand(candidate.command, candidate.args, {
            timeout: options.timeout || 30000,
        });
        if (result.ok && fs.existsSync(options.outputPath)) {
            return describeFile(options.outputPath, source, {
                note:
                    source === "window"
                        ? "window mode falls back to full screen on Linux"
                        : undefined,
            });
        }
        const message = (result.stderr || result.error || "").toString().trim();
        if (message && message.indexOf("ENOENT") === -1) {
            lastError = message;
        }
    }
    return { ok: false, source: source, error: lastError };
}
async function captureScreenshot(options) {
    const opts = options || {};
    const source = opts.source || "screen";
    if (!opts.outputPath) {
        throw new Error("outputPath is required");
    }
    ensureDirFor(opts.outputPath);
    if (source === "browser_page") {
        return await captureBrowserPage(opts);
    }
    if (source === "screen" || source === "window") {
        if (PLATFORM === "win32") {
            return await captureWindows(opts, source);
        }
        if (PLATFORM === "darwin") {
            return await captureMac(opts, source);
        }
        return await captureLinux(opts, source);
    }
    throw new Error("Unknown screenshot source: " + source);
}
module.exports = {
    captureScreenshot,
    getPngSize,
    runCommand,
    buildCSharpSource,
    buildWindowsScript,
    materializeWindowsScript,
    listWindows,
    MAX_SCREENSHOT_BYTES,
};
