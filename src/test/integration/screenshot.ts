import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Captures the screen to `$JPT_SCREENSHOT_DIR/<name>.png` (Windows only; no-op elsewhere or when unset).
 * Used to eyeball the real VS Code UI produced by the integration tests.
 */
export function screenshot(name: string): void {
  const dir = process.env.JPT_SCREENSHOT_DIR;
  if (!dir || process.platform !== 'win32') {
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
public struct RECT { public int Left, Top, Right, Bottom; } }
"@
[W]::SetProcessDPIAware() | Out-Null
$r = New-Object W+RECT
[W]::GetWindowRect([W]::GetForegroundWindow(), [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20_000, windowsHide: true });
  } catch {
    // Screenshots are diagnostics only.
  }
}
