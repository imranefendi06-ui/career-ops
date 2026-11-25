#!/usr/bin/env node
// cv-versi.mjs — versi CV: arsip, pratinjau perbedaan, ganti, rollback.
//
// Prinsip (mengikuti panduan career-ops):
//   - cv.md tetap SATU-SATUNYA sumber kebenaran yang dibaca alat lain.
//   - Mengganti CV selalu lewat pratinjau + konfirmasi; tidak ada penimpaan
//     diam-diam. Versi lama tidak pernah dihapus.
//   - Tidak ada LLM. Modul ini hanya menyalin, membandingkan, dan menyimpan.
//   - Semua isi berasal dari pengguna (tempel) atau dari cv.md yang sudah ada.
//
// Tata letak data (user layer, aman dari update sistem):
//   {DATA_ROOT}/data/cv/aktif.json
//   {DATA_ROOT}/data/cv/arsip/{id}/cv.md
//   {DATA_ROOT}/data/cv/arsip/{id}/meta.json
//   {DATA_ROOT}/data/cv/riwayat.tsv
//   {DATA_ROOT}/cv.md                      <- salinan CV aktif (kanonik)
//
// Semua fungsi menerima `root` (data root) supaya nanti bisa dipakai untuk
// banyak pengguna: satu proses, satu root per pengguna, tanpa state global.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { findExperienceSections } from './lib/cv-markdown.mjs';

const ID_RE = /^cv-[a-z0-9][a-z0-9-]{2,60}$/;
const BATAS_TEKS = 200_000;

const rootDari = (root) => (root ? path.resolve(root) : getCareerOpsRoot());
const dirCv = (root) => path.join(rootDari(root), 'data', 'cv');
const dirArsip = (root) => path.join(dirCv(root), 'arsip');
const fileAktif = (root) => path.join(dirCv(root), 'aktif.json');
const fileCvMd = (root) => path.join(rootDari(root), 'cv.md');
const fileRiwayat = (root) => path.join(dirCv(root), 'riwayat.tsv');

function bacaTeks(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function tulisAtomik(file, isi) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, isi, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows kadang menolak rename menimpa; fallback salin lalu hapus.
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

function capWaktu(d = new Date()) {
  const dua = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())} ${dua(d.getHours())}:${dua(d.getMinutes())}`;
}

/* ---------- Ringkasan isi CV (tanpa menilai, hanya menghitung) ---------- */

export function ringkasCv(teks) {
  const isi = String(teks ?? '').replace(/\r\n/g, '\n');
  const baris = isi ? isi.split('\n') : [];
  const heading = baris.filter((l) => /^#{1,3}\s+\S/.test(l)).map((l) => l.replace(/^#+\s*/, '').trim());
  const daftarBagian = baris.filter((l) => /^##\s+\S/.test(l)).map((l) => l.replace(/^##\s*/, '').trim());
  const cariHeading = (kata) => heading.find((h) => new RegExp(kata, 'i').test(h));

  // Pengalaman: pakai parser yang sama dengan pemeriksa CV career-ops, supaya
  // hitungan di layar tidak berbeda dengan hitungan gerbang fakta.
  let pengalaman = 0;
  try {
    pengalaman = findExperienceSections(isi).reduce((n, s) => n + s.filter((l) => /^###\s+\S/.test(l)).length, 0);
  } catch {
    pengalaman = 0;
  }

  const bagian = (kata) => {
    const idx = baris.findIndex((l) => new RegExp(`^#{2,3}\\s+.*${kata}`, 'i').test(l));
    if (idx < 0) return [];
    const keluar = [];
    for (let i = idx + 1; i < baris.length; i++) {
      if (/^#{1,3}\s+\S/.test(baris[i])) break;
      keluar.push(baris[i]);
    }
    return keluar;
  };

  const butir = (arr) => arr.filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
  const skillBaris = bagian('skill|keterampilan|kompetensi');
  let skill = butir(skillBaris);
  if (!skill) {
    // Sebagian CV menulis skill sebagai satu baris dipisah koma.
    skill = skillBaris.join(' ').split(/[,;·|]/).map((s) => s.trim()).filter(Boolean).length;
  }

  return {
    baris: baris.length,
    karakter: isi.length,
    pengalaman,
    skill,
    pendidikan: Boolean(cariHeading('education|pendidikan')),
    kontak: /@/.test(isi) || /(\+62|08)\d{6,}/.test(isi),
    punyaRingkasan: Boolean(cariHeading('summary|ringkasan|profil')),
    heading: heading.slice(0, 12),
    bagian: daftarBagian.slice(0, 30),
  };
}

export function periksaCv(teks) {
  const isi = String(teks ?? '').replace(/\r\n/g, '\n');
  const peringatan = [];
  if (!isi.trim()) {
    return { ok: false, peringatan: ['Isi CV kosong.'] };
  }
  if (isi.length > BATAS_TEKS) {
    return { ok: false, peringatan: [`Isi terlalu panjang (${isi.length} karakter, maksimal ${BATAS_TEKS}).`] };
  }
  if (/^%PDF-/.test(isi) || (isi.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length > 20) {
    return { ok: false, peringatan: ['Ini terlihat seperti berkas PDF/biner, bukan teks. Tempel teks CV-nya, bukan berkasnya.'] };
  }
  let adaPengalaman = false;
  try {
    adaPengalaman = findExperienceSections(isi).length > 0;
  } catch {
    adaPengalaman = false;
  }
  if (!adaPengalaman) {
    peringatan.push('Tidak ditemukan bagian pengalaman yang dikenali (## Experience / ## Work Experience / ## Pengalaman). Alat CV career-ops memakai judul itu untuk membaca riwayat kerja.');
  }
  if (!/^#{1,3}\s+\S/m.test(isi)) {
    peringatan.push('Tidak ada judul bagian (## ...). CV akan sulit diparse menjadi bagian Summary/Experience/Skills.');
  }
  if (!/@/.test(isi) && !/(\+62|08)\d{6,}/.test(isi)) {
    peringatan.push('Tidak terlihat email atau nomor telepon. Pastikan kontak ada di CV.');
  }
  return { ok: true, peringatan };
}

/* ---------- Perbedaan baris (untuk pratinjau) ---------- */

function barisDari(teks) {
  return String(teks ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

// LCS dengan pemangkasan awalan/akhiran. CV biasanya pendek, tapi teks tempel
// bisa panjang; di atas batas ini kita jatuh ke "ganti seluruh isi" daripada
// menghabiskan memori.
function diffBaris(lama, baru) {
  const a = barisDari(lama);
  const b = barisDari(baru);

  let depan = 0;
  while (depan < a.length && depan < b.length && a[depan] === b[depan]) depan++;
  let belakang = 0;
  while (
    belakang < a.length - depan &&
    belakang < b.length - depan &&
    a[a.length - 1 - belakang] === b[b.length - 1 - belakang]
  ) belakang++;

  const tengahA = a.slice(depan, a.length - belakang);
  const tengahB = b.slice(depan, b.length - belakang);

  const ops = [];
  for (let i = 0; i < depan; i++) ops.push({ t: '=', teks: a[i], a: i + 1, b: i + 1 });

  const n = tengahA.length;
  const m = tengahB.length;
  if (n * m > 1_500_000) {
    tengahA.forEach((l, i) => ops.push({ t: '-', teks: l, a: depan + i + 1 }));
    tengahB.forEach((l, i) => ops.push({ t: '+', teks: l, b: depan + i + 1 }));
  } else if (n && m) {
    const lebar = m + 1;
    const dp = new Uint32Array((n + 1) * lebar);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * lebar + j] = tengahA[i] === tengahB[j]
          ? dp[(i + 1) * lebar + (j + 1)] + 1
          : Math.max(dp[(i + 1) * lebar + j], dp[i * lebar + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (tengahA[i] === tengahB[j]) {
        ops.push({ t: '=', teks: tengahA[i], a: depan + i + 1, b: depan + j + 1 });
        i++; j++;
      } else if (dp[(i + 1) * lebar + j] >= dp[i * lebar + (j + 1)]) {
        ops.push({ t: '-', teks: tengahA[i], a: depan + i + 1 });
        i++;
      } else {
        ops.push({ t: '+', teks: tengahB[j], b: depan + j + 1 });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ t: '-', teks: tengahA[i], a: depan + i + 1 });
    for (; j < m; j++) ops.push({ t: '+', teks: tengahB[j], b: depan + j + 1 });
  } else if (n) {
    tengahA.forEach((l, i) => ops.push({ t: '-', teks: l, a: depan + i + 1 }));
  } else if (m) {
    tengahB.forEach((l, i) => ops.push({ t: '+', teks: l, b: depan + i + 1 }));
  }

  for (let i = 0; i < belakang; i++) {
    const ai = a.length - belakang + i;
    const bi = b.length - belakang + i;
    ops.push({ t: '=', teks: a[ai], a: ai + 1, b: bi + 1 });
  }

  const stat = {
    tambah: ops.filter((x) => x.t === '+').length,
    hapus: ops.filter((x) => x.t === '-').length,
    sama: ops.filter((x) => x.t === '=').length,
  };
  return { ops, stat };
}

// Tampilkan hanya baris berubah + 3 baris konteks, supaya layar tidak penuh.
export function diffRingkas(lama, baru, konteks = 3, maks = 400) {
  const { ops, stat } = diffBaris(lama, baru);
  const tampil = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t === '=') {
      const dekat = ops.slice(Math.max(0, i - konteks), i + konteks + 1).some((x) => x.t !== '=');
      if (dekat) tampil.push(ops[i]);
    } else {
      tampil.push(ops[i]);
    }
  }
  const dipotong = tampil.length > maks;
  return { baris: tampil.slice(0, maks), stat, dipotong, totalBaris: tampil.length };
}

/* ---------- Penyimpanan versi ---------- */

function bersihkanNama(nama) {
  return String(nama ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function idBaru(root) {
  const dasar = `cv-${capWaktu().replace(/[: ]/g, '-').toLowerCase()}`;
  let id = dasar;
  let n = 2;
  while (fs.existsSync(path.join(dirArsip(root), id))) id = `${dasar}-${n++}`;
  return id;
}

function tulisVersi(root, { teks, nama, sumber, catatan }) {
  const id = idBaru(root);
  const dir = path.join(dirArsip(root), id);
  fs.mkdirSync(dir, { recursive: true });
  tulisAtomik(path.join(dir, 'cv.md'), teks);
  const meta = {
    id,
    nama: bersihkanNama(nama) || 'Tanpa nama',
    dibuat: new Date().toISOString(),
    sumber: String(sumber || 'tempel'),
    catatan: String(catatan || '').slice(0, 300),
    baris: barisDari(teks).length,
    sha256: crypto.createHash('sha256').update(String(teks)).digest('hex'),
  };
  tulisAtomik(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function bacaMeta(root, id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const dir = path.join(dirArsip(root), id);
  if (!dir.startsWith(dirArsip(root) + path.sep)) return null;
  if (!fs.existsSync(path.join(dir, 'meta.json'))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (meta.id !== id) return null;
    return meta;
  } catch {
    return null;
  }
}

function bacaIsiVersi(root, id) {
  const meta = bacaMeta(root, id);
  if (!meta) return null;
  return { meta, teks: bacaTeks(path.join(dirArsip(root), id, 'cv.md')) };
}

function bacaPenunjuk(root) {
  try {
    const j = JSON.parse(fs.readFileSync(fileAktif(root), 'utf8'));
    return j && ID_RE.test(String(j.id)) ? j : null;
  } catch {
    return null;
  }
}

function tulisPenunjuk(root, id, nama) {
  tulisAtomik(fileAktif(root), JSON.stringify({
    id,
    nama: bersihkanNama(nama),
    diperbarui: new Date().toISOString(),
  }, null, 2));
}

function catatRiwayat(root, kolom) {
  const file = fileRiwayat(root);
  const ada = fs.existsSync(file);
  const baris = kolom.map((s) => String(s ?? '').replace(/\t/g, ' ')).join('\t');
  if (!ada) {
    tulisAtomik(file, 'waktu\taksi\tdari\tke\tnama\n' + baris + '\n');
    return;
  }
  fs.appendFileSync(file, baris + '\n', 'utf8');
}

/* ---------- API publik ---------- */

/**
 * Arsipkan isi cv.md sekarang TANPA mengubah penunjuk aktif.
 * Dipakai sebelum edit manual/luar modul, supaya isi lama tidak hilang.
 */
export function arsipkanCvSekarang(root, { nama, sumber, catatan } = {}) {
  const teks = bacaTeks(fileCvMd(root));
  if (!teks.trim()) return null;
  const penunjuk = bacaPenunjuk(root);
  const aktif = penunjuk ? bacaIsiVersi(root, penunjuk.id) : null;
  if (aktif && aktif.teks === teks) return null; // sudah terarsip
  return tulisVersi(root, {
    teks,
    nama: bersihkanNama(nama) || 'CV sebelum edit',
    sumber: sumber || 'arsip-otomatis',
    catatan: String(catatan || '').slice(0, 300),
  });
}

/**
 * Daftarkan isi cv.md sekarang sebagai versi aktif yang baru.
 * Dipakai SETELAH penulisan selesai, supaya cv.md dan arsip aktif selalu cocok.
 */
export function daftarkanCvSekarang(root, { nama, sumber, catatan } = {}) {
  const teks = bacaTeks(fileCvMd(root));
  if (!teks.trim()) return null;
  const penunjuk = bacaPenunjuk(root);
  const aktif = penunjuk ? bacaIsiVersi(root, penunjuk.id) : null;
  let meta;
  if (aktif && aktif.teks === teks) {
    meta = aktif.meta;
  } else {
    meta = tulisVersi(root, {
      teks,
      nama: bersihkanNama(nama) || 'CV aktif',
      sumber: sumber || 'edit-di-ringkasan',
      catatan: String(catatan || '').slice(0, 300),
    });
  }
  if (!penunjuk || penunjuk.id !== meta.id) {
    tulisPenunjuk(root, meta.id, meta.nama);
    catatRiwayat(root, [new Date().toISOString(), 'aktifkan', penunjuk ? penunjuk.id : '(belum ada)', meta.id, meta.nama]);
  }
  return meta;
}

export function daftarArsip(root) {
  const dir = dirArsip(root);
  if (!fs.existsSync(dir)) return [];
  const aktif = bacaPenunjuk(root);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_RE.test(d.name))
    .map((d) => {
      const meta = bacaMeta(root, d.name);
      if (!meta) return null;
      return {
        id: meta.id,
        nama: meta.nama,
        dibuat: meta.dibuat,
        sumber: meta.sumber,
        catatan: meta.catatan,
        baris: meta.baris,
        aktif: Boolean(aktif && aktif.id === meta.id),
      };
    })
    .filter(Boolean)
    .sort((x, y) => String(y.dibuat).localeCompare(String(x.dibuat)));
}

// CV bawaan akun baru berisi teks contoh dalam tanda kurung. Dua contoh yang
// disediakan di panel CV juga memakai label CONTOH. Jangan disebut "siap" —
// pakai penanda ini supaya UI meminta pengguna mengisinya sendiri.
const POLA_CV_CONTOH = /(\((Isi |Nama perusahaan|Lokasi|Posisi|Tulis |Bulan Tahun)|CONTOH\s*[—–-]\s*BUKAN CV ANDA|CONTOH\s*[—–-]\s*CV\b)/im;
export const cvAdalahContoh = (teks) => POLA_CV_CONTOH.test(String(teks || ''));

export function bacaStatusCv(root) {
  const teks = bacaTeks(fileCvMd(root));
  const penunjuk = bacaPenunjuk(root);
  const versi = penunjuk ? bacaIsiVersi(root, penunjuk.id) : null;

  let aktif;
  if (versi) {
    aktif = {
      id: versi.meta.id,
      nama: versi.meta.nama,
      dibuat: versi.meta.dibuat,
      sumber: versi.meta.sumber,
      catatan: versi.meta.catatan,
      virtual: false,
    };
  } else {
    let mtime = null;
    try {
      mtime = fs.statSync(fileCvMd(root)).mtime.toISOString();
    } catch {
      mtime = null;
    }
    aktif = {
      id: '',
      nama: 'CV aktif (belum diarsipkan)',
      dibuat: mtime,
      sumber: 'cv.md',
      catatan: 'Versi pertama akan dibuat otomatis saat Anda mengganti CV.',
      virtual: true,
    };
  }

  // Beri tahu kalau cv.md berbeda dari versi yang ditunjuk (misal diedit manual).
  const berubah = Boolean(versi && teks && teks !== versi.teks);

  return {
    aktif,
    berubahSejakArsip: berubah,
    ringkas: ringkasCv(teks),
    peringatan: periksaCv(teks).peringatan,
    arsip: daftarArsip(root),
    adaCv: Boolean(teks.trim()),
    placeholder: cvAdalahContoh(teks),
  };
}

export function bacaIsiCv(root, id) {
  if (!id) return { ok: true, teks: bacaTeks(fileCvMd(root)), id: '' };
  const v = bacaIsiVersi(root, id);
  if (!v) return { ok: false, error: 'Versi CV tidak ditemukan.' };
  return { ok: true, teks: v.teks, id: v.meta.id, meta: v.meta };
}

function tokenUntuk(teksSekarang, kunci, nama) {
  return crypto.createHash('sha256')
    .update(String(teksSekarang) + '\u0000' + String(kunci) + '\u0000' + String(nama || ''))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Pratinjau penggantian CV.
 *   { id }            -> ganti ke versi tersimpan
 *   { teks, nama }    -> tempel CV baru (belum disimpan)
 * Tidak menulis apa pun.
 */
export function pratinjauCv(root, { id, teks, nama } = {}) {
  const sekarang = bacaTeks(fileCvMd(root));
  let tujuanTeks;
  let tujuanNama;
  let kunci;

  if (id) {
    const v = bacaIsiVersi(root, id);
    if (!v) return { ok: false, error: 'Versi CV tidak ditemukan.' };
    tujuanTeks = v.teks;
    tujuanNama = v.meta.nama;
    kunci = 'id:' + id;
  } else {
    const periksa = periksaCv(teks);
    if (!periksa.ok) return { ok: false, error: periksa.peringatan[0] || 'Isi CV tidak valid.' };
    tujuanTeks = String(teks).replace(/\r\n/g, '\n');
    tujuanNama = bersihkanNama(nama) || 'CV baru ' + capWaktu();
    kunci = 'teks:' + crypto.createHash('sha256').update(tujuanTeks).digest('hex');
  }

  const hasil = diffRingkas(sekarang, tujuanTeks);
  const peringatan = periksaCv(tujuanTeks).peringatan;
  if (cvAdalahContoh(tujuanTeks)) {
    peringatan.push('Ini masih kerangka contoh fiktif. Ganti semua data bertanda kurung dan label CONTOH dengan data Anda sendiri sebelum dipakai melamar.');
  }
  if (sekarang.trim() && !hasil.stat.tambah && !hasil.stat.hapus) {
    peringatan.push('Isi CV sama persis dengan CV aktif — tidak ada yang berubah.');
  }

  return {
    ok: true,
    token: tokenUntuk(sekarang, kunci, tujuanNama),
    nama: tujuanNama,
    id: id || '',
    diff: hasil.baris,
    stat: hasil.stat,
    dipotong: hasil.dipotong,
    totalBaris: hasil.totalBaris,
    ringkasBaru: ringkasCv(tujuanTeks),
    peringatan,
  };
}

/**
 * Simpan penggantian CV. Wajib membawa token dari pratinjau dan konfirmasi.
 * Urutan: arsipkan cv.md sekarang (bila perlu) -> buat versi baru bila menempel
 * -> tulis cv.md -> perbarui penunjuk aktif -> catat riwayat.
 */
export function simpanCv(root, { token, konfirmasi, id, teks, nama, sumber } = {}) {
  if (konfirmasi !== true) {
    return { ok: false, error: 'Konfirmasi belum dicentang. Tidak ada yang ditulis.' };
  }
  const sekarang = bacaTeks(fileCvMd(root));

  let tujuanTeks;
  let tujuanNama;
  let kunci;
  if (id) {
    const v = bacaIsiVersi(root, id);
    if (!v) return { ok: false, error: 'Versi CV tidak ditemukan.' };
    tujuanTeks = v.teks;
    tujuanNama = v.meta.nama;
    kunci = 'id:' + id;
  } else {
    const periksa = periksaCv(teks);
    if (!periksa.ok) return { ok: false, error: periksa.peringatan[0] || 'Isi CV tidak valid.' };
    tujuanTeks = String(teks).replace(/\r\n/g, '\n');
    tujuanNama = bersihkanNama(nama) || 'CV baru ' + capWaktu();
    kunci = 'teks:' + crypto.createHash('sha256').update(tujuanTeks).digest('hex');
  }

  if (!token || token !== tokenUntuk(sekarang, kunci, tujuanNama)) {
    return { ok: false, error: 'CV berubah sejak pratinjau. Ulangi pratinjau sebelum menyimpan.' };
  }

  const penunjuk = bacaPenunjuk(root);
  const versiAktif = penunjuk ? bacaIsiVersi(root, penunjuk.id) : null;

  // Isi sama persis: jangan buat arsip ganda. Kalau belum ada versi sama
  // sekali, materialisasi cv.md sekarang sebagai versi pertama.
  if (!id && sekarang === tujuanTeks) {
    if (versiAktif && versiAktif.teks === sekarang) {
      return {
        ok: true,
        aktif: { id: versiAktif.meta.id, nama: versiAktif.meta.nama, dibuat: versiAktif.meta.dibuat, sumber: versiAktif.meta.sumber },
        arsipBaru: null,
        ringkas: ringkasCv(sekarang),
        pesan: 'Isi CV sama dengan versi aktif — tidak ada yang diubah.',
      };
    }
    const meta = tulisVersi(root, {
      teks: sekarang,
      nama: tujuanNama || 'CV awal',
      sumber: sumber || 'tempel',
      catatan: 'Versi pertama dari cv.md.',
    });
    tulisPenunjuk(root, meta.id, meta.nama);
    catatRiwayat(root, [new Date().toISOString(), 'aktifkan', penunjuk ? penunjuk.id : '(belum ada)', meta.id, meta.nama]);
    return {
      ok: true,
      aktif: { id: meta.id, nama: meta.nama, dibuat: meta.dibuat, sumber: meta.sumber },
      arsipBaru: null,
      ringkas: ringkasCv(sekarang),
      pesan: 'Versi pertama disimpan. cv.md tidak diubah.',
    };
  }

  const perluArsip =
    sekarang.trim() !== '' &&
    (!versiAktif || versiAktif.teks !== sekarang);

  let arsipBaru = null;
  if (perluArsip) {
    arsipBaru = tulisVersi(root, {
      teks: sekarang,
      nama: (versiAktif ? versiAktif.meta.nama : 'CV aktif') + ' (sebelum ganti)',
      sumber: 'arsip-otomatis',
      catatan: 'Disimpan otomatis sebelum CV diganti.',
    });
  }

  let target = id ? bacaIsiVersi(root, id) : null;
  if (!target) {
    target = { meta: tulisVersi(root, { teks: tujuanTeks, nama: tujuanNama, sumber: sumber || 'tempel', catatan: '' }), teks: tujuanTeks };
  }

  tulisAtomik(fileCvMd(root), target.teks);
  tulisPenunjuk(root, target.meta.id, target.meta.nama);
  catatRiwayat(root, [
    new Date().toISOString(),
    'aktifkan',
    penunjuk ? penunjuk.id : '(belum ada)',
    target.meta.id,
    target.meta.nama,
  ]);

  return {
    ok: true,
    aktif: {
      id: target.meta.id,
      nama: target.meta.nama,
      dibuat: target.meta.dibuat,
      sumber: target.meta.sumber,
    },
    arsipBaru,
    ringkas: ringkasCv(target.teks),
    pesan: 'CV aktif diganti. CV/surat yang sudah dibuat tetap memakai CV lama sampai data disegarkan.',
  };
}

export const _internal = { diffBaris, diffRingkas, tokenUntuk };
