# Lance PDFReader, attend, capture sa fenêtre en PNG (PrintWindow, contenu WebView2 compris), puis la ferme.
# Outil de développement : captures pour replica/clone-screens (comparaison avec /replica-diff).
#   powershell -File tools/capture-window.ps1 -Exe target\release\pdfreader-desktop.exe -Out replica\clone-screens\S03.png [-Arg fichier.pdf] [-Wait 4]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Arg = "",
  [int]$Wait = 4,
  [int]$Width = 1440,
  [int]$Height = 900
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@

$env:PDFREADER_DEV = "1"
$p = if ($Arg) { Start-Process -FilePath $Exe -ArgumentList "`"$Arg`"" -PassThru } else { Start-Process -FilePath $Exe -PassThru }
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 200; $p.Refresh(); $h = $p.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) { Write-Error "fenêtre introuvable"; Stop-Process -Id $p.Id -Force; exit 1 }
[Win]::MoveWindow($h, 20, 20, $Width, $Height, $true) | Out-Null
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Seconds $Wait
$r = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win]::PrintWindow($h, $hdc, 2) | Out-Null   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc); $g.Dispose()
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$bmp.Save((Resolve-Path -LiteralPath (Split-Path $Out)).Path + "\" + (Split-Path $Out -Leaf), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Stop-Process -Id $p.Id -Force
Write-Output "capture : $Out"
