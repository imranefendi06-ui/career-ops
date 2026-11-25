// scan-terakhir.mjs — ingat pilihan scan terakhir per profil: gaji, umur,
// wilayah. Ini preferensi pencarian, bukan fakta CV dan bukan hasil evaluasi.
// Tidak menulis cv.md, tidak menjalankan scan, tidak mengirim lamaran.

import fs from 'node:fs';
import path from 'node:path';

const berkas = (root) => path.join(path.resolve(root), 'data', 'scan-terakhir.json');
const BATAS = 100000000;
const UMUR = new Set(['today', '3', '7', '14']);
const angka = (x, jatuh) => {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 && n <= BATAS ? Math.round(n) : jatuh;
};
const pendek = (x) => String(x ?? '').trim().slice(0, 60);
const daftar = (x, batas) => (Array.isArray(x) ? x : [])
  .map(pendek).filter(Boolean).slice(0, batas);
const petaKota = (x) => {
  const keluar = {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) return keluar;
  for (const [prov, kota] of Object.entries(x).slice(0, 3)) {
    const nama = pendek(prov);
    const isi = daftar(kota, 30);
    if (nama && isi.length) keluar[nama] = isi;
  }
  return keluar;
};
const polos = () => ({ gajiMin: 0, gajiMax: BATAS, umur: '7', provinsi: [], kota: {}, kotaLain: [] });

/** Kembali ke pilihan netral bila berkas belum ada atau rusak. */
export function bacaTerakhir(root) {
  const jatuh = polos();
  try {
    const o = JSON.parse(fs.readFileSync(berkas(root), 'utf8'));
    if (!o || typeof o !== 'object') return jatuh;
    return {
      gajiMin: angka(o.gajiMin, jatuh.gajiMin),
      gajiMax: angka(o.gajiMax, jatuh.gajiMax),
      umur: UMUR.has(String(o.umur)) ? String(o.umur) : jatuh.umur,
      provinsi: daftar(o.provinsi, 3),
      kota: petaKota(o.kota),
      kotaLain: daftar(o.kotaLain, 10),
    };
  } catch {
    return jatuh;
  }
}

export function simpanTerakhir(root, o) {
  try {
    const isi = {
      versi: 1,
      disimpan: new Date().toISOString(),
      gajiMin: angka(o?.gajiMin, 0),
      gajiMax: angka(o?.gajiMax, BATAS),
      umur: UMUR.has(String(o?.umur)) ? String(o.umur) : '7',
      provinsi: daftar(o?.provinsi, 3),
      kota: petaKota(o?.kota),
      kotaLain: daftar(o?.kotaLain, 10),
    };
    const file = berkas(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(isi, null, 2) + '\n', 'utf8');
    try { fs.renameSync(tmp, file); }
    catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
    return { ok: true, ...isi };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
