const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PLATFORM = process.platform;
const DOLLAR = String.fromCharCode(36);
const DQUOTE = String.fromCharCode(34);
const MAX_SCREENSHOT_BYTES = 40 * 1024 * 1024;
// 写入管线会破坏字面量美元符，因此脚本用占位符书写，运行时再替换为 $。
const D = "@@D@@";
// C# 源码单独写到 .cs 文件，再让 PowerShell 用 Add-Type -TypeDefinition 读取，
// 彻底避免 PowerShell here-string（@" ... "@）在不同入口/编码下的解析问题。
const C_SHARP_SOURCE_LINES = [
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "using System.Drawing;",
    "using System.Drawing.Imaging;",
    "using System.Threading;",
    "",
    "public class WinCapture {",
    '    [DllImport("user32.dll")]',
    "    public static extern bool SetProcessDPIAware();",
    '    [DllImport("user32.dll")]',
    "    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);",
    '    [DllImport("user32.dll")]',
    "    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);",
    '    [DllImport("user32.dll")]',
    "    public static extern bool IsWindowVisible(IntPtr hWnd);",
    '    [DllImport("user32.dll")]',
    "    public static extern bool IsIconic(IntPtr hWnd);",
    '    [DllImport("user32.dll")]',
    "    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
    '    [DllImport("user32.dll", CharSet = CharSet.Unicode)]',
    "    public static extern int GetWindowTextLength(IntPtr hWnd);",
    '    [DllImport("user32.dll", CharSet = CharSet.Unicode)]',
    "    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);",
    '    [DllImport("user32.dll")]',
    "    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);",
    "",
    "    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    "",
    "    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "",
    "    public static IntPtr FindByTitle(string keyword) {",
    "        IntPtr found = IntPtr.Zero;",
    "        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {",
    "            if (!IsWindowVisible(hWnd)) return true;",
    "            int length = GetWindowTextLength(hWnd);",
    "            if (length == 0) return true;",
    "            StringBuilder sb = new StringBuilder(length + 1);",
    "            GetWindowText(hWnd, sb, sb.Capacity);",
    "            string title = sb.ToString();",
    "            if (title.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0) {",
    "                found = hWnd;",
    "                return false;",
    "            }",
    "            return true;",
    "        }, IntPtr.Zero);",
    "        return found;",
    "    }",
    "",
    "    public static bool CaptureWindow(IntPtr hWnd, string outPath) {",
    "        RECT rect;",
    "        if (!GetWindowRect(hWnd, out rect)) return false;",
    "        if (IsIconic(hWnd)) {",
    "            ShowWindow(hWnd, 9);",
    "            Thread.Sleep(300);",
    "            GetWindowRect(hWnd, out rect);",
    "        }",
    "        int width = rect.Right - rect.Left;",
    "        int height = rect.Bottom - rect.Top;",
    "        if (width <= 0 || height <= 0) return false;",
    "        using (Bitmap bmp = new Bitmap(width, height)) {",
    "            using (Graphics g = Graphics.FromImage(bmp)) {",
    "                IntPtr hdc = g.GetHdc();",
    "                PrintWindow(hWnd, hdc, 2);",
    "                g.ReleaseHdc(hdc);",
    "            }",
    "            bmp.Save(outPath, ImageFormat.Png);",
    "        }",
    "        return true;",
    "    }",
    "}",
];
function buildCSharpSource() {
    return C_SHARP_SOURCE_LINES.join(String.fromCharCode(10));
}
function ensureDirFor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
function forceKillChild(child) {
    if (!child || !child.pid) {
        return;
    }
    try {
        if (PLATFORM === "win32") {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
            killer.on("error", function () {});
            killer.on("close", function () {});
        } else {
            child.kill("SIGKILL");
        }
    } catch (error) {
        // ignore
    }
}
function runCommand(command, args, options) {
    const opts = options || {};
    const timeout = opts.timeout || 30000;
    const spawnOptions = {};
    Object.keys(opts).forEach(function (key) {
        if (key !== "timeout") {
            spawnOptions[key] = opts[key];
        }
    });
    return new Promise(function (resolve) {
        let child;
        try {
            child = spawn(command, args, Object.assign({ windowsHide: true }, spawnOptions));
        } catch (error) {
            resolve({ ok: false, error: error.message, stdout: "", stderr: "" });
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer = null;
        const finish = function (payload) {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            resolve(payload);
        };
        timer = setTimeout(function () {
            // 超时后强制结束整棵进程树，避免 PowerShell 挂起导致资源泄漏。
            forceKillChild(child);
            finish({
                ok: false,
                error: "timeout after " + timeout + "ms",
                stdout: stdout,
                stderr: stderr,
            });
        }, timeout);
        if (child.stdout) {
            child.stdout.on("data", function (chunk) {
                stdout += chunk.toString();
            });
        }
        if (child.stderr) {
            child.stderr.on("data", function (chunk) {
                stderr += chunk.toString();
            });
        }
        child.on("error", function (error) {
            finish({ ok: false, error: error.message, stdout: stdout, stderr: stderr });
        });
        child.on("close", function (code) {
            finish({ ok: code === 0, code: code, stdout: stdout, stderr: stderr });
        });
    });
}
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
function buildWindowsScript() {
    const lines = [
        "param(",
        "    [Parameter(Mandatory=" + D + "true)][string]" + D + "OutputPath,",
        "    [Parameter(Mandatory=" + D + "true)][string]" + D + "Mode,",
        "    [Parameter(Mandatory=" + D + "true)][string]" + D + "CSharpFile,",
        "    [string]" + D + "WindowTitleFile = " + DQUOTE + DQUOTE,
        ")",
        "",
        // 强制输出与输入使用 UTF-8，避免中文/Unicode 窗口标题乱码导致匹配失败。
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
        D + "OutputEncoding = [System.Text.Encoding]::UTF8",
        "",
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "",
        D + "code = Get-Content -Path " + D + "CSharpFile -Raw -Encoding UTF8",
        "if (-not " + D + "code) {",
        "    Write-Error " + DQUOTE + "Failed to read C# source" + DQUOTE,
        "    exit 5",
        "}",
        "Add-Type -TypeDefinition " + D + "code -ReferencedAssemblies System.Drawing",
        "",
        // DPI 感知：避免高 DPI 显示器下截图按逻辑分辨率缩放导致尺寸/内容失真。
        "try { [WinCapture]::SetProcessDPIAware() | Out-Null } catch {}",
        "",
        "if (" + D + "Mode -eq " + DQUOTE + "screen" + DQUOTE + ") {",
        "    " + D + "bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",
        "    " +
            D +
            "bmp = New-Object System.Drawing.Bitmap " +
            D +
            "bounds.Width, " +
            D +
            "bounds.Height",
        "    " + D + "g = [System.Drawing.Graphics]::FromImage(" + D + "bmp)",
        "    " +
            D +
            "g.CopyFromScreen(" +
            D +
            "bounds.Location, [System.Drawing.Point]::Empty, " +
            D +
            "bounds.Size)",
        "    " + D + "bmp.Save(" + D + "OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)",
        "    " + D + "g.Dispose()",
        "    " + D + "bmp.Dispose()",
        "    Write-Output " + DQUOTE + "OK" + DQUOTE,
        "    exit 0",
        "}",
        "",
        "if (" + D + "Mode -eq " + DQUOTE + "window" + DQUOTE + ") {",
        "    if (-not " + D + "WindowTitleFile) {",
        "        Write-Error " + DQUOTE + "WindowTitleFile is required for window mode" + DQUOTE,
        "        exit 2",
        "    }",
        // 标题从 UTF-8 文件读取；先判空再 Trim，避免空文件时对 null 调用 Trim 报错。
        "    " +
            D +
            "windowTitle = Get-Content -LiteralPath " +
            D +
            "WindowTitleFile -Encoding UTF8 -Raw",
        "    if (" + D + "null -eq " + D + "windowTitle) {",
        "        " + D + "windowTitle = " + DQUOTE + DQUOTE,
        "    }",
        "    " + D + "windowTitle = " + D + "windowTitle.Trim()",
        "    if (-not " + D + "windowTitle) {",
        "        Write-Error " + DQUOTE + "WindowTitle is empty" + DQUOTE,
        "        exit 2",
        "    }",
        "    " + D + "hWnd = [WinCapture]::FindByTitle(" + D + "windowTitle)",
        "    if (" + D + "hWnd -eq [IntPtr]::Zero) {",
        "        Write-Error " + DQUOTE + "Window not found" + DQUOTE,
        "        exit 3",
        "    }",
        "    " + D + "ok = [WinCapture]::CaptureWindow(" + D + "hWnd, " + D + "OutputPath)",
        "    if (-not " + D + "ok) {",
        "        Write-Error " + DQUOTE + "Failed to capture window" + DQUOTE,
        "        exit 4",
        "    }",
        "    Write-Output " + DQUOTE + "OK" + DQUOTE,
        "    exit 0",
        "}",
        "",
        "Write-Error (" + DQUOTE + "Unknown mode: " + DQUOTE + " + " + D + "Mode)",
        "exit 1",
        "",
    ];
    return lines.join(String.fromCharCode(10));
}
function materializeWindowsScript() {
    return buildWindowsScript().split(D).join(DOLLAR);
}
// 枚举可见窗口标题，使用 UTF-8 输出，避免中文标题乱码。
async function listWindows() {
    if (PLATFORM !== "win32") {
        return [];
    }
    const script = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Get-Process | Where-Object { " +
            DOLLAR +
            "_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty MainWindowTitle",
    ].join(String.fromCharCode(10));
    const result = await runCommand(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        { timeout: 20000 }
    );
    if (!result.ok) {
        return [];
    }
    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}
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
