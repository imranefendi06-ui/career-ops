param([Parameter(Mandatory=$true)][string]$Cari)
$files = "data\applications.md","data\pipeline.md","data\scan-history.tsv"
$found = $false
foreach ($f in $files) {
  if (Test-Path $f) {
    $hit = Select-String -Path $f -Pattern $Cari -SimpleMatch
    if ($hit) {
      $found = $true
      Write-Host "[$f]" -ForegroundColor Yellow
      $hit | ForEach-Object { Write-Host ("  baris " + $_.LineNumber + ": " + $_.Line.Trim()) }
    }
  }
}
if ($found) {
  Write-Host "`nSUDAH ADA di tracker. Cek kolom Status." -ForegroundColor Red
} else {
  Write-Host "`nBELUM ADA di tracker. Ini lowongan baru." -ForegroundColor Green
}
