#!/usr/bin/env node
// scan-preset.mjs — simpan, muat, dan hapus preset pencarian lowongan.
//
// Prinsip:
//   - Preset HANYA menyimpan pilihan yang memang dibuat pengguna di panel scan.
//     Tidak ada fakta lowongan, gaji, atau wilayah yang ditambahkan sendiri.
//   - Menyimpan preset tidak menjalankan scan dan tidak mengirim lamaran.
//   - Data user layer: {DATA_ROOT}/data/scan-presets.json.
//   - Semua fungsi menerima `root` agar satu proses bisa melayani banyak profil
//     (satu root per profil) tanpa state global.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { WILAYAH } from './scan-ringkasan.mjs';

const BATAS_PRESET = 30;
const UMUR_VALID = ['today', '3', '7', '14'];
const rootDari = (root) => (root ? path.resolve(root) : getCareerOpsRoot());
const filePreset = (root) => path.join(rootDari(root), 'data', 'scan-presets.json');
const provinsiValid = new Set(WILAYAH.flatMap((p) => p.provinsi.map((x) => x.nama)));
const kotaValid = new Map(WILAYAH.flatMap((p) => p.provinsi.map((x) => [x.nama, new Set(x.kota || [])])));

function bacaTeks(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; }
}
function tulisAtomik(file, isi) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, isi, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}
function muat(root) {
  const teks = bacaTeks(filePreset(root));
  if (!teks.trim()) return { versi: 1, daftar: [] };
  try {
    const o = JSON.parse(teks);
    return o && Array.isArray(o.daftar) ? { versi: 1, daftar: o.daftar } : { versi: 1, daftar: [] };
  } catch { return { versi: 1, daftar: [] }; }
}
function simpan(root, isi) {
  tulisAtomik(filePreset(root), JSON.stringify({ versi: 1, daftar: isi }, null, 2) + '\n');
}
const gagal = (error) => ({ ok: false, error });

function bersihkan(teks, maks) {
  return String(teks ?? '').trim().slice(0, maks);
}
function uang(teks, nama) {
  const s = String(teks ?? '').trim();
  if (s === '') return '';
  if (!/^\d{1,9}$/.test(s)) return gagal(`${nama} harus berupa angka.`);
  const n = Number(s);
  if (n > 100_000_000) return gagal(`${nama} tidak boleh lebih dari 100.000.000.`);
  return s;
}

export function daftarPreset(root) {
  try {
    const isi = muat(root);
    const daftar = [...isi.daftar].sort((a, b) => String(b.dibuat || '').localeCompare(String(a.dibuat || '')));
    return { ok: true, daftar, batas: BATAS_PRESET };
  } catch (e) { return gagal(e.message); }
}

export function bacaPreset(root, id) {
  try {
    const p = muat(root).daftar.find((x) => x.id === id);
    return p ? { ok: true, preset: p } : gagal('Preset tidak ditemukan.');
  } catch (e) { return gagal(e.message); }
}

export function simpanPreset(root, o) {
  try {
    const nama = bersihkan(o?.nama, 80);
    if (!nama) return gagal('Nama preset wajib diisi.');
    const provinsi = Array.isArray(o.provinsi)
      ? [...new Set(o.provinsi.map((x) => bersihkan(x, 80)))]
      : [];
    if (!provinsi.length) return gagal('Pilih minimal satu provinsi dahulu.');
    const salah = provinsi.find((x) => !provinsiValid.has(x));
    if (salah) return gagal('Provinsi tidak dikenal: ' + salah + '.');

    const kota = {};
    for (const [prov, daftar] of Object.entries(o.kota || {})) {
      if (!provinsi.includes(prov)) continue;
      const boleh = kotaValid.get(prov) || new Set();
      const pilih = (Array.isArray(daftar) ? daftar : []).map((x) => bersihkan(x, 80)).filter(Boolean);
      const asing = pilih.find((x) => !boleh.has(x));
      if (asing) return gagal(`Kota "${asing}" tidak ada di daftar ${prov}.`);
      kota[prov] = [...new Set(pilih)];
    }
    const kotaLain = (Array.isArray(o.kotaLain) ? o.kotaLain : [])
      .map((x) => bersihkan(x, 80)).filter(Boolean).slice(0, 20);
    const umur = UMUR_VALID.includes(o.umur) ? o.umur : '7';
    const kataKunci = (Array.isArray(o.kataKunci) ? o.kataKunci : [])
      .map((x) => bersihkan(x, 60).replace(/\s+/g, ' '))
      .filter((x) => /^[\p{L}\p{N}][\p{L}\p{N} +.'&-]{1,59}$/u.test(x))
      .slice(0, 14);
    const gajiMin = uang(o.gajiMin, 'Gaji minimum');
    const gajiMax = uang(o.gajiMax, 'Gaji maksimum');
    if (typeof gajiMin !== 'string' || typeof gajiMax !== 'string') return gajiMin.error ? gajiMin : gajiMax;
    if (gajiMin && gajiMax && Number(gajiMin) > Number(gajiMax)) {
      return gagal('Gaji minimum tidak boleh lebih besar dari maksimum.');
    }

    const isi = muat(root);
    if (isi.daftar.length >= BATAS_PRESET) return gagal(`Maksimal ${BATAS_PRESET} preset. Hapus salah satu dulu.`);
    if (isi.daftar.some((x) => String(x.nama).trim().toLowerCase() === nama.toLowerCase())) {
      return gagal('Nama preset sudah ada. Hapus yang lama atau pakai nama lain.');
    }
    const d = new Date();
    const dua = (n) => String(n).padStart(2, '0');
    const preset = {
      id: 'preset-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
      nama,
      dibuat: `${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())} ${dua(d.getHours())}:${dua(d.getMinutes())}`,
      provinsi, kota, kotaLain, umur, gajiMin, gajiMax, kataKunci,
    };
    isi.daftar.push(preset);
    simpan(root, isi.daftar);
    return { ok: true, preset };
  } catch (e) { return gagal(e.message); }
}

export function hapusPreset(root, id) {
  try {
    const isi = muat(root);
    const sebelum = isi.daftar.length;
    isi.daftar = isi.daftar.filter((x) => x.id !== id);
    if (isi.daftar.length === sebelum) return gagal('Preset tidak ditemukan.');
    simpan(root, isi.daftar);
    return { ok: true };
  } catch (e) { return gagal(e.message); }
}
