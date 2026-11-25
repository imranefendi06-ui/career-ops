// pasang-tombol.mjs - memasang tombol "Lamar" ke ringkasan.mjs secara otomatis.
// Jalankan di folder career-ops:  node pasang-tombol.mjs
// Aman: membuat cadangan, memeriksa hasil, dan mengembalikan file asli jika ada masalah.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const target = path.join(process.cwd(), 'ringkasan.mjs');
const backup = path.join(process.cwd(), 'ringkasan.backup-sebelum-lamar.mjs');

if (!fs.existsSync(target)) {
  console.error('ringkasan.mjs tidak ditemukan. Jalankan dari folder career-ops.');
  process.exit(1);
}
if (!fs.existsSync(path.join(process.cwd(), 'lamar-modul.mjs'))) {
  console.error('lamar-modul.mjs belum ada di folder ini. Simpan dulu di folder yang sama.');
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes('bukaLamaran')) {
  console.log('Tombol Lamar sudah terpasang sebelumnya. Tidak ada yang diubah.');
  process.exit(0);
}

const lamarClientBlock = [
  "document.querySelectorAll('button.lamar').forEach((b) => {",
  "  b.addEventListener('click', async () => {",
  "    const box = b.closest('td').querySelector('.hasil');",
  "    b.disabled = true; b.textContent = 'Membuka...'; box.textContent = '';",
  "    try {",
  "      const r = await fetch('/lamar', { method: 'POST', headers: { 'Content-Type': 'application/json' },",
  "        body: JSON.stringify({ num: b.closest('tr').dataset.num }) });",
  "      const j = await r.json();",
  "      box.textContent = j.ok ? j.msg : 'Gagal: ' + j.error;",
  "    } catch (e) { box.textContent = 'Gagal: ' + e.message; }",
  "    b.disabled = false; b.textContent = 'Lamar';",
  "  });",
  "});",
  'function applyHide() {',
].join('\n');

const serverBlock = [
  "if (req.method === 'POST' && u === '/lamar') {",
  "    let b = '';",
  "    req.on('data', (d) => { b += d; });",
  "    req.on('end', async () => {",
  "      let out;",
  "      try { out = await bukaLamaran(JSON.parse(b).num); }",
  "      catch (e) { out = { ok: false, error: e.message }; }",
  "      res.writeHead(200, { 'Content-Type': 'application/json' });",
  "      res.end(JSON.stringify(out));",
  "    });",
  "    return;",
  "  }",
  "  if (req.method === 'POST' && u === '/toggle') {",
].join('\n');

const edits = [
  {
    name: 'import',
    find: "import { pathToFileURL } from 'node:url';",
    repl: "import { pathToFileURL } from 'node:url';\nimport { bukaLamaran } from './lamar-modul.mjs';",
  },
  {
    name: 'header tabel',
    find: '<th>Dilamar</th><th>Status</th>',
    repl: '<th>Dilamar</th><th>Lamar</th><th>Status</th>',
  },
  {
    name: 'tombol di baris',
    find: '<td class="st">${esc(st || \'-\')}</td>',
    repl: '<td><button class="lamar" data-num="${esc(r.num)}">Lamar</button><div class="hasil muted" style="font-size:.75rem;max-width:180px"></div></td>\n  <td class="st">${esc(st || \'-\')}</td>',
  },
  {
    name: 'script tombol',
    find: 'function applyHide() {',
    repl: lamarClientBlock,
  },
  {
    name: 'server /lamar',
    find: "if (req.method === 'POST' && u === '/toggle') {",
    repl: serverBlock,
  },
];

// Periksa dulu: setiap titik harus ditemukan tepat satu kali
let bad = false;
for (const e of edits) {
  const n = src.split(e.find).length - 1;
  if (n !== 1) {
    console.error(`Bagian "${e.name}" ditemukan ${n} kali (seharusnya 1). Tidak ada yang diubah.`);
    bad = true;
  }
}
if (bad) {
  console.error('\nFile ringkasan.mjs kamu berbeda dari versi 7. Kirim pesan ini ke Claude.');
  process.exit(1);
}

fs.copyFileSync(target, backup);
for (const e of edits) src = src.replace(e.find, () => e.repl);
fs.writeFileSync(target, src, 'utf8');

try {
  execSync(`node --check "${target}"`, { stdio: 'pipe' });
  console.log('Berhasil. Tombol Lamar terpasang di ringkasan.mjs.');
  console.log('Cadangan file asli: ringkasan.backup-sebelum-lamar.mjs');
} catch (err) {
  fs.copyFileSync(backup, target);
  console.error('Hasil edit mengandung kesalahan, file asli sudah dikembalikan.');
  console.error(String(err.stderr || err.message).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}
