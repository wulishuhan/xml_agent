/**
Windows 截图通道

Windows 没有跨进程的窗口枚举 API，只能让 PowerShell 编译一段 C# 再调用。
C# 源码、PowerShell 包装脚本、"枚举可见窗口"都在这里，
与主分派（./screenshot.js）分开，各自只关心自己的平台细节。

占位符 D（@@D@@）的原因见常量上方注释：写入管线会吞掉字面量美元符。
*/

const { runCommand } = require("./proc");

const PLATFORM = process.platform;
const DOLLAR = String.fromCharCode(36);
const DQUOTE = String.fromCharCode(34);
// 写入管线会破坏字面量美元符，因此脚本用占位符书写，运行时再替换为 $。
const D = "@@D@@";
// C# 源码单独写到 .cs 文件，再让 PowerShell 用 Add-Type -TypeDefinition 读取，
// 彻底避免 PowerShell here-string（@" ... "@）在不同入口/编码下的解析问题。
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

module.exports = {
    buildCSharpSource,
    buildWindowsScript,
    materializeWindowsScript,
    listWindows,
};
