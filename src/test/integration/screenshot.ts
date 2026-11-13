import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Captures the VS Code test window (and only that window) to `$JPT_SCREENSHOT_DIR/<name>.png`.
 * Windows only; a no-op elsewhere, when the variable is unset, or when the test window cannot be found.
 * The window is found through the test process's own parent (never by title) and rendered with PrintWindow, so it is captured even when other
 * windows cover it, and nothing else on the screen can end up in the image.
 */
export function screenshot(name: string): void {
  const dir = process.env.JPT_SCREENSHOT_DIR;
  if (!dir || process.platform !== 'win32') {
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
}
"@
[W]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id ${process.ppid},${process.pid} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { exit 0 }
$r = New-Object W+RECT
[W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { exit 0 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[W]::PrintWindow($p.MainWindowHandle, $hdc, 2) | Out-Null   # PW_RENDERFULLCONTENT: works for GPU-composited windows
$g.ReleaseHdc($hdc)
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20_000, windowsHide: true });
  } catch {
    // Screenshots are diagnostics only.
  }
}
