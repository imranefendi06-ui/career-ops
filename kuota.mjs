// kuota.mjs — kredit lamaran per akun dan bukti pemakaiannya.
//
// Aturan bisnis (disetujui pengguna):
//   - Trial: 3 kredit setelah email terverifikasi.
//   - Pemilik: tidak terbatas (operator tidak dikenakan kredit).
//   - 1 kredit = 1 lowongan yang diproses lewat tombol Lamar / Lamar Semua Siap.
//   - Scan, filter, preset, detail, dan ganti profil tidak memotong kredit.
//   - Kunci idempotensi mencegah pemotongan ganda bila lowongan yang sama
//     diproses ulang karena gagal atau perlu jawaban manual.
//
// Registry kredit mengikuti akun: {BASE_ROOT}/data/pengguna.json.
// Riwayat mengikuti root data akun: {root}/data/kuota-log.tsv.

import fs from 'node:fs';
import path from 'node:path';

export const HARGA = {
  trial: { kredit: 3, harga: 0 },
  paket: [
    { kredit: 10, harga: 30000 },
    { kredit: 30, harga: 75000, utama: true },
    { kredit: 60, harga: 120000 },
  ],
  bulanan: { harga: 89000, kredit: 40, maksTumpuk: 80 },
  masaAktifHari: 90,
};

const fileAkun = (base) => path.join(path.resolve(base), 'data', 'pengguna.json');

function muat(base) {
  const file = fileAkun(base);
  if (!fs.existsSync(file)) return { versi: 1, daftar: [] };
  const o = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') || '{}');
  if (!o || !Array.isArray(o.daftar)) throw new Error('Daftar akun rusak.');
  return { versi: 1, daftar: o.daftar };
}

function tulisAtomik(file, isi) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, isi, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}

function simpan(base, isi) {
  tulisAtomik(fileAkun(base), JSON.stringify(isi, null, 2) + '\n');
}

const waktu = () => {
  const d = new Date();
  const dua = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())} ${dua(d.getHours())}:${dua(d.getMinutes())}:${dua(d.getSeconds())}`;
};

const bersih = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 160);
const fileLog = (root) => path.join(path.resolve(root), 'data', 'kuota-log.tsv');
const HEADER = 'waktu\takun\tkunci\tketerangan\tperubahan\tsisa';

function bacaBaris(root) {
  const file = fileLog(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
}

export function bacaKuota(base, id) {
  try {
    const u = muat(base).daftar.find((x) => x && x.id === id);
    if (!u) return { ok: false, error: 'Akun tidak ditemukan.' };
    if (u.pemilik) return {
      ok: true, takTerbatas: true, sisa: Infinity,
      paket: 'Pemilik', email: u.email || '', terverifikasi: true,
    };
    return {
      ok: true, takTerbatas: false,
      sisa: Math.max(0, Number(u.sisaKredit) || 0),
      paket: u.paketNama || (u.trialDiberikan ? 'Trial' : 'Belum ada paket'),
      email: u.email || '', terverifikasi: !!u.emailTerverifikasi,
      trialDiberikan: !!u.trialDiberikan,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function bisaPakai(base, id, jumlah = 1) {
  const k = bacaKuota(base, id);
  return !!(k.ok && (k.takTerbatas || k.sisa >= jumlah));
}

function sudahDicatat(root, id, kunci) {
  return bacaBaris(root).some((baris) => {
    const c = baris.split('\t');
    return c[1] === id && c[2] === kunci && Number(c[4]) < 0;
  });
}

function tulisBaris(root, kolom) {
  const file = fileLog(root);
  const ada = fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim();
  const isi = (ada ? '' : HEADER + '\n') + kolom.join('\t') + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, isi, 'utf8');
}

/** Call before charging. Returns sisa terbaru; idempoten per (akun, kunci). */
export function catatPemakaian(base, id, { root, kunci, keterangan = '' }) {
  const k = bacaKuota(base, id);
  if (!k.ok) return { ok: false, error: k.error, sisa: 0 };
  const kunciBersih = bersih(kunci);
  if (!kunciBersih) return { ok: false, error: 'Kunci pemakaian kosong.', sisa: k.sisa };
  if (sudahDicatat(root, id, kunciBersih)) {
    return { ok: true, sudahAda: true, sisa: k.sisa, takTerbatas: k.takTerbatas };
  }
  if (!k.takTerbatas && k.sisa < 1) {
    return { ok: false, error: 'Kredit habis. Isi ulang atau tunggu siklus bulanan.', sisa: k.sisa };
  }
  let sisaBaru = k.sisa;
  if (!k.takTerbatas) {
    const isi = muat(base);
    const u = isi.daftar.find((x) => x && x.id === id);
    if (!u) return { ok: false, error: 'Akun tidak ditemukan.', sisa: k.sisa };
    u.sisaKredit = Math.max(0, (Number(u.sisaKredit) || 0) - 1);
    sisaBaru = u.sisaKredit;
    simpan(base, isi);
  }
  tulisBaris(root, [
    waktu(), id, kunciBersih, bersih(keterangan), -1,
    k.takTerbatas ? 'tanpa-batas' : sisaBaru,
  ]);
  return { ok: true, sudahAda: false, sisa: sisaBaru, takTerbatas: k.takTerbatas };
}

/** Dipakai gateway pembayaran nanti; sekarang disiapkan agar alurnya saturu. */
export function tambahKredit(base, id, jumlah, keterangan, root) {
  const n = Math.floor(Number(jumlah));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Jumlah kredit tidak sah.' };
  const isi = muat(base);
  const u = isi.daftar.find((x) => x && x.id === id);
  if (!u) return { ok: false, error: 'Akun tidak ditemukan.' };
  if (u.pemilik) return { ok: true, sisa: Infinity, takTerbatas: true };
  u.sisaKredit = (Number(u.sisaKredit) || 0) + n;
  u.paketNama = bersih(keterangan) || 'Isi ulang';
  simpan(base, isi);
  tulisBaris(root, [waktu(), id, 'topup:' + Date.now(), bersih(keterangan), n, u.sisaKredit]);
  return { ok: true, sisa: u.sisaKredit };
}

export function riwayatKuota(root, batas = 40) {
  return bacaBaris(root).slice().reverse().slice(0, batas).map((baris) => {
    const c = baris.split('\t');
    return {
      waktu: c[0] || '', kunci: c[2] || '', keterangan: c[3] || '',
      perubahan: Number(c[4]) || 0, sisa: c[5] || '',
    };
  });
}
