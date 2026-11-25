#!/usr/bin/env node
// Satu perintah untuk alur otomatis:
//   scan lowongan -> buat CV untuk lowongan yang belum punya -> lamar berurutan ->
//   tracker ditandai Applied -> berhenti sendiri kalau ada yang perlu diperiksa.
//
//   node otomatis.mjs                     (scan + CV + lamar)
//   node otomatis.mjs --tanpa-scan        (lewati scan, langsung CV + lamar)
//   node otomatis.mjs --hanya-cv          (hanya buat CV)
//   node otomatis.mjs --min=3.0 --maks=10 --maks-cv=20
//
// Lowongan baru hasil scan tetap butuh laporan evaluasi (skor, keputusan, teks
// lowongan) sebelum CV dan lamaran bisa dibuat. Skrip ini mencetak berapa yang
// masih menunggu evaluasi, lalu tetap memproses lowongan yang laporannya siap.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lamarSemua, daftarSiap } from './lamar-modul.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPE = path.join(ROOT, 'data', 'pipeline.md');
const OUT = path.join(ROOT, 'output');

const args = process.argv.slice(2);
const angka = (nama, bawaan) => {
  const a = args.find((x) => x === nama || x.startsWith(nama + '='));
  if (!a) return bawaan;
  const v = a.includes('=') ? a.split('=')[1] : args[args.indexOf(a) + 1];
  return Number.isFinite(Number(v)) ? Number(v) : bawaan;
};
const MIN = angka('--min', 3.0);
const MAKS = angka('--maks', 40);
const MAKS_CV = angka('--maks-cv', 20);
const tanpaScan = args.includes('--tanpa-scan');
const hanyaCv = args.includes('--hanya-cv');

const now = () => new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const catat = (s) => console.log(`[${now()}] ${s}`);

function jalankanSkrip(file, argumen = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, file), ...argumen], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 0,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message) };
  }
}

function pipelineMenunggu() {
  if (!fs.existsSync(PIPE)) return [];
  return fs
    .readFileSync(PIPE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\s*[-*]\s*\[ \]/.test(l))
    .map((l) => (l.match(/https?:\/\/[^\s)>\]]+/) || [''])[0])
    .filter(Boolean);
}

const ringkas = { mulai: new Date().toISOString(), scan: null, cv: null, lamar: null };

// ---------- 1. Scan ----------
if (!tanpaScan && !hanyaCv) {
  catat('1/3 Scan lowongan terbaru...');
  const r = jalankanSkrip('scan.mjs');
  const baris = (r.out || '').split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
  ringkas.scan = { ok: r.ok, pesan: baris || r.err };
  catat(r.ok ? `Scan selesai. ${baris}` : `Scan gagal: ${(r.err || '').split('\n')[0]}`);
} else {
  catat('1/3 Scan dilewati.');
}

const menunggu = pipelineMenunggu();
if (menunggu.length) {
  catat(`Catatan: ${menunggu.length} lowongan di data/pipeline.md belum dievaluasi. Laporan evaluasi (skor + teks lowongan) harus dibuat dulu sebelum CV dan lamaran otomatis bisa jalan.`);
}

// ---------- 2. CV ----------
catat('2/3 Membuat CV untuk lowongan yang belum punya CV...');
const r = jalankanSkrip('buat-cv-otomatis.mjs', ['--semua', `--min=${MIN}`, `--maks=${MAKS_CV}`]);
const dibuat = (r.out.match(/^OK #/gm) || []).length;
ringkas.cv = { ok: r.ok, jumlah: dibuat, pesan: (r.err || '').split('\n').filter(Boolean).slice(-3).join(' | ') };
catat(dibuat ? `CV dibuat: ${dibuat}.` : 'Semua lowongan yang siap sudah punya CV.');
if (!r.ok && r.err) catat(`Sebagian CV gagal: ${(r.err || '').split('\n')[0]}`);

if (hanyaCv) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'otomatis-terakhir.json'), JSON.stringify(ringkas, null, 2), 'utf8');
  catat('Selesai (hanya CV).');
  process.exit(0);
}

// ---------- 3. Lamar berurutan ----------
const siap = daftarSiap(MIN);
catat(`3/3 Lowongan siap dilamar: ${siap.length}.`);
ringkas.lamar = { siap: siap.length, hasil: [] };
if (!siap.length) {
  catat('Tidak ada lowongan yang siap dilamar saat ini.');
} else {
  const hasil = await lamarSemua({
    minScore: MIN,
    maks: MAKS,
    onProgres: (k) => {
      if (k.tahap === 'memproses' && k.sedang) catat(`-> #${k.sedang.num} ${k.sedang.company} — ${k.sedang.role}`);
      if (k.tahap === 'selesai-satu' && k.hasil.length) {
        const h = k.hasil[k.hasil.length - 1];
        const label = h.jeda ? 'butuh jawabanmu di Chrome' : h.berhenti ? 'BERHENTI, perlu diperiksa' : h.selesai ? 'terkirim' : h.msg || 'selesai';
        catat(`   #${h.num}: ${label}`);
      }
    },
  });
  ringkas.lamar.hasil = hasil.hasil;
  ringkas.lamar.diproses = hasil.diproses;
  const terkirim = hasil.hasil.filter((h) => h.selesai).length;
  const berhenti = hasil.hasil.filter((h) => h.berhenti || h.jeda).length;
  catat(`Selesai: ${terkirim} terkirim, ${berhenti} berhenti/perlu diperiksa, ${hasil.diproses} diproses dari ${hasil.total} yang siap.`);
  if (berhenti) catat('Buka jendela Chrome yang terbuka untuk menyelesaikan lowongan yang berhenti, lalu jalankan perintah ini lagi.');
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'otomatis-terakhir.json'), JSON.stringify(ringkas, null, 2), 'utf8');
catat('Selesai. Buka ringkasan untuk melihat centang Applied: http://localhost:3000/');
