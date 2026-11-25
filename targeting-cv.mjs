// targeting-cv.mjs — turunkan kata kunci dan wilayah scan dari CV yang aktif.
//
// Prinsip (source-of-truth):
//   - Satu-satunya sumber fakta adalah cv.md di root profil yang aktif, plus
//     target_roles.primary di config/profile.yml bila CV belum menghasilkan
//     kata kunci. Keduanya ditulis pengguna, bukan ditebak oleh sistem.
//   - Setiap kata kunci/wilayah menyimpan 'bukti' berpotongan teks asli. Kalau
//     tidak ada bukti, tidak ada hasil — lebih baik kosong daripada mengarang.
//   - Modul ini HANYA menyiapkan pilihan. Tidak menjalankan scan, tidak
//     menulis cv.md, tidak mengirim lamaran, dan tidak memotong kredit.
//   - Hasil bisa disimpan sebagai penimpa oleh pengguna di
//     {root}/data/targeting-cv.json (user layer).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WILAYAH } from './scan-ringkasan.mjs';

const BATAS_KATA = 14;
const fileTargeting = (root) => path.join(path.resolve(root), 'data', 'targeting-cv.json');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEMUA_PROVINSI = new Set(WILAYAH.flatMap((w) => w.provinsi.map((p) => p.nama)));
const KOTA_PER_PROVINSI = new Map(WILAYAH.flatMap((w) => w.provinsi.map((p) => [p.nama, new Set(p.kota || [])])));
const POLA_KATA = /^[\p{L}\p{N}][\p{L}\p{N} +.'&-]{1,59}$/u;
const bersihKata = (x) => String(x || '').trim().replace(/\s+/g, ' ');

// Kamus hanya menerjemahkan kata yang BENAR-BENAR muncul di CV menjadi variasi
// ejaan judul lowongan. Trigger yang tidak ada di CV tidak pernah dipakai.
const KAMUS = [
  { kata: ['Staf Administrasi', 'Administrasi', 'Admin', 'Tata Usaha', 'Admin Operasional'], pola: ['administrasi', 'admin ', 'admin.', 'tata usaha', 'perkantoran', 'clerk', 'front office'] },
  { kata: ['Data Entry', 'Input Data', 'Data Admin'], pola: ['data entry', 'input data', 'pengolahan data', 'pencatatan data', 'data admin'] },
  { kata: ['Sekretaris', 'Asisten Administrasi'], pola: ['sekretaris', 'secretary'] },
  { kata: ['Staf Operasional', 'Admin Operasional', 'Operasional'], pola: ['operasional', 'operations', 'operasi'] },
  { kata: ['Customer Service', 'Layanan Pelanggan'], pola: ['customer service', 'layanan pelanggan', 'pelayanan pelanggan'] },
  { kata: ['General Affairs', 'Office Boy', 'Office Girl'], pola: ['general affairs', 'office boy', 'office girl', 'kebersihan kantor'] },
  { kata: ['Staf Gudang', 'Admin Gudang', 'Warehouse', 'Operator Gudang'], pola: ['gudang', 'warehouse', 'logistik', 'inventory', 'penerimaan barang'] },
  { kata: ['Teknik Mesin', 'Mekanik', 'Mechanical Engineer'], pola: ['teknik mesin', 'mekanik', 'mesin', 'mechanical'] },
  { kata: ['Maintenance', 'Teknisi Maintenance', 'Perawatan Mesin'], pola: ['maintenance', 'perawatan mesin', 'pemeliharaan mesin', 'perawatan alat'] },
  { kata: ['Teknisi', 'Technician', 'Engineering Technician'], pola: ['teknisi', 'technician', 'teknik', 'engineering'] },
  { kata: ['Operator Mesin', 'Machine Operator', 'Operator Produksi'], pola: ['operator mesin', 'operator produksi', 'mesin produksi', 'operator cnc'] },
  { kata: ['Produksi', 'Manufaktur', 'Production Operator'], pola: ['produksi', 'manufaktur', 'production', 'manufacture'] },
  { kata: ['Quality Control', 'QC', 'Quality Assurance'], pola: ['quality control', 'quality assurance', 'pengendalian mutu', ' qc '] },
  { kata: ['CAD', 'AutoCAD', 'CNC'], pola: ['autocad', ' cad', 'cnc'] },
  { kata: ['Elektrik', 'Kelistrikan', 'Electrical Engineer'], pola: ['elektrik', 'kelistrikan', 'electrical'] },
  { kata: ['Refrigerasi', 'AC', 'HVAC'], pola: ['refrigerasi', 'hvac', 'pendingin', ' ac '] },
  { kata: ['Akuntansi', 'Akuntan', 'Staf Keuangan', 'Finance'], pola: ['akuntansi', 'akuntan', 'keuangan', 'finance', 'pembukuan'] },
  { kata: ['Staf Pemasaran', 'Marketing', 'Sales'], pola: ['pemasaran', 'marketing', 'sales', 'penjualan'] },
  { kata: ['IT Support', 'Teknisi Komputer', 'Helpdesk'], pola: ['it support', 'teknisi komputer', 'helpdesk', 'installasi aplikasi', 'instalasi aplikasi'] },
  { kata: ['Developer', 'Programmer', 'Software Engineer'], pola: ['developer', 'programmer', 'software engineer', 'rekayasa perangkat lunak'] },
  { kata: ['Guru', 'Pengajar', 'Tutor'], pola: ['guru', 'pengajar', 'tutor', 'mengajar'] },
  { kata: ['Driver', 'Kurir', 'Pengemudi'], pola: ['driver', 'kurir', 'pengemudi', 'pengantaran'] },
];

const potongan = (teks, indeks, panjang) => String(teks)
  .slice(Math.max(0, indeks - 40), indeks + panjang + 40)
  .replace(/\s+/g, ' ').trim().slice(0, 130);

function temukan(teks, perlu) {
  for (const p of perlu) {
    const i = teks.indexOf(p);
    if (i >= 0) return potongan(teks, i, p.length);
  }
  return '';
}

function kataDariCv(teks) {
  const hasil = [];
  for (const entri of KAMUS) {
    const bukti = temukan(teks, entri.pola);
    if (!bukti) continue;
    for (const k of entri.kata) {
      if (!hasil.some((x) => x.kata.toLowerCase() === k.toLowerCase())) {
        hasil.push({ kata: k, bukti });
      }
    }
    if (hasil.length >= BATAS_KATA) break;
  }
  return hasil.slice(0, BATAS_KATA);
}

function kataDariProfil(teksProfil) {
  const hasil = [];
  const blok = teksProfil.match(/target_roles:\s*\r?\n([\s\S]*?)(?=^\S|\r?\n\S)/m)?.[1] || '';
  for (const baris of blok.split(/\r?\n/)) {
    const m = baris.match(/^\s*-\s*["']?([^"'\n]{3,60})["']?\s*$/);
    if (!m) continue;
    const kata = m[1].trim();
    if (kata && /[\p{L}]/u.test(kata) && !hasil.some((x) => x.kata.toLowerCase() === kata.toLowerCase())) {
      hasil.push({ kata, bukti: 'config/profile.yml → target_roles.primary' });
    }
    if (hasil.length >= BATAS_KATA) break;
  }
  return hasil;
}

function wilayahDariCv(teks, kotaProfil = '') {
  const provinsi = [];
  const kota = {};
  const kotaLain = [];
  const catatProv = (nama, bukti) => {
    if (!provinsi.some((x) => x.nama === nama)) provinsi.push({ nama, bukti });
  };
  const catatKota = (prov, nama, bukti) => {
    if (!kota[prov]) kota[prov] = [];
    if (!kota[prov].some((x) => x.nama === nama)) kota[prov].push({ nama, bukti });
    catatProv(prov, bukti);
  };
  for (const pulau of WILAYAH) {
    for (const p of pulau.provinsi) {
      for (const alias of p.alias) {
        const i = teks.toLowerCase().indexOf(String(alias).toLowerCase());
        if (i >= 0) catatProv(p.nama, potongan(teks, i, String(alias).length));
      }
      for (const nama of (p.kota || [])) {
        const i = teks.toLowerCase().indexOf(String(nama).toLowerCase());
        if (i >= 0) catatKota(p.nama, nama, potongan(teks, i, String(nama).length));
      }
    }
  }
  const pilih = provinsi.slice(0, 3);
  const kotaTerpilih = {};
  for (const p of pilih) {
    if (kota[p.nama]?.length) kotaTerpilih[p.nama] = kota[p.nama].map((x) => x.nama);
  }
  if (kotaProfil && !Object.values(kotaTerpilih).flat().some((x) => x.toLowerCase() === kotaProfil.toLowerCase())) {
    const dikenal = Object.values(kotaTerpilih).flat();
    if (!dikenal.length) kotaLain.push(kotaProfil);
  }
  return {
    provinsi: pilih.map((x) => x.nama),
    buktiProvinsi: pilih,
    kota: kotaTerpilih,
    kotaLain,
    peringatan: provinsi.length > 3 ? ['CV menyebut lebih dari 3 provinsi; hanya 3 pertama yang dipakai.'] : [],
  };
}

/** Hitung target dari cv.md (dan target_roles bila perlu). Tidak menulis berkas. */
export function targetingDariCv(root) {
  const cvFile = path.join(path.resolve(root), 'cv.md');
  if (!fs.existsSync(cvFile)) {
    return { ok: false, error: 'cv.md belum ada di profil ini.', kataKunci: [], provinsi: [], kota: {}, kotaLain: [], peringatan: [] };
  }
  const teks = fs.readFileSync(cvFile, 'utf8').replace(/^\uFEFF/, '');
  const profilFile = path.join(path.resolve(root), 'config', 'profile.yml');
  const teksProfil = fs.existsSync(profilFile) ? fs.readFileSync(profilFile, 'utf8') : '';
  const kotaProfil = (teksProfil.match(/^\s{2}city:\s*["']?([^"'\n]+)["']?\s*$/m) || [])[1]?.trim() || '';

  let kata = kataDariCv(teks);
  const sumberKata = kata.length ? 'cv.md' : 'config/profile.yml';
  if (!kata.length) kata = kataDariProfil(teksProfil);

  const wil = wilayahDariCv(teks, kotaProfil);
  const peringatan = [...wil.peringatan];
  if (!kata.length) peringatan.push('Tidak ada kata jabatan yang dikenal di cv.md. Tambahkan target_roles di config/profile.yml atau isi CV dahulu.');
  if (!wil.provinsi.length) peringatan.push('Tidak ada nama provinsi/kota yang dikenal di cv.md. Pilih wilayah sendiri di panel scan.');

  return {
    ok: true,
    sumber: 'cv.md',
    sumberKata,
    cvHash: createHash('sha256').update(teks).digest('hex').slice(0, 12),
    kataKunci: kata.map((x) => x.kata),
    buktiKataKunci: kata,
    provinsi: wil.provinsi,
    buktiProvinsi: wil.buktiProvinsi,
    kota: wil.kota,
    kotaLain: wil.kotaLain,
    peringatan,
  };
}

/** Baca penimpa pengguna bila ada; kalau tidak, hitung dari CV saat ini. */
export function bacaTargeting(root) {
  const dasar = targetingDariCv(root);
  try {
    const teks = fs.readFileSync(fileTargeting(root), 'utf8');
    const o = JSON.parse(teks);
    if (!o || typeof o !== 'object') return dasar;
    const kata = Array.isArray(o.kataKunci) ? o.kataKunci.filter((x) => typeof x === 'string' && x.trim()).slice(0, BATAS_KATA) : [];
    if (!kata.length || !Array.isArray(o.provinsi) || !o.provinsi.length) return dasar;
    // Target simpanan hanya berlaku untuk CV yang sama. Setelah CV diganti,
    // hitung ulang dari CV baru supaya scan benar-benar mengikuti CV aktif.
    if (o.cvHash && dasar.cvHash && o.cvHash !== dasar.cvHash) {
      return {
        ...dasar,
        peringatan: [...(dasar.peringatan || []), 'Target simpanan diabaikan karena CV berubah; kata kunci dan wilayah dihitung ulang dari CV baru.'],
      };
    }
    return {
      ...dasar,
      sumber: 'pengguna',
      kataKunci: kata.map((x) => x.trim().slice(0, 60)),
      provinsi: o.provinsi.filter((x) => typeof x === 'string').slice(0, 3),
      kota: o.kota && typeof o.kota === 'object' && !Array.isArray(o.kota) ? o.kota : {},
      kotaLain: Array.isArray(o.kotaLain) ? o.kotaLain.filter((x) => typeof x === 'string').slice(0, 10) : [],
      disimpan: o.disimpan || '',
      cvHash: o.cvHash || dasar.cvHash,
    };
  } catch { return dasar; }
}

export function simpanTargeting(root, o) {
  try {
    const mentah = Array.isArray(o?.kataKunci) ? o.kataKunci.map(bersihKata).filter(Boolean) : [];
    const kata = mentah.filter((x) => POLA_KATA.test(x));
    const provinsi = Array.isArray(o?.provinsi) ? o.provinsi.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!kata.length) {
      return {
        ok: false,
        error: mentah.length
          ? "Kata kunci jabatan hanya boleh berisi huruf, angka, spasi, dan tanda + . ' & -."
          : 'Isi minimal satu kata kunci jabatan.',
      };
    }
    if (!provinsi.length) return { ok: false, error: 'Pilih minimal satu provinsi.' };
    const provAsing = provinsi.find((x) => !SEMUA_PROVINSI.has(x));
    if (provAsing) return { ok: false, error: 'Provinsi tidak dikenal: ' + provAsing + '.' };
    if (kata.length > BATAS_KATA) return { ok: false, error: `Maksimal ${BATAS_KATA} kata kunci.` };

    const kota = {};
    if (o.kota && typeof o.kota === 'object' && !Array.isArray(o.kota)) {
      for (const [prov, daftar] of Object.entries(o.kota)) {
        if (!provinsi.includes(prov)) continue;
        const boleh = KOTA_PER_PROVINSI.get(prov) || new Set();
        const pilih = (Array.isArray(daftar) ? daftar : []).map((x) => String(x || '').trim()).filter(Boolean);
        const asing = pilih.find((x) => !boleh.has(x));
        if (asing) return { ok: false, error: `Kota "${asing}" tidak ada di daftar ${prov}.` };
        if (pilih.length) kota[prov] = [...new Set(pilih)];
      }
    }
    const kotaLain = (Array.isArray(o.kotaLain) ? o.kotaLain : [])
      .map(bersihKata)
      .filter((x) => /^[\p{L}][\p{L} .'-]{1,39}$/u.test(x))
      .slice(0, 10);

    const d = new Date();
    const dasar = targetingDariCv(root);
    const isi = {
      versi: 1,
      disimpan: d.toISOString(),
      cvHash: dasar.cvHash || '',
      kataKunci: kata.slice(0, BATAS_KATA),
      provinsi: provinsi.slice(0, 3),
      kota,
      kotaLain,
    };
    const file = fileTargeting(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(isi, null, 2) + '\n', 'utf8');
    try { fs.renameSync(tmp, file); }
    catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
    return { ok: true, target: { ...bacaTargeting(root), ...isi } };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Ringkasan satu kalimat untuk ditampilkan di panel scan. */
export function ringkasanTargeting(t) {
  if (!t || !t.ok) return 'Target belum tersedia. Isi CV atau pilih wilayah sendiri.';
  const kata = (t.kataKunci || []).slice(0, 5).join(', ') || 'belum ada';
  const wil = (t.provinsi || []).map((p) => {
    const k = (t.kota?.[p] || []).join('/');
    return k ? `${p} (${k})` : p;
  }).join(', ') || 'belum ada';
  return `Dari ${t.sumber === 'pengguna' ? 'pilihan Anda' : t.sumber}: ${kata} · wilayah ${wil}.`;
}
