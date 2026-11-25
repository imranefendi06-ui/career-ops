param([switch]$Simpan)
$file = "data\applications.md"
$statusBaru = "Applied"
$tanggal = Get-Date -Format "yyyy-MM-dd"
$kunci = @("Astra Sedaya","GOLDEN ABADI","Alumna Islamic School","Wijaya Manggala","Bina Sains","Global Indonesia Asia","Daya Kobelco","ZNJ","Alumna Indonesia Islamic","Ocean Space")

Copy-Item $file "data\applications.backup.md" -Force
$utf8 = New-Object System.Text.UTF8Encoding($false)
$path = (Resolve-Path $file).Path
$lines = [System.IO.File]::ReadAllLines($path, $utf8)
$ubah = 0
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -notmatch '^\|\s*\d') { continue }
  $kol = $lines[$i] -split '\|'
  foreach ($k in $kunci) {
    if ($kol[3] -like "*$k*") {
      $kol[6] = " $statusBaru "
      $notes = $kol[9].Trim()
      if ($notes -notmatch "Dilamar") { $kol[9] = " $notes. Dilamar $tanggal " }
      $lines[$i] = $kol -join '|'
      Write-Host ("UBAH: " + $kol[3].Trim() + " -> " + $statusBaru) -ForegroundColor Green
      $ubah++
      break
    }
  }
}
Write-Host "`nTotal baris diubah: $ubah (target: 10)"
if ($Simpan) {
  [System.IO.File]::WriteAllLines($path, $lines, $utf8)
  Write-Host "TERSIMPAN. Backup: data\applications.backup.md" -ForegroundColor Yellow
} else {
  Write-Host "MODE PREVIEW: belum disimpan. Jalankan dengan -Simpan untuk menyimpan." -ForegroundColor Yellow
}
