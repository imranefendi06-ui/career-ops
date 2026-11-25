// mode-kirim.mjs — menentukan apakah akun boleh memakai kirim otomatis.
//
// Kebijakan produk (keputusan pengguna):
//   - Trial / akun belum isi ulang: MANUAL. SiapLamar menyiapkan CV dan
//     jawaban, lalu berhenti sebelum tombol Kirim di Chrome.
//   - Akun yang sudah top up: OTOMATIS, dibatasi N lamaran per hari.
//   - Pemilik: otomatis tanpa batas (keperluan operator).
//
// Batas harian resmi: 5 lamaran per hari untuk akun yang sudah top up
// (keputusan pengguna). Dibaca dari CAREER_OPS_AUTO_HARIAN di .env; angka
// di env boleh diubah operator tanpa mengubah kode.
// Hitungan disimpan per akun di {root}/data/kirim-otomatis-harian.json dan
// dipakai server sebelum membuka browser, jadi tidak bisa diubah dari UI.

import fs from 'node:fs';
import path from 'node:path';
import { bacaKuota } from './kuota.mjs';

const BATAS_DEFAULT = 5;

export function batasOtomatisHarian() {
  const n = Number(process.env.CAREER_OPS_AUTO_HARIAN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : BATAS_DEFAULT;
}

const hariIni = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD lokal
const fileHarian = (root) => path.join(path.resolve(root), 'data', 'kirim-otomatis-harian.json');

function bacaHarian(root) {
  try {
    const o = JSON.parse(fs.readFileSync(fileHarian(root), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

function tulisHarian(root, isi) {
  const file = fileHarian(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(isi, null, 2) + '\n', 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}

/** Mode kirim untuk satu akun. Selalu dikembalikan dalam bentuk aman untuk UI. */
export function bacaModeKirim(base, id, root) {
  const k = bacaKuota(base, id);
  if (!k.ok) return { ok: false, error: k.error, otomatis: false, paket: '' };
  if (k.takTerbatas) {
    return {
      ok: true, otomatis: true, paket: k.paket, alasan: 'Akun pemilik',
      batasHarian: Infinity, terpakai: 0, sisaHarian: Infinity,
    };
  }
  // paketNama diisi oleh tambahKredit() saat webhook settlement. Trial tidak
  // pernah mengisinya, sehingga 'Trial' / 'Belum ada paket' = manual.
  const premium = k.paket !== 'Trial' && k.paket !== 'Belum ada paket';
  if (!premium) {
    return {
      ok: true, otomatis: false, paket: k.paket,
      alasan: 'Kirim otomatis tersedia setelah isi ulang',
      batasHarian: 0, terpakai: 0, sisaHarian: 0,
    };
  }
  const batas = batasOtomatisHarian();
  const terpakai = Math.max(0, Number(bacaHarian(root)[hariIni()]) || 0);
  return {
    ok: true, otomatis: true, paket: k.paket, alasan: 'Fitur unggulan',
    batasHarian: batas, terpakai, sisaHarian: Math.max(0, batas - terpakai),
  };
}

/** Catat pemakaian kirim otomatis hari ini. Dipanggil server setelah lowongan diproses. */
export function catatKirimOtomatis(root, jumlah = 1) {
  const n = Math.max(0, Math.floor(Number(jumlah) || 0));
  if (!n) return { ok: false, error: 'Jumlah tidak sah.' };
  const isi = bacaHarian(root);
  const h = hariIni();
  isi[h] = (Number(isi[h]) || 0) + n;
  // Simpan 60 hari terakhir saja.
  const kunci = Object.keys(isi).sort().slice(-60);
  const bersih = Object.fromEntries(kunci.map((x) => [x, isi[x]]));
  tulisHarian(root, bersih);
  return { ok: true, terpakai: bersih[h], tanggal: h };
}
