#!/usr/bin/env node
// backup-otomatis.mjs — salin data user layer SiapLamar ke folder backup.
//
// Pemakaian:
//   node backup-otomatis.mjs              # jalankan backup sekarang
//   node backup-otomatis.mjs --dry-run    # hanya hitung, jangan salin
//
// Konfigurasi lewat environment / .env:
//   BACKUP_DIR      tujuan backup (default: {DATA_ROOT}/backup)
//   BACKUP_RETENSI  jumlah backup terakhir yang disimpan (default: 7)
//
// Yang disalin: cv.md, artikel/profile/voice, portals.yml, .env, config/,
// data/ (tanpa data/cache/), reports/, jds/, interview-prep/, output/,
// pengguna/, dan modes/_profile.md|_custom.md|_brief.md.
// File .env ikut disalin karena restore harus lengkap — jangan taruh folder
// backup di tempat yang bisa diakses orang lain.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getCareerOpsRoot } from './path-resolver.mjs';

dotenv.config({ quiet: true });

const kering = process.argv.includes('--dry-run');
const root = path.resolve(getCareerOpsRoot());
if (root !== path.dirname(fileURLToPath(import.meta.url))) {
  dotenv.config({ path: path.join(root, '.env'), quiet: true });
}

const tujuan = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backup'));
const retensi = Math.max(1, Number(process.env.BACKUP_RETENSI || 7) || 7);
const YANG_DISALIN = [
  'cv.md', 'article-digest.md', 'voice-dna.md', 'portals.yml', '.env',
  'config', 'data', 'reports', 'jds', 'interview-prep', 'output', 'pengguna',
  'modes/_profile.md', 'modes/_custom.md', 'modes/_brief.md',
  // Kode SiapLamar belum di-commit ke git, jadi ikut disalin. Tanpa ini backup
  // hanya berisi data dan tidak bisa dipakai untuk menjalankan ulang server.
  'templates', 'package.json', 'package-lock.json',
  'ringkasan-auto.ps1', 'buat-shortcut-ringkasan.ps1', 'tandai-dilamar.ps1',
  '.lamar-hitung.json', '.lamar-scan-ditutup.json', '.lamar-scan-selesai.json',
  'surat-profil.json',
];
// Semua modul .mjs di root kecuali skrip sementara tmp-*.
const KODE_MJS = fs.readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.startsWith('tmp-'))
  .map((e) => e.name)
  .sort();
const PENTING = [
  'cv.md', '.env', 'data/pengguna.json', 'data/applications.md',
  'config/profile.yml', 'data/profil-lokal.json',
  'ringkasan.mjs', 'auth-pengguna.mjs', 'profil-lokal.mjs',
  'email-kirim.mjs', 'pembayaran.mjs', 'backup-otomatis.mjs',
];

const dua = (n) => String(n).padStart(2, '0');
const cap = (d) => `${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())}`
  + `_${dua(d.getHours())}${dua(d.getMinutes())}${dua(d.getSeconds())}`;
const lewati = (rel) => {
  const p = rel.split(path.sep).join('/');
  return p.startsWith('data/cache/') || p.startsWith('backup/')
    || p.startsWith('.git/') || p.includes('/node_modules/')
    || /(^|\/)\.tmp-/.test(p);
};

let jumlahFile = 0;
let totalByte = 0;
function salin(sumber, rel, dest) {
  const st = fs.statSync(sumber);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(sumber).sort()) {
      const r = rel ? path.join(rel, n) : n;
      if (lewati(r)) continue;
      salin(path.join(sumber, n), r, dest);
    }
    return;
  }
  jumlahFile += 1;
  totalByte += st.size;
  if (kering) return;
  const target = path.join(dest, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(sumber, target);
}

const hashFile = (p) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch { return ''; }
};

const sekarang = new Date();
const nama = cap(sekarang);
const sementara = path.join(tujuan, `.tmp-${nama}-${process.pid}`);
const akhir = path.join(tujuan, nama);

if (!kering) fs.mkdirSync(sementara, { recursive: true });
for (const entri of [...YANG_DISALIN, ...KODE_MJS]) {
  const sumber = path.join(root, entri);
  if (!fs.existsSync(sumber)) continue;
  salin(sumber, entri, sementara);
}

let dihapus = [];
if (!kering) {
  const manifest = {
    waktu: sekarang.toISOString(),
    root: path.relative(tujuan, root).split(path.sep).join('/') || '.',
    jumlahFile,
    totalByte,
    megaByte: Math.round((totalByte / 1024 / 1024) * 10) / 10,
    hash: Object.fromEntries(PENTING.map((p) => [p, hashFile(path.join(root, p))])),
    diLewati: 'data/cache/, .git/, node_modules/, backup/',
  };
  fs.writeFileSync(path.join(sementara, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(sementara, akhir);

  const lama = fs.readdirSync(tujuan)
    .filter((n) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(n))
    .sort();
  while (lama.length > retensi) {
    const korban = lama.shift();
    fs.rmSync(path.join(tujuan, korban), { recursive: true, force: true });
    dihapus.push(korban);
  }
  fs.appendFileSync(path.join(tujuan, 'log.txt'),
    `${sekarang.toISOString()}\t${nama}\t${jumlahFile} file\t${manifest.megaByte} MB\t${manifest.hash['cv.md'].slice(0, 12)}\n`, 'utf8');
}

console.log(JSON.stringify({
  ok: true,
  kering,
  folder: kering ? '' : akhir,
  tujuan,
  jumlahFile,
  megaByte: Math.round((totalByte / 1024 / 1024) * 10) / 10,
  retensi,
  dihapus,
}, null, 2));
