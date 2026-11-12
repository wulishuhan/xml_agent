# WeChat desktop driver (ASCII only).
#
# Why this file exists: WeChat 4.x for Windows is a Qt app. It exposes a single
# UIA element (verified: TreeScope.Descendants returns 1 node), so there is no
# accessibility tree to drive. The only reliable channel is:
#   focus window -> keyboard/clipboard into the search box -> click the row that
#   OCR located -> OCR the chat header to verify where we actually landed.
#
# Everything Chinese travels through UTF-8 files (payload / out.json); this
# script itself stays ASCII so Windows PowerShell 5.1 can decode it without a BOM.

param(
    [Parameter(Mandatory = $true)][string]$Action,
    [string]$PayloadFile = "",
    [string]$OutJson = "",
    [string]$OutPng = "",
    [string]$ExpectTitle = "",
    [double]$Scale = 2.0
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class WxWin {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr extra);

    // Is this window the one the user is actually looking at?
    public static bool IsForeground(IntPtr h) {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return false;
        return fg == h || GetAncestor(fg, 2) == h;
    }

    // Windows only lets the foreground process hand over focus. A background
    // process (we are one, spawned from a terminal or an agent) gets silently
    // refused by SetForegroundWindow, which used to look like "WeChat cannot be
    // focused".
    //
    // Escalation order matters. A synthetic ALT press is the cheapest unlock:
    // the shell treats it as user activity and drops the foreground lock.
    // AttachThreadInput is the big hammer and is tried last, because attaching
    // our input queue to a thread that is not pumping messages (a hung renderer,
    // a modal dialog) can deadlock the caller.
    public static bool ForceForeground(IntPtr h) {
        SetForegroundWindow(h);
        if (IsForeground(h)) return true;

        SwitchToThisWindow(h, true);
        if (IsForeground(h)) return true;

        keybd_event(0x12, 0, 0, IntPtr.Zero);
        keybd_event(0x12, 0, 2, IntPtr.Zero);
        SetForegroundWindow(h);
        keybd_event(0x12, 0, 0, IntPtr.Zero);
        keybd_event(0x12, 0, 2, IntPtr.Zero);
        if (IsForeground(h)) return true;

        IntPtr fg = GetForegroundWindow();
        uint fgPid = 0;
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid);
        uint me = GetCurrentThreadId();
        bool attached = false;

        if (fgThread != 0 && fgThread != me) {
            attached = AttachThreadInput(me, fgThread, true);
        }

        try {
            BringWindowToTop(h);
            SetForegroundWindow(h);
            return IsForeground(h);
        } finally {
            if (attached) AttachThreadInput(me, fgThread, false);
        }
    }

    public static string Title(IntPtr h) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    public static string Cls(IntPtr h) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        return sb.ToString();
    }

    public static List<IntPtr> VisibleWindows(uint pid) {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint wpid = 0;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid == pid && IsWindowVisible(h)) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(120);
        mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    }
}
"@

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
    })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

# ---------------------------------------------------------------- helpers

function Write-Result($obj) {
    $json = $obj | ConvertTo-Json -Depth 6 -Compress
    if ($OutJson) {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($OutJson, $json, $utf8)
    }
    Write-Output $json
}

function Read-Payload {
    if (-not $PayloadFile) { return "" }
    $text = [System.IO.File]::ReadAllText($PayloadFile, [System.Text.Encoding]::UTF8)
    if ($null -eq $text) { return "" }
    return $text.TrimEnd([char]13, [char]10)
}

function Get-WeChatProcess {
    $p = Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    return $p
}

function Get-WeChatPids {
    return @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
}

# WeChat 4.x runs several processes and its main window is not reported by
# Process.MainWindowHandle (that only finds an unowned top-level window, and
# WeChat's frame is owned). The frame is the Qt window named
# Qt51514QWindowIcon; the frameless tool windows (search dropdown, popups) use
# Qt51514QWindowToolSaveBits, which is exactly how the dropdown is told apart.
# WeChat 4.x puts several UI surfaces in the same "Qt51514QWindowIcon" class:
# the main window, but also a detached "search chat history" window and the
# image/video viewers. Picking the largest one used to grab that search window
# (726x648 beats a 296x388 tray-restored main window), and from then on every
# click and keystroke went to the wrong window -- which surfaced as
# "search dropdown not found". Aux windows are filtered out by title here.
#
# Titles are built from code points on purpose: this file must stay pure ASCII
# so PowerShell 5.1 (which decodes a BOM-less .ps1 as ANSI) can never garble it.
function U([string]$codes) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $codes.Split(" ")) {
        [void]$sb.Append([char][Convert]::ToInt32($c, 16))
    }
    return $sb.ToString()
}

# "chat history": both the detached search window and the standalone history
# window end with it, while a group chat title practically never does.
$script:AuxTitleSuffix = U "804A 5929 8BB0 5F55"
$script:AuxExactTitles = @(
    (U "641C 4E00 641C"),               # search-everything
    (U "670B 53CB 5708"),               # moments
    (U "5C0F 7A0B 5E8F"),               # mini programs
    (U "56FE 7247 67E5 770B"),          # image viewer
    (U "89C6 9891 53F7"),               # channels
    (U "8BA2 9605 53F7")                # subscriptions
)

function Test-AuxWindow([IntPtr]$hwnd) {
    $title = [WxWin]::Title($hwnd)
    if (-not $title) { return $false }
    if ($title.EndsWith($script:AuxTitleSuffix)) { return $true }
    foreach ($t in $script:AuxExactTitles) {
        if ($title -eq $t) { return $true }
    }
    return $false
}

# A minimized Qt window is still "visible" but parked far off-screen, so an
# area-largest pick can never surface it. Treat it as "restore me" instead.
function Test-Offscreen([IntPtr]$hwnd) {
    $r = New-Object WxWin+RECT
    [void][WxWin]::GetWindowRect($hwnd, [ref]$r)
    return ($r.Left -le -30000 -or $r.Top -le -30000)
}

function Close-AuxWindows {
    $closed = 0
    foreach ($pid2 in Get-WeChatPids) {
        foreach ($h in [WxWin]::VisibleWindows($pid2)) {
            if ([WxWin]::Cls($h) -notlike "Qt51514QWindowIcon*") { continue }
            if (-not (Test-AuxWindow $h)) { continue }
            [void][WxWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
            $closed++
        }
    }
    if ($closed -gt 0) { Start-Sleep -Milliseconds 350 }
    return $closed
}

function Find-MainWindow {
    $best = [IntPtr]::Zero
    $bestArea = 0
    $mini = [IntPtr]::Zero
    $miniArea = 0

    foreach ($pid2 in Get-WeChatPids) {
        foreach ($h in [WxWin]::VisibleWindows($pid2)) {
            if ([WxWin]::Cls($h) -notlike "Qt51514QWindowIcon*") { continue }
            if (Test-AuxWindow $h) { continue }
            $r = New-Object WxWin+RECT
            [void][WxWin]::GetWindowRect($h, [ref]$r)
            $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
            if (Test-Offscreen $h) {
                if ($area -gt $miniArea) { $mini = $h; $miniArea = $area }
                continue
            }
            if ($area -gt $bestArea) { $best = $h; $bestArea = $area }
        }
    }

    if ($best -ne [IntPtr]::Zero) { return $best }

    if ($mini -ne [IntPtr]::Zero) {
        [void][WxWin]::ShowWindow($mini, 9)
        Start-Sleep -Milliseconds 500
        if (-not (Test-Offscreen $mini)) { return $mini }
    }

    return [IntPtr]::Zero
}

function Capture-Window([IntPtr]$hwnd, [string]$path) {
    $r = New-Object WxWin+RECT
    [void][WxWin]::GetWindowRect($hwnd, [ref]$r)
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { return $null }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [void][WxWin]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return @{ path = $path; width = $w; height = $h; rect = $r }
}

function Crop-Png([string]$src, [string]$dst, [double]$x0, [double]$y0, [double]$x1, [double]$y1) {
    $bmp = [System.Drawing.Bitmap]::FromFile($src)
    $left = [int]($bmp.Width * $x0)
    $top = [int]($bmp.Height * $y0)
    $w = [int]($bmp.Width * ($x1 - $x0))
    $h = [int]($bmp.Height * ($y1 - $y0))
    if ($w -le 4 -or $h -le 4) { $bmp.Dispose(); return $false }
    $crop = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($crop)
    $g.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), (New-Object System.Drawing.Rectangle $left, $top, $w, $h), [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $crop.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
    $crop.Dispose()
    $bmp.Dispose()
    return $true
}

function Scale-Png([string]$src, [string]$dst, [double]$scale) {
    $bmp = [System.Drawing.Bitmap]::FromFile($src)
    $big = New-Object System.Drawing.Bitmap ([int]($bmp.Width * $scale)), ([int]($bmp.Height * $scale))
    $g = [System.Drawing.Graphics]::FromImage($big)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($bmp, 0, 0, $big.Width, $big.Height)
    $g.Dispose()
    $big.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $big.Dispose()
}

# OCR a PNG and return text lines with their vertical center (image space).
function Invoke-Ocr([string]$path) {
    $scaled = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wx-ocr-" + [guid]::NewGuid().ToString("N") + ".png")
    Scale-Png $path $scaled $Scale
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) { throw "no OCR engine for the current user profile" }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($scaled)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
    Remove-Item -LiteralPath $scaled -ErrorAction SilentlyContinue
    $lines = @()
    foreach ($line in $result.Lines) {
        $minY = 999999.0; $maxY = 0.0; $minX = 999999.0
        foreach ($word in $line.Words) {
            $r = $word.BoundingRect
            if ($r.Y -lt $minY) { $minY = $r.Y }
            if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
            if ($r.X -lt $minX) { $minX = $r.X }
        }
        $lines += [pscustomobject]@{
            text = ($line.Text -replace "\s", "")
            x    = [int]($minX / $Scale)
            cy   = [int](($minY + $maxY) / 2 / $Scale)
        }
    }
    return $lines
}

# Keep only letters/digits/CJK, fold full-width brackets, lowercase Latin
# (OCR reads "java3y" back as "java3Y"), drop OCR icon noise.
function Normalize([string]$s) {
    if (-not $s) { return "" }
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $s.ToCharArray()) {
        $c = [int]$ch
        if ($c -ge 0xFF01 -and $c -le 0xFF5E) { $ch = [char]($c - 0xFEE0) }
        $c = [int]$ch
        $isDigit = ($c -ge 48 -and $c -le 57)
        $isUpper = ($c -ge 65 -and $c -le 90)
        $isLower = ($c -ge 97 -and $c -le 122)
        $isCjk = ($c -ge 0x4E00 -and $c -le 0x9FFF)
        if ($isUpper) { $ch = [char]($c + 32) }
        if ($isDigit -or $isUpper -or $isLower -or $isCjk) { [void]$sb.Append($ch) }
    }
    $out = $sb.ToString()
    # OCR often turns the leading search icon into "0"/"O"/"Q"; strip those.
    while ($out.Length -gt 0 -and ($out[0] -eq [char]48 -or $out[0] -eq [char]79 -or $out[0] -eq [char]81)) {
        $rest = $out.Substring(1)
        $out = $rest
    }
    return $out
}

# 1.0 = exact, 0.9 = target is a substructure of candidate, else char coverage.
function Get-Similarity([string]$candidate, [string]$target) {
    $c = Normalize $candidate
    $t = Normalize $target
    if (-not $c -or -not $t) { return 0.0 }
    if ($c -eq $t) { return 1.0 }
    # subsequence coverage: OCR drops characters more often than it invents them
    $i = 0
    foreach ($ch in $c.ToCharArray()) {
        if ($i -lt $t.Length -and $ch -eq $t[$i]) { $i++ }
    }
    $coverage = $i / [double]$t.Length
    if ($coverage -ge 0.999) { return 0.92 }
    $hit = 0
    foreach ($ch in $t.ToCharArray()) {
        if ($c.IndexOf($ch) -ge 0) { $hit++ }
    }
    $bag = $hit / [double]$t.Length
    return [Math]::Max($coverage * 0.8, $bag * 0.6)
}

# Multiset character coverage: how much of the message came back in the OCR'ed
# bubble. Order does not matter because OCR splits lines arbitrarily.
function Get-Coverage([string]$candidate, [string]$target) {
    $c = Normalize $candidate
    $t = Normalize $target
    if (-not $c -or -not $t) { return 0.0 }
    $tChars = $t.ToCharArray()
    $used = New-Object bool[] $tChars.Length
    $hit = 0
    foreach ($ch in $c.ToCharArray()) {
        for ($i = 0; $i -lt $tChars.Length; $i++) {
            if (-not $used[$i] -and $tChars[$i] -eq $ch) {
                $used[$i] = $true
                $hit++
                break
            }
        }
    }
    return $hit / [double]$tChars.Length
}

# A chat title matches when it IS the target, or target + group member count.
function Test-TitleMatch([string]$title, [string]$target) {
    $t = Normalize $title
    $want = Normalize $target
    if (-not $t -or -not $want) { return $false }
    if ($t -eq $want) { return $true }
    $suffix = $t.Substring([Math]::Min($want.Length, $t.Length))
    if ($t.StartsWith($want) -and $suffix -match "^\d+$") { return $true }
    return $false
}

function Get-MainHandle {
    return Find-MainWindow
}

function Get-WeChatExe {
    $p = Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } | Select-Object -First 1
    if ($p) { return $p.Path }
    return ""
}

# Closing the window to the tray leaves the processes alive but hides the frame,
# and then every keyboard action would land on somebody else's window.
# Ctrl+Alt+W is WeChat's own show/hide hotkey and works even when the frame is
# hidden (verified: the Qt51514QWindowIcon frame flips to visible within ~1s).
# Re-launching the exe is the fallback: single instance, it just shows the
# existing window.
function Ensure-MainWindow([int]$timeoutMs = 12000) {
    $hwnd = Find-MainWindow
    if ($hwnd -ne [IntPtr]::Zero) {
        [void](Normalize-Window $hwnd)
        return $hwnd
    }

    # Nothing usable: a stray search-history window may be hogging the surface
    # while the real main window sits minimized in the tray. Close the stray
    # ones first -- they are windows this plugin itself tends to open.
    [void](Close-AuxWindows)
    $hwnd = Find-MainWindow
    if ($hwnd -ne [IntPtr]::Zero) {
        [void](Normalize-Window $hwnd)
        return $hwnd
    }

    [System.Windows.Forms.SendKeys]::SendWait("^%w")
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 2500) {
        Start-Sleep -Milliseconds 250
        $hwnd = Find-MainWindow
        if ($hwnd -ne [IntPtr]::Zero) {
            [void](Normalize-Window $hwnd)
            return $hwnd
        }
    }
    $exe = Get-WeChatExe
    if (-not $exe) { return [IntPtr]::Zero }
    try { Start-Process -FilePath $exe | Out-Null } catch { return [IntPtr]::Zero }
    $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw2.ElapsedMilliseconds -lt $timeoutMs) {
        Start-Sleep -Milliseconds 400
        $again = Find-MainWindow
        if ($again -ne [IntPtr]::Zero) {
            Start-Sleep -Milliseconds 600
            [void](Normalize-Window $again)
            return $again
        }
    }
    return [IntPtr]::Zero
}

# The window size decides where the conversation list, the search box and the
# chat column are. A mini window (296x388, what WeChat restores to after a tray
# round-trip) has no chat column at all, so it is resized to a known layout
# before any coordinate math runs.
function Normalize-Window([IntPtr]$hwnd) {
    if ($hwnd -eq [IntPtr]::Zero) { return $false }
    if ([WxWin]::IsIconic($hwnd)) {
        [void][WxWin]::ShowWindow($hwnd, 9)
        Start-Sleep -Milliseconds 450
    }
    $r = New-Object WxWin+RECT
    [void][WxWin]::GetWindowRect($hwnd, [ref]$r)
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -ge 860 -and $h -ge 520) { return $false }
    [void][WxWin]::SetWindowPos($hwnd, [IntPtr]::Zero, $r.Left, $r.Top, 1000, 700, 0x0004)
    Start-Sleep -Milliseconds 650
    return $true
}

function Focus-Main([IntPtr]$hwnd) {
    if ([WxWin]::IsIconic($hwnd)) {
        [void][WxWin]::ShowWindow($hwnd, 9)
        Start-Sleep -Milliseconds 420
    }

    # Retry a few times: right after a restore the window may not be ready to
    # take focus yet, and the foreground lock releases asynchronously.
    for ($i = 0; $i -lt 3; $i++) {
        if ([WxWin]::ForceForeground($hwnd)) {
            Start-Sleep -Milliseconds 350
            return $true
        }
        Start-Sleep -Milliseconds 400
    }

    Start-Sleep -Milliseconds 300
    return [WxWin]::IsForeground($hwnd)
}

# The search dropdown is a separate frameless tool window: PrintWindow on the
# main window never shows it, which is why rows are located on its own hwnd.
function Find-Dropdown([IntPtr]$mainHwnd, $mainRect) {
    foreach ($pid2 in Get-WeChatPids) {
        foreach ($h in [WxWin]::VisibleWindows($pid2)) {
            if ($h -eq $mainHwnd) { continue }
            if ([WxWin]::Cls($h) -notlike "Qt51514QWindowToolSaveBits*") { continue }
            $r = New-Object WxWin+RECT
            [void][WxWin]::GetWindowRect($h, [ref]$r)
            $w = $r.Right - $r.Left
            $hh = $r.Bottom - $r.Top
            if ($w -ge 180 -and $w -le 700 -and $hh -ge 120 -and $hh -le 900 -and
                $r.Left -ge ($mainRect.Left - 60) -and $r.Top -ge ($mainRect.Top - 60)) {
                return $h
            }
        }
    }
    return [IntPtr]::Zero
}

# Ctrl+F only searches the page you are on: on the favorites / moments page it
# searches that page and no chat dropdown ever appears. Two clicks fix that:
# the rail's chat icon (window-relative 40,113 - the rail is a fixed 64px column
# with the chat entry right under the avatar) and then a conversation row just
# below the search box, which always lands on the chats page.
function Repair-ChatPage([IntPtr]$hwnd, $rect) {
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    # rail offsets are fixed, the row offset scales with the list width
    $railX = $rect.Left + 40
    $railY = $rect.Top + 113
    if ($railY -gt ($rect.Bottom - 40)) { $railY = $rect.Top + 90 }
    [WxWin]::Click($railX, $railY)
    Start-Sleep -Milliseconds 450
    $rowX = $rect.Left + [int]([Math]::Min(150, $w * 0.14))
    $rowY = $rect.Top + 125
    [WxWin]::Click($rowX, $rowY)
    Start-Sleep -Milliseconds 550
    return ($railX.ToString() + "," + $railY + " -> " + $rowX + "," + $rowY)
}

# Escape is never sent: on the main window it closes the whole window to the
# tray (observed twice), and that is far worse than a leftover dropdown, which
# closes by itself as soon as focus moves.
function Set-SearchText([string]$text) {
    [void](Focus-Main $script:mainHwnd)
    [System.Windows.Forms.SendKeys]::SendWait("^f")
    Start-Sleep -Milliseconds 650
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 1900
}

function Get-ChatAreaOcr([string]$pngPath) {
    $crop = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wx-chat-" + [guid]::NewGuid().ToString("N") + ".png")
    # chat column: right of the conversation list, below the header, above the composer
    $ok = Crop-Png $pngPath $crop 0.36 0.10 0.99 0.82
    if (-not $ok) { return @() }
    $lines = Invoke-Ocr $crop
    Remove-Item -LiteralPath $crop -ErrorAction SilentlyContinue
    return $lines
}

# Header OCR runs on the whole window: cropping to a 50px strip made the
# recognizer return nothing at all, while the full window reliably reads the
# title. Lines are then filtered by position instead of by a crop box.
function Get-HeaderOcr([string]$pngPath) {
    $bmp = [System.Drawing.Bitmap]::FromFile($pngPath)
    $w = $bmp.Width
    $h = $bmp.Height
    $bmp.Dispose()
    $lines = Invoke-Ocr $pngPath
    $head = @()
    foreach ($line in $lines) {
        if ($line.cy -gt ($h * 0.135)) { continue }
        if ($line.x -lt ($w * 0.33)) { continue }
        # single glyphs in the header band are icon/control noise, not a title
        if ((Normalize $line.text).Length -lt 2) { continue }
        $head += $line
    }
    return $head
}

# ---------------------------------------------------------------- actions

$started = Get-Date
# status only reports; it must not launch WeChat just to answer "not running".
$mainHwnd = Get-MainHandle

if ($Action -eq "status") {
    if ($mainHwnd -eq [IntPtr]::Zero) {
        Write-Result ([ordered]@{ ok = $false; action = "status"; running = $false; error = "WeChat desktop is not running" })
        exit 0
    }
    $mainRect = New-Object WxWin+RECT
    [void][WxWin]::GetWindowRect($mainHwnd, [ref]$mainRect)
    $foreground = ([WxWin]::GetAncestor([WxWin]::GetForegroundWindow(), 2) -eq $mainHwnd)
    Write-Result ([ordered]@{
            ok         = $true
            action     = "status"
            running    = $true
            title      = [WxWin]::Title($mainHwnd)
            minimized  = [WxWin]::IsIconic($mainHwnd)
            foreground = $foreground
            width      = ($mainRect.Right - $mainRect.Left)
            height     = ($mainRect.Bottom - $mainRect.Top)
        })
    exit 0
}

# Window closed to tray: bring it back before any keyboard action.
if ($mainHwnd -eq [IntPtr]::Zero) {
    $mainHwnd = Ensure-MainWindow
}

if ($mainHwnd -eq [IntPtr]::Zero) {
    Write-Result ([ordered]@{ ok = $false; action = $Action; error = "WeChat desktop is not running" })
    exit 0
}

if ($Action -eq "shot") {
    if (-not $OutPng) { Write-Result ([ordered]@{ ok = $false; action = "shot"; error = "OutPng is required" }); exit 0 }
    # No Focus-Main here: PrintWindow copies pixels without the window having
    # focus, and grabbing the foreground just to take a picture steals it from
    # whatever the agent is driving (this is how the Qwen input box got lost).
    $shot = Capture-Window $mainHwnd $OutPng
    if (-not $shot) { Write-Result ([ordered]@{ ok = $false; action = "shot"; error = "capture failed" }); exit 0 }
    Write-Result ([ordered]@{ ok = $true; action = "shot"; path = $OutPng; width = $shot.width; height = $shot.height })
    exit 0
}

# Only the actions that actually type need the foreground: they send real
# keystrokes (Ctrl+F, Ctrl+V, Enter), and keystrokes go to whatever window has
# focus. read / shot only need a window capture, which PrintWindow does without
# focus -- and stealing focus from whatever the user (or the browser the agent
# is driving) is doing is both rude and disruptive: it once knocked the Qwen
# page out from under the provider mid-run.
$needsFocus = ($Action -eq "open" -or $Action -eq "send")

if ($needsFocus) {
    if (-not (Focus-Main $mainHwnd)) {
        Write-Result ([ordered]@{
                ok     = $false
                action = $Action
                error  = "WeChat window could not be focused; refusing to send keystrokes to whatever window has focus"
            })
        exit 0
    }
} elseif ([WxWin]::IsIconic($mainHwnd)) {
    # A minimized window paints nothing, so restore it -- but without taking
    # focus away from the current foreground window.
    [void][WxWin]::ShowWindow($mainHwnd, 4)
    Start-Sleep -Milliseconds 500
}

if ($Action -eq "open") {
    $target = Read-Payload
    if (-not $target) { Write-Result ([ordered]@{ ok = $false; action = "open"; error = "empty target" }); exit 0 }

    $mainRect = New-Object WxWin+RECT
    [void][WxWin]::GetWindowRect($mainHwnd, [ref]$mainRect)

    # The dropdown mixes several entry kinds under a similar label: the chat
    # itself, "search chat history", "open", "how to restore history". Only the
    # chat row lands on the conversation, so candidates are clicked in order and
    # each click is verified against the OCR'ed header title.
    $candidates = @()
    $repair = Repair-ChatPage $mainHwnd $mainRect
    Set-SearchText $target
    $dropdown = Find-Dropdown $mainHwnd $mainRect
    if ($dropdown -eq [IntPtr]::Zero) {
        # cold start / the click above opened a panel instead of the list
        $repair = Repair-ChatPage $mainHwnd $mainRect
        Set-SearchText $target
        $dropdown = Find-Dropdown $mainHwnd $mainRect
    }
    if ($dropdown -eq [IntPtr]::Zero) {
        $dump = @()
        foreach ($pid2 in Get-WeChatPids) {
            foreach ($h in [WxWin]::VisibleWindows($pid2)) {
                $r = New-Object WxWin+RECT
                [void][WxWin]::GetWindowRect($h, [ref]$r)
                $dump += ([WxWin]::Cls($h) + " " + $r.Left + "," + $r.Top + " " + ($r.Right - $r.Left) + "x" + ($r.Bottom - $r.Top))
            }
        }
        Write-Result ([ordered]@{
                ok      = $false
                action  = "open"
                error   = "search dropdown not found"
                target  = $target
                repaired = $repair
                windows = $dump
            })
        exit 0
    }
    $ddRect = New-Object WxWin+RECT
    [void][WxWin]::GetWindowRect($dropdown, [ref]$ddRect)
    $ddPng = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wx-dd-" + [guid]::NewGuid().ToString("N") + ".png")
    [void](Capture-Window $dropdown $ddPng)
    $rows = @()
    try { $rows = Invoke-Ocr $ddPng } catch { $rows = @() }
    Remove-Item -LiteralPath $ddPng -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        $score = [Math]::Round((Get-Similarity $row.text $target), 3)
        if ($score -ge 0.55) {
            $candidates += [pscustomobject]@{ text = $row.text; cy = $row.cy; score = $score }
        }
    }

    $candidates = @($candidates | Sort-Object -Property @{ Expression = "score"; Descending = $true }, @{ Expression = "cy"; Descending = $false })
    # OCR can return the same row twice (icon + text); keep one per row band.
    $unique = @()
    foreach ($c in $candidates) {
        $dup = $false
        foreach ($u in $unique) { if ([Math]::Abs($u.cy - $c.cy) -le 6) { $dup = $true } }
        if (-not $dup) { $unique += $c }
        if ($unique.Count -ge 4) { break }
    }

    if ($unique.Count -eq 0) {
        Write-Result ([ordered]@{
                ok       = $false
                action   = "open"
                target   = $target
                error    = "no search result looks like the requested chat"
                ocrLines = @($rows).Count
                ocrSample = @($rows | Select-Object -First 6 | ForEach-Object { $_.text })
                rows     = @($candidates | Select-Object -First 8)
            })
        exit 0
    }

    $tried = @()
    $title = ""
    $matched = $false
    $pick = $null
    for ($i = 0; $i -lt $unique.Count; $i++) {
        $candidate = $unique[$i]
        if ($i -gt 0) {
            # previous attempt landed on a history search or another panel: back
            # out with a single Escape, then redo the search from the main window
            Set-SearchText $target
            $dropdown = Find-Dropdown $mainHwnd $mainRect
            if ($dropdown -eq [IntPtr]::Zero) { continue }
            $ddRect = New-Object WxWin+RECT
            [void][WxWin]::GetWindowRect($dropdown, [ref]$ddRect)
        }
        $clickX = $ddRect.Left + 60
        $clickY = $ddRect.Top + $candidate.cy
        [WxWin]::Click($clickX, $clickY)
        Start-Sleep -Milliseconds 1300

        $mainPng = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wx-main-" + [guid]::NewGuid().ToString("N") + ".png")
        [void](Capture-Window $mainHwnd $mainPng)
        $head = @()
        try { $head = Get-HeaderOcr $mainPng } catch { $head = @() }
        $title = ""
        if (@($head).Count -gt 0) { $title = (@($head) | Sort-Object -Property cy | Select-Object -First 1).text }
        $ok = Test-TitleMatch $title $target
        $tried += [pscustomobject]@{ row = $candidate.text; cy = $candidate.cy; header = $title; matched = $ok }

        if ($ok) {
            $matched = $true
            $pick = $candidate
        }
        if ($OutPng) { Copy-Item -LiteralPath $mainPng -Destination $OutPng -Force }
        Remove-Item -LiteralPath $mainPng -ErrorAction SilentlyContinue
        if ($matched) { break }
    }

    Write-Result ([ordered]@{
            ok        = $matched
            action    = "open"
            target    = $target
            chatTitle = $title
            matched   = $matched
            pickedRow = $(if ($pick) { $pick.text } else { $null })
            attempts  = @($tried)
            rows      = @($unique)
            path      = $(if ($matched -and $OutPng) { $OutPng } else { $null })
            error     = $(if ($matched) { $null } else { "could not land on the requested chat; the open panel is " + $title + ". Do not send." })
        })
    exit 0
}

if ($Action -eq "read") {
    $mainPng = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wx-read-" + [guid]::NewGuid().ToString("N") + ".png")
    [void](Capture-Window $mainHwnd $mainPng)
    $head = @()
    $body = @()
    $ocrError = ""
    try { $head = Get-HeaderOcr $mainPng } catch { $ocrError += "head=" + $_.Exception.Message + " | " }
    try { $body = Get-ChatAreaOcr $mainPng } catch { $ocrError += "body=" + $_.Exception.Message + " | " }
    $title = ""
    if (@($head).Count -gt 0) { $title = (@($head) | Sort-Object -Property cy | Select-Object -First 1).text }
    if ($OutPng) { Copy-Item -LiteralPath $mainPng -Destination $OutPng -Force }
    Remove-Item -LiteralPath $mainPng -ErrorAction SilentlyContinue
    Write-Result ([ordered]@{
            ok       = $true
            action   = "read"
            title    = $title
            lines    = @($body | Sort-Object -Property cy | ForEach-Object { $_.text })
            path     = $(if ($OutPng) { $OutPng } else { $null })
            ocrError = $(if ($ocrError) { $ocrError } else { $null })
        })
    exit 0
}

if ($Action -eq "send") {
    $text = Read-Payload
    if (-not $text) { Write-Result ([ordered]@{ ok = $false; action = "send"; error = "empty message" }); exit 0 }
    $preTitle = ""

    # Safety gate: sending is the only irreversible thing this plugin does, so
    # the chat that is actually open is re-checked immediately before the paste.
    # A stale search result or a chat the user switched to by hand both land here.
    #
    # An empty OCR result is NOT a mismatch: it usually means the chat page is
    # still repainting (just switched, or the window was raised a moment ago).
    # Retry a few times so a blank frame does not turn into a false refusal;
    # a title that keeps reading wrong still ends in a refusal, never a send.
    if ($ExpectTitle) {
        $preTitle = ""

        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $prePng = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wx-pre-" + [guid]::NewGuid().ToString("N") + ".png")
            [void](Capture-Window $mainHwnd $prePng)
            $preHead = @()
            try { $preHead = Get-HeaderOcr $prePng } catch { $preHead = @() }
            Remove-Item -LiteralPath $prePng -ErrorAction SilentlyContinue

            $preTitle = ""
            if (@($preHead).Count -gt 0) {
                $preTitle = (@($preHead) | Sort-Object -Property cy | Select-Object -First 1).text
            }

            if (Test-TitleMatch $preTitle $ExpectTitle) { break }
            Start-Sleep -Milliseconds 400
        }

        if (-not (Test-TitleMatch $preTitle $ExpectTitle)) {
            Write-Result ([ordered]@{
                    ok      = $false
                    action  = "send"
                    sent    = $false
                    error   = "current chat is '" + $preTitle + "', expected '" + $ExpectTitle + "'; nothing was sent"
                    current = $preTitle
                })
            exit 0
        }
    }

    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 180
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 420
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 1500

    $mainPng = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wx-sent-" + [guid]::NewGuid().ToString("N") + ".png")
    [void](Capture-Window $mainHwnd $mainPng)
    $head = @()
    $body = @()
    try { $head = Get-HeaderOcr $mainPng } catch { $head = @() }
    try { $body = Get-ChatAreaOcr $mainPng } catch { $body = @() }
    $title = ""
    if ($head.Count -gt 0) { $title = ($head | Sort-Object -Property cy | Select-Object -First 1).text }
    if ($OutPng) { Copy-Item -LiteralPath $mainPng -Destination $OutPng -Force }
    Remove-Item -LiteralPath $mainPng -ErrorAction SilentlyContinue

    $best = 0.0
    foreach ($line in $body) {
        $s = Get-Coverage $line.text $text
        if ($s -gt $best) { $best = $s }
    }

    # A chat bubble wraps across several OCR lines, so scoring line by line can
    # never exceed 1/n -- a 3-line message capped out at 0.33 and was reported
    # as unverified while the text sat right there in the screenshot. Also score
    # the tail of the chat area as one block; coverage is order-independent, so
    # joining lines loses nothing. Only the last few lines are used so that
    # older bubbles cannot pad the score.
    $tail = @(($body | Sort-Object -Property cy | Select-Object -Last 6) | ForEach-Object { $_.text }) -join ""
    if ($tail) {
        $s = Get-Coverage $tail $text
        if ($s -gt $best) { $best = $s }
    }
    Write-Result ([ordered]@{
            ok        = $true
            action    = "send"
            chatTitle = $(if ($preTitle) { $preTitle } else { $title })
            verified  = ($best -ge 0.55)
            echoScore = [Math]::Round($best, 3)
            path      = $(if ($OutPng) { $OutPng } else { $null })
        })
    exit 0
}

Write-Result ([ordered]@{ ok = $false; action = $Action; error = "unknown action" })
exit 0
