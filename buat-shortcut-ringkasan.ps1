# Membuat shortcut "Ringkasan Lamaran" di Desktop dan di folder Startup.
$ErrorActionPreference = 'Stop'

$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$wscr = Join-Path $env:SystemRoot 'System32\wscript.exe'
$vbsBuka    = Join-Path $dir 'buka-ringkasan.vbs'
$vbsStartup = Join-Path $dir 'ringkasan-server.vbs'

$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')

$ikon = Join-Path $env:SystemRoot 'System32\shell32.dll,13'
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ($nodeExe -and (Test-Path $nodeExe)) { $ikon = "$nodeExe,0" }

function BuatShortcut {
  param($Path, $Target, $Argumen, $Nama, $Deskripsi, $Ikon)
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($Path)
  $lnk.TargetPath       = $Target
  $lnk.Arguments        = $Argumen
  $lnk.WorkingDirectory = $dir
  $lnk.WindowStyle      = 7          # minimized
  $lnk.Description      = $Deskripsi
  if ($Ikon) { $lnk.IconLocation = $Ikon }
  $lnk.Save()
  if (Test-Path $Path) { Write-Output "OK   $Nama -> $Path" }
  else { Write-Output "GAGAL $Nama" }
}

BuatShortcut -Path (Join-Path $desktop 'Ringkasan Lamaran.lnk') `
             -Target $wscr -Argumen "`"$vbsBuka`"" `
             -Nama 'Desktop' -Deskripsi 'Buka ringkasan lamaran (server dinyalakan otomatis)' -Ikon $ikon

BuatShortcut -Path (Join-Path $startup 'Ringkasan Lamaran (server).lnk') `
             -Target $wscr -Argumen "`"$vbsStartup`"" `
             -Nama 'Startup' -Deskripsi 'Menyalakan server ringkasan saat login' -Ikon $ikon

Write-Output ''
Write-Output "Desktop: $desktop"
Write-Output "Startup: $startup"
