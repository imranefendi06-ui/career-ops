// skor-cepat.mjs — penilaian cepat, deterministik, tanpa LLM.
//
// BUKAN skor evaluasi career-ops resmi dan BUKAN angka peluang diterima.
// Angka 1,0-5,0 ini dihitung hanya dari data yang benar-benar ada:
//   - cv.md                (peran, pengalaman, pendidikan, keterampilan)
//   - config/profile.yml   (target peran, rentang gaji, fleksibilitas lokasi)
//   - teks iklan JobStreet (judul + teaser/bulletPoints dari segmen note:)
//
// Aturan jujur yang dipakai di sini:
//   1. Judul dibandingkan dengan SATU peran target yang paling cocok, bukan
//      gabungan semua peran (gabungan menghukum kandidat yang punya banyak target).
//   2. Skill hanya dihitung bila kata itu memang ada di cv.md DAN di iklan.
//   3. Komponen tanpa data (lokasi/gaji/teks iklan kosong) TIDAK dihitung,
//      bukan diberi nilai tengah yang bisa disangka "setengah cocok".
//   4. Setiap komponen mengembalikan `bukti` dan `alasan` yang bisa dicek.
//   5. Tidak ada skill, gaji, atau lokasi yang ditambahkan/ditebak.
//
// Tidak ada file yang ditulis oleh modul ini.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootAktif } from './konteks-root.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const STOP = new Set([
  'yang', 'dan', 'atau', 'untuk', 'dengan', 'pada', 'dari', 'dalam', 'akan', 'juga', 'tidak',
  'adalah', 'serta', 'oleh', 'sebagai', 'dapat', 'agar', 'kepada', 'ini', 'itu', 'para',
  'anda', 'kami', 'kita', 'minimal', 'maksimal', 'lebih', 'harus', 'mampu', 'memiliki',
  'melakukan', 'kerja', 'perusahaan', 'kandidat', 'posisi', 'lowongan', 'tanggung', 'jawab',
  'pengalaman', 'kemampuan', 'bersedia', 'menerima', 'domisili', 'di seluruh',
]);

const kata = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));

const angka = (s) => String(s || '').replace(/\./g, '').match(/\d+/g)?.map(Number) || [];

/** Baca hanya field yang dipakai penilaian. Tidak menulis apa pun. */
export function bacaProfilSkor(root = rootAktif() || ROOT) {
  const kosong = { peran: [], gajiMin: 0, gajiMax: 0, gajiMinimum: 0, lokasi: '' };
  const profil = path.join(path.resolve(root), 'config', 'profile.yml');
  if (!fs.existsSync(profil)) return kosong;
  const t = fs.readFileSync(profil, 'utf8').replace(/^\uFEFF/, '');
  const blok = (t.match(/^\s{2}primary:\s*\n([\s\S]*?)(?=^\s{2}[a-z_]+:)/m) || [])[1] || '';
  const peran = [...blok.matchAll(/^\s{4}-\s+(.+?)\s*$/gm)]
    .map((m) => m[1].replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
  const nilai = (re) => (t.match(re) || [])[1] || '';
  const rentang = angka(nilai(/^\s{2}target_range:\s*"?([^"\n]+)/m));
  const minimum = angka(nilai(/^\s{2}minimum:\s*"?([^"\n]+)/m));
  return {
    peran,
    gajiMin: minimum[0] || rentang[0] || 0,
    gajiMax: rentang[1] || 0,
    gajiMinimum: minimum[0] || rentang[0] || 0,
    lokasi: nilai(/^\s{2}location_flexibility:\s*"?([^"\n]+)/m),
  };
}

const ALIAS_PROVINSI = {
  'north sumatra': 'sumatera utara',
  'west sumatra': 'sumatera barat',
  'south sumatra': 'sumatera selatan',
  'bangka belitung': 'kepulauan bangka belitung',
  'riau islands': 'kepulauan riau',
};

const komponen = (label, isi) => ({ label, ...isi });

/* ---------- Judul/peran: satu peran terbaik, bukan gabungan ---------- */
function buktiJudul(judul, daftarPeran) {
  const j = new Set(kata(judul));
  const roles = (daftarPeran || []).filter(Boolean);
  if (!j.size) return { terukur: false, nilai: 0, maks: 30, alasan: 'judul lowongan kosong', bukti: [] };
  if (!roles.length) return { terukur: false, nilai: 0, maks: 30, alasan: 'tidak ada peran di cv.md/config/profile.yml', bukti: [] };
  let terbaik = { nilai: 0, peran: '', cocok: [] };
  for (const role of roles) {
    const k = new Set(kata(role));
    if (!k.size) continue;
    const cocok = [...j].filter((w) => k.has(w));
    const nilai = Math.min(30, Math.round(30 * cocok.length / Math.max(2, k.size)));
    if (nilai > terbaik.nilai || (nilai === terbaik.nilai && cocok.length > terbaik.cocok.length)) {
      terbaik = { nilai, peran: role, cocok };
    }
  }
  return {
    terukur: true,
    nilai: terbaik.nilai,
    maks: 30,
    alasan: terbaik.peran
      ? `${terbaik.cocok.length} kata judul cocok dengan peran "${terbaik.peran}"`
      : 'tidak ada peran di CV/profil yang cocok dengan judul iklan',
    bukti: terbaik.cocok,
  };
}

/* ---------- Skill: hanya kata yang ada di iklan DAN di cv.md ---------- */
function buktiSkill(jdText, cvTeks, kompetensi) {
  const kataIklan = [...new Set(kata(jdText || ''))].slice(0, 25);
  if (kataIklan.length < 2) {
    return {
      terukur: false, nilai: 0, maks: 30, bukti: [],
      alasan: 'teks iklan terlalu ringkas untuk menilai keterampilan (tidak dihitung)',
    };
  }
  const kataCv = new Set(kata(`${cvTeks || ''} ${(kompetensi || []).join(' ')}`));
  const cocok = kataIklan.filter((w) => kataCv.has(w));
  const tidak = kataIklan.filter((w) => !kataCv.has(w)).slice(0, 8);
  const dipakai = Math.min(12, kataIklan.length);
  return {
    terukur: true,
    nilai: Math.min(30, Math.round(30 * cocok.length / Math.max(1, dipakai))),
    maks: 30,
    alasan: `${cocok.length} dari ${dipakai} kata iklan ada di cv.md${tidak.length ? '; tidak ada di CV: ' + tidak.join(', ') : ''}`,
    bukti: cocok,
  };
}

/* ---------- Lokasi: 20 hanya bila token iklan benar-benar cocok ---------- */
function buktiLokasi(lokasi, fleksibel) {
  const l = String(lokasi || '').toLowerCase().trim();
  if (!l) return { terukur: false, nilai: 0, maks: 20, bukti: [], alasan: 'lokasi tidak tercantum di iklan (tidak dihitung)' };
  const f = String(fleksibel || '').toLowerCase();
  if (/remote/.test(l)) {
    return {
      terukur: true,
      nilai: /remote/.test(f) ? 16 : 6,
      maks: 20,
      bukti: ['remote'],
      alasan: /remote/.test(f)
        ? 'remote dan profil menyatakan menerima remote dengan domisili Sumatra'
        : 'remote, tetapi profil tidak menyebut penerimaan remote',
    };
  }
  const bentuk = [l];
  for (const [en, id] of Object.entries(ALIAS_PROVINSI)) {
    if (l.includes(en)) bentuk.push(l.replace(en, id));
  }
  const token = f.replace(/[()]/g, ' ').split(/[,;/]/).map((x) => x.trim()).filter((x) => x.length >= 4);
  for (const b of bentuk) {
    for (const t of token) {
      if (b.includes(t) || t.includes(b)) {
        return { terukur: true, nilai: 20, maks: 20, bukti: [t], alasan: `lokasi iklan "${l}" cocok dengan fleksibilitas profil (${t})` };
      }
    }
  }
  if (/sumat|indonesia/.test(l)) {
    return { terukur: true, nilai: 12, maks: 20, bukti: [l], alasan: `wilayah "${l}" masih luas; kota/provinsi tidak cocok dengan daftar profil` };
  }
  return { terukur: true, nilai: 0, maks: 20, bukti: [l], alasan: `lokasi "${l}" di luar fleksibilitas profil` };
}

/* ---------- Gaji: hanya angka yang memang tertulis di iklan ---------- */
function gajiBulanan(teks) {
  const m = String(teks || '').match(/^(\d+)(?:-(\d+))?\s+[A-Z]{3}$/);
  if (!m) return null;
  const bagi = (n) => Math.round(Number(n) / 12);
  return { min: bagi(m[1]), max: bagi(m[2] || m[1]) };
}

function buktiGaji(teksGaji, profil) {
  const iklan = gajiBulanan(teksGaji);
  if (!iklan) return { terukur: false, nilai: 0, maks: 20, bukti: [], alasan: 'gaji tidak dicantumkan di iklan (tidak dihitung)' };
  if (!(profil.gajiMax > 0)) {
    return { terukur: false, nilai: 0, maks: 20, bukti: [], alasan: 'target gaji tidak terbaca dari profil (tidak dihitung)' };
  }
  const { min, max } = iklan;
  const rentang = `Rp ${min.toLocaleString('id-ID')}–${max.toLocaleString('id-ID')}/bulan`;
  if (min <= profil.gajiMax && max >= profil.gajiMin) {
    return { terukur: true, nilai: 20, maks: 20, bukti: [rentang], alasan: `${rentang} overlap dengan target profil` };
  }
  if (min > profil.gajiMax) {
    return { terukur: true, nilai: 4, maks: 20, bukti: [rentang], alasan: `${rentang} di atas target profil` };
  }
  return { terukur: true, nilai: 0, maks: 20, bukti: [rentang], alasan: `${rentang} di bawah batas minimum profil` };
}

/**
 * @returns {{skor:number|null,total:number,maksTerukur:number,jumlahTerukur:number,rincian:Array}}
 */
export function skorCepat({ judul = '', jdText = '', lokasi = '', gaji = '', cv = null, profil = null, kompetensi = [] }) {
  const p = profil || bacaProfilSkor();
  const roles = [
    ...(p.peran || []),
    ...(cv?.experience || []).map((e) => e.role || ''),
  ];
  const cvTeks = [
    ...(cv?.skills || []).map((s) => `${s.category} ${s.items}`),
    ...(cv?.experience || []).flatMap((e) => e.bullets || []),
    cv?.summary || '',
  ].join(' ');

  const rincian = [
    komponen('Judul/peran', buktiJudul(judul, roles)),
    komponen('Keterampilan', buktiSkill(jdText, cvTeks, kompetensi)),
    komponen('Lokasi', buktiLokasi(lokasi, p.lokasi)),
    komponen('Gaji', buktiGaji(gaji, p)),
  ];
  const terukur = rincian.filter((x) => x.terukur);
  const total = terukur.reduce((a, x) => a + x.nilai, 0);
  const maksTerukur = terukur.reduce((a, x) => a + x.maks, 0);
  return {
    skor: maksTerukur > 0 ? Math.round((1 + 4 * total / maksTerukur) * 10) / 10 : null,
    total,
    maksTerukur,
    jumlahTerukur: terukur.length,
    rincian,
  };
}
