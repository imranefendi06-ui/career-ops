#!/usr/bin/env node
// profil-lokal.mjs — daftar profil lokal untuk satu proses ringkasan.
//
// Prinsip:
//   - Satu server, satu profil aktif. Profil "utama" memakai data root yang
//     sudah ada (tidak disalin/dipindahkan). Profil lain punya data root sendiri
//     di bawah {DATA_ROOT}/profil/{id}/.
//   - Registry dan semua data profil berada di user layer, bukan system layer.
//   - Profil baru dimulai KOSONG. Tidak ada CV, gaji, lokasi, pengalaman, atau
//     skor yang disalin/ditambahkan dari profil lain.
//   - Tidak ada autentikasi atau isolasi antar-pengguna di fase ini: ini untuk
//     satu PC, satu pengguna. Jalur sudah disiapkan agar nanti bisa dipetakan
//     ke root per-pengguna.
//   - Tidak ada penghapusan profil: data tidak pernah dibuang diam-diam.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCareerOpsRoot } from './path-resolver.mjs';

const BATAS_PROFIL = 12;
const akarDari = (base) => path.resolve(base || getCareerOpsRoot());
const fileDaftar = (base) => path.join(akarDari(base), 'data', 'profil-lokal.json');
const idValid = (id) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(id || ''));
const dua = (n) => String(n).padStart(2, '0');

const waktu = () => {
  const d = new Date();
  return `${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())} ${dua(d.getHours())}:${dua(d.getMinutes())}`;
};
const tulisAtomik = (file, isi) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, isi, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
};
const teksAwal = (file, isi) => { if (!fs.existsSync(file)) fs.writeFileSync(file, isi, 'utf8'); };

function muat(base) {
  const file = fileDaftar(base);
  if (!fs.existsSync(file)) {
    return {
      versi: 1,
      aktif: 'utama',
      daftar: [{ id: 'utama', nama: 'Profil Utama', root: null, dibuat: waktu() }],
    };
  }
  const o = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') || '{}');
  if (!o || !Array.isArray(o.daftar) || !o.daftar.length) throw new Error('Daftar profil rusak.');
  const daftar = o.daftar.filter((p) => p && idValid(p.id) && typeof p.nama === 'string');
  if (!daftar.length) throw new Error('Daftar profil tidak berisi profil yang sah.');
  const aktif = daftar.some((p) => p.id === o.aktif) ? o.aktif : daftar[0].id;
  return { versi: 1, aktif, daftar };
}
function simpan(base, isi) { tulisAtomik(fileDaftar(base), JSON.stringify(isi, null, 2) + '\n'); }

/** Root data absolut untuk sebuah id profil. null/root = root utama. */
export function rootProfilLokal(base, id) {
  const isi = muat(base);
  const p = isi.daftar.find((x) => x.id === id);
  if (!p) return null;
  return p.root ? path.resolve(akarDari(base), p.root) : akarDari(base);
}

export function bacaProfilAktif(base) {
  try {
    const isi = muat(base);
    const p = isi.daftar.find((x) => x.id === isi.aktif) || isi.daftar[0];
    return { ok: true, profil: { ...p, rootAktual: rootProfilLokal(base, p.id) } };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function daftarProfil(base) {
  try {
    const isi = muat(base);
    const daftar = isi.daftar.map((p) => ({
      ...p,
      rootAktual: rootProfilLokal(base, p.id),
      utama: p.id === 'utama',
    }));
    return { ok: true, aktif: isi.aktif, daftar, batas: BATAS_PROFIL };
  } catch (e) { return { ok: false, error: e.message }; }
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'profil';

const CV_KOSONG = `# CV

## Summary

(Isi ringkasan Anda sendiri di sini.)

## Experience

### (Nama perusahaan) — (Lokasi)

**(Posisi)**  
(Bulan Tahun) — (Bulan Tahun)

- (Tulis pengalaman dan capaian yang benar-benar Anda miliki.)

## Education

- (Isi pendidikan Anda.)

## Skills

- (Isi keahlian Anda.)
`;

const TRACKER_KOSONG = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

const PROFIL_KOSONG = `# Konfigurasi profil (kosong)

Jangan mengisi fakta di berkas ini tanpa konfirmasi pemilik profil.

language:
  output: id

candidate:
  full_name: ""
  email: ""
  location: ""

target_roles:
  primary: []
  archetypes: []

compensation:
  target_range: ""
  minimum: ""
  currency: IDR
`;

export function siapkanRootKosong(root) {
  for (const d of ['data', 'data/cv/arsip', 'reports', 'output', 'config',
    'batch/tracker-additions', 'jds', 'interview-prep']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  teksAwal(path.join(root, 'cv.md'), CV_KOSONG);
  teksAwal(path.join(root, 'data', 'applications.md'), TRACKER_KOSONG);
  teksAwal(path.join(root, 'data', 'pipeline.md'), '# Pipeline — Pending URLs\n\n## Pending\n\n');
  teksAwal(path.join(root, 'data', 'scan-history.tsv'),
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\trequisition_id\tlanguage\tlisting_key\tcloses_at\n');
  teksAwal(path.join(root, 'config', 'profile.yml'), PROFIL_KOSONG);
}

export function buatProfilLokal(base, o) {
  try {
    const nama = String(o?.nama ?? '').trim().slice(0, 60);
    if (!nama) return { ok: false, error: 'Nama profil wajib diisi.' };
    const isi = muat(base);
    if (isi.daftar.length >= BATAS_PROFIL) {
      return { ok: false, error: `Maksimal ${BATAS_PROFIL} profil lokal. Hapus berkas profil manual bila perlu.` };
    }
    if (isi.daftar.some((p) => p.nama.trim().toLowerCase() === nama.toLowerCase())) {
      return { ok: false, error: 'Nama profil sudah ada.' };
    }
    let id = slug(nama) + '-' + crypto.randomBytes(3).toString('hex');
    while (isi.daftar.some((p) => p.id === id)) id = slug(nama) + '-' + crypto.randomBytes(3).toString('hex');
    const rel = path.join('profil', id);
    const root = path.resolve(akarDari(base), rel);
    if (!root.startsWith(akarDari(base) + path.sep)) return { ok: false, error: 'Lokasi profil tidak sah.' };
    siapkanRootKosong(root);
    const profil = { id, nama, root: rel.split(path.sep).join('/'), dibuat: waktu() };
    isi.daftar.push(profil);
    simpan(base, isi);
    return { ok: true, profil: { ...profil, rootAktual: root } };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function pakaiProfilLokal(base, id) {
  try {
    const isi = muat(base);
    if (!isi.daftar.some((p) => p.id === id)) return { ok: false, error: 'Profil tidak ditemukan.' };
    const root = rootProfilLokal(base, id);
    if (!fs.existsSync(root)) return { ok: false, error: 'Folder data profil tidak ditemukan.' };
    isi.aktif = id;
    simpan(base, isi);
    return { ok: true, profil: { ...isi.daftar.find((p) => p.id === id), rootAktual: root } };
  } catch (e) { return { ok: false, error: e.message }; }
}
