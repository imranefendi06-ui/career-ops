// undangan.mjs — kode undangan uji tertutup SiapLamar.
//
// Berkasnya hidup di {DATA_ROOT}/data/undangan.json (user layer), bukan di
// kode sistem. Satu kode dipakai satu email. Pendaftaran lewat /daftar wajib
// membawa kode yang masih tersedia; akun yang sudah dibuat sebelumnya tidak
// terpengaruh.
//
// Pemakaian:
//   node undangan.mjs buat 5 "Beta putaran 1"   # cetak kode baru
//   node undangan.mjs daftar                    # lihat kode + pemakainya
//   node undangan.mjs reset SL-XXXXXX-XXXX      # kosongkan lagi (isi ulang)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';

const berkas = (root) => path.join(path.resolve(root), 'data', 'undangan.json');
const bersihKode = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const bersihEmail = (s) => String(s || '').trim().toLowerCase();
const KODE_SAH = /^SL-[0-9A-F]{6}-[0-9A-F]{4}$/;

export function bacaUndangan(root) {
  try {
    const o = JSON.parse(fs.readFileSync(berkas(root), 'utf8'));
    if (!o || !Array.isArray(o.daftar)) return { ok: false, error: 'Berkas undangan tidak valid.', daftar: [] };
    return { ok: true, daftar: o.daftar.filter((x) => x && typeof x === 'object') };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, daftar: [] };
    return { ok: false, error: e.message, daftar: [] };
  }
}

function tulis(root, daftar) {
  const f = berkas(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify({ diperbarui: new Date().toISOString(), daftar }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

export function buatUndangan(root, jumlah = 5, label = '') {
  const baca = bacaUndangan(root);
  if (!baca.ok) return { ok: false, error: baca.error, daftar: [] };
  const n = Math.max(1, Math.min(20, Math.floor(Number(jumlah) || 5)));
  const sudah = new Set(baca.daftar.map((x) => bersihKode(x.kode)));
  const baru = [];
  for (let i = 0; i < n; i += 1) {
    let kode;
    do {
      kode = `SL-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    } while (sudah.has(kode));
    sudah.add(kode);
    baru.push({ kode, label: String(label || '').slice(0, 60), terpakaiOleh: '', digunakanPada: '' });
  }
  tulis(root, [...baca.daftar, ...baru]);
  return { ok: true, daftar: baru };
}

export function cekUndangan(root, kode, email) {
  const baca = bacaUndangan(root);
  if (!baca.ok) return { ok: false, error: baca.error };
  if (!baca.daftar.length) return { ok: false, error: 'Pendaftaran uji tertutup hanya dengan kode undangan.' };
  const k = bersihKode(kode);
  if (!KODE_SAH.test(k)) return { ok: false, error: 'Kode undangan tidak dikenal.' };
  const entri = baca.daftar.find((x) => bersihKode(x.kode) === k);
  if (!entri) return { ok: false, error: 'Kode undangan tidak dikenal.' };
  const e = bersihEmail(email);
  if (entri.terpakaiOleh && entri.terpakaiOleh !== e) {
    return { ok: false, error: 'Kode undangan sudah dipakai email lain.' };
  }
  return { ok: true, entri };
}

export function pakaiUndangan(root, kode, email) {
  const cek = cekUndangan(root, kode, email);
  if (!cek.ok) return cek;
  const baca = bacaUndangan(root);
  const k = bersihKode(kode);
  const e = bersihEmail(email);
  const daftar = baca.daftar.map((x) => (bersihKode(x.kode) === k
    ? { ...x, terpakaiOleh: x.terpakaiOleh || e, digunakanPada: x.digunakanPada || new Date().toISOString() }
    : x));
  tulis(root, daftar);
  return { ok: true, kode: k };
}

export function resetUndangan(root, kode) {
  const baca = bacaUndangan(root);
  if (!baca.ok) return { ok: false, error: baca.error };
  const k = bersihKode(kode);
  const daftar = baca.daftar.map((x) => (bersihKode(x.kode) === k
    ? { ...x, terpakaiOleh: '', digunakanPada: '' }
    : x));
  if (!daftar.some((x, i) => bersihKode(x.kode) === k && JSON.stringify(x) !== JSON.stringify(baca.daftar[i]))) {
    return { ok: false, error: 'Kode tidak ditemukan atau memang belum dipakai.' };
  }
  tulis(root, daftar);
  return { ok: true, kode: k };
}

function cli() {
  const [perintah, a, b] = process.argv.slice(2);
  const root = getCareerOpsRoot();
  if (perintah === 'buat') {
    const out = buatUndangan(root, a || 5, b || '');
    if (!out.ok) { console.error(out.error); process.exitCode = 1; return; }
    for (const x of out.daftar) console.log(`${x.kode}\t${x.label || 'tanpa label'}`);
    return;
  }
  if (perintah === 'daftar') {
    const out = bacaUndangan(root);
    if (!out.ok) { console.error(out.error); process.exitCode = 1; return; }
    if (!out.daftar.length) { console.log('Belum ada kode undangan.'); return; }
    for (const x of out.daftar) {
      console.log(`${x.kode}\t${x.terpakaiOleh ? 'DIPAKAI ' + x.terpakaiOleh : 'tersedia'}\t${x.label || ''}`);
    }
    return;
  }
  if (perintah === 'reset') {
    const out = resetUndangan(root, a);
    if (!out.ok) { console.error(out.error); process.exitCode = 1; return; }
    console.log(`${out.kode} sudah bisa dipakai lagi.`);
    return;
  }
  console.log('Pemakaian: node undangan.mjs buat [jumlah] [label] | daftar | reset <kode>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) cli();
