# Menyalakan server ringkasan kalau belum jalan, lalu (opsional) membuka browser.
# Dipakai oleh ringkasan-server.vbs (saat login) dan buka-ringkasan.vbs (dari ikon Desktop).
#
# Catatan penting:
#  - Server hanya mendengarkan di 127.0.0.1 (IPv4). Jangan pakai "localhost":
#    Windows bisa mencoba ::1 (IPv6) lebih dulu dan menunggu sampai timeout.
#  - Pemeriksaan "server hidup" memakai TCP langsung, bukan Invoke-WebRequest,
#    supaya tidak terpengaruh proxy atau resolusi nama.
param(
  [switch]$Buka
)

$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'http://127.0.0.1:3000/'

function ServerHidup {
  $t = New-Object System.Net.Sockets.TcpClient
  try { $t.Connect('127.0.0.1', 3000); return $true }
  catch { return $false }
  finally { $t.Dispose() }
}

if (-not (ServerHidup)) {
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    foreach ($calon in @('C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe')) {
      if (Test-Path $calon) { $node = $calon; break }
    }
  }
  if (-not $node) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.MessageBox]::Show('Node.js tidak ditemukan. Pasang Node.js dulu.', 'Ringkasan Lamaran') | Out-Null
    } catch { }
    exit 1
  }
  # Browser dibuka oleh skrip ini (kalau -Buka), bukan oleh server.
  $env:RINGKASAN_TANPA_BROWSER = '1'
  Start-Process -FilePath $node -ArgumentList 'ringkasan.mjs', '3.0' -WorkingDirectory $dir -WindowStyle Hidden
  # Tunggu server siap (maksimal ~2 menit: build pertama membaca semua report).
  for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Milliseconds 500
    if (ServerHidup) { break }
  }
}

# explorer.exe dipakai supaya jendela browser tampil normal walaupun skrip ini
# dijalankan tersembunyi dari VBS.
if ($Buka) { & explorer.exe $url }
