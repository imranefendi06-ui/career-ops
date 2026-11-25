// periksa.mjs - memeriksa apakah semua bagian sudah terpasang dan berjalan.
// Jalankan di folder career-ops:  node periksa.mjs
// Hanya membaca, tidak mengubah apa pun.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const P = (...a) => path.join(ROOT, ...a);
let masalah = 0;
const ok = (t) => console.log(`  [OK]    ${t}`);
const no = (t, saran) => { masalah++; console.log(`  [KURANG] ${t}\n           -> ${saran}`); };
const judul = (t) => console.log(`\n${t}`);

console.log(`Folder: ${ROOT}`);

judul('1. File yang dibutuhkan');
for (const f of ['ringkasan.mjs', 'lamar-modul.mjs', 'pasang-tombol.mjs', 'rekam.mjs']) {
  if (fs.existsSync(P(f))) ok(f);
  else no(`${f} tidak ada`, `unduh dari chat lalu pindahkan ke ${ROOT}`);
}

judul('2. Tombol Lamar sudah dipasang di ringkasan.mjs?');
if (fs.existsSync(P('ringkasan.mjs'))) {
  const s = fs.readFileSync(P('ringkasan.mjs'), 'utf8');
  const cek = [
    ["import { bukaLamaran }", 'baris import'],
    ['<th>Lamar</th>', 'header kolom Lamar'],
    ['class="lamar"', 'tombol di tiap baris'],
    ["button.lamar", 'skrip klik tombol'],
    ["u === '/lamar'", 'server /lamar'],
  ];
  let kurang = 0;
  for (const [kata, nama] of cek) {
    if (s.includes(kata)) ok(nama);
    else { kurang++; no(`${nama} belum ada`, 'jalankan: node pasang-tombol.mjs'); }
  }
  if (kurang === 0) {
    try { execSync(`node --check "${P('ringkasan.mjs')}"`, { stdio: 'pipe' }); ok('ringkasan.mjs tidak ada kesalahan penulisan'); }
    catch (e) { no('ringkasan.mjs ada kesalahan penulisan', 'kirim pesan ini ke Claude:\n' + String(e.stderr).split('\n').slice(0, 6).join('\n')); }
  }
}
if (fs.existsSync(P('lamar-modul.mjs'))) {
  try { execSync(`node --check "${P('lamar-modul.mjs')}"`, { stdio: 'pipe' }); ok('lamar-modul.mjs tidak ada kesalahan penulisan'); }
  catch (e) { no('lamar-modul.mjs ada kesalahan penulisan', 'unduh ulang file dari chat'); }
}

judul('3. Playwright dan Google Chrome');
try { await import('playwright'); ok('playwright terpasang'); }
catch { no('playwright belum terpasang', 'jalankan: npm install playwright'); }
const chromePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];
if (chromePaths.some((p) => fs.existsSync(p))) ok('Google Chrome ditemukan');
else no('Google Chrome tidak ditemukan di lokasi umum', 'pasang Google Chrome, atau kirim pesan ini ke Claude');

judul('4. Folder dan data career-ops');
for (const [rel, saran] of [['reports', 'jalankan dari folder career-ops'], ['output', 'jalankan node ringkasan.mjs dulu'], ['data/applications.md', 'tracker belum ada']]) {
  if (fs.existsSync(P(...rel.split('/')))) ok(rel);
  else no(`${rel} tidak ada`, saran);
}
if (fs.existsSync(P('output'))) {
  const f = fs.readdirSync(P('output'));
  const cv = f.filter((x) => /^cv-.*\.pdf$/i.test(x)).length;
  const surat = f.filter((x) => /^surat-lamaran-.*\.pdf$/i.test(x)).length;
  console.log(`  [INFO]  CV PDF: ${cv} | Surat lamaran PDF: ${surat}`);
  if (cv === 0) no('belum ada CV PDF di output', 'buat CV lowongan lewat proses career-ops');
}

judul('5. Halaman ringkasan terakhir yang dibuat');
if (fs.existsSync(P('output', 'RINGKASAN-LAMARAN.html'))) {
  const h = fs.readFileSync(P('output', 'RINGKASAN-LAMARAN.html'), 'utf8');
  if (h.includes('class="lamar"')) ok('halaman sudah punya tombol Lamar');
  else no('halaman belum punya tombol Lamar', 'setelah pasang-tombol.mjs, jalankan ulang node ringkasan.mjs');
} else no('RINGKASAN-LAMARAN.html belum dibuat', 'jalankan: node ringkasan.mjs');

judul('6. Server di port 3000');
const jalan = await new Promise((res) => {
  const s = net.connect(3000, '127.0.0.1');
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});
if (!jalan) {
  console.log('  [INFO]  server belum jalan (normal jika ringkasan.mjs sedang tidak dibuka)');
} else {
  try {
    const r = await fetch('http://127.0.0.1:3000/lamar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ num: '000' }) });
    const t = await r.text();
    if (r.status === 404) no('server di port 3000 adalah versi LAMA (belum ada /lamar)', 'matikan: netstat -ano | findstr :3000 lalu taskkill /PID <angka> /F, kemudian node ringkasan.mjs');
    else ok('server di port 3000 sudah versi baru (endpoint /lamar aktif)');
  } catch (e) { no('gagal menguji server', e.message); }
}

judul('7. Persiapan login dan rekaman');
if (fs.existsSync(P('.browser-profile'))) ok('profil Chrome ada (login JobStreet tersimpan jika sudah pernah login)');
else console.log('  [INFO]  profil Chrome belum ada; akan dibuat saat tombol Lamar pertama diklik, lalu login JobStreet');
const rek = fs.readdirSync(ROOT).filter((x) => /^rekam-\d+\.txt$/.test(x));
if (rek.length) ok(`hasil rekaman ada: ${rek.join(', ')}`);
else console.log('  [INFO]  belum ada rekam-*.txt (jalankan rekam.mjs dengan link lowongan asli agar unggah CV bisa dipastikan)');

console.log(masalah === 0 ? '\nSemua pemeriksaan lolos.' : `\nAda ${masalah} hal yang perlu dibereskan, lihat tanda [KURANG] di atas.`);
