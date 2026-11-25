// jobstreet-gaji.mjs — pembungkus lokal untuk provider `jobstreet`.
//
// Jobstreet/SEEK mengirim gaji sebagai teks bebas di `salaryLabel`, tetapi
// provider asli sengaja hanya mengambil judul/perusahaan/lokasi/tanggal.
// Modul ini mempertahankan perilaku itu dan TAMBAHAN SAJA membaca angka yang
// memang tertulis di lowongan — tidak ada gaji yang ditebak atau diisi sendiri.
//
// Dipakai hanya oleh panel scan di ringkasan.mjs lewat portals.yml sementara.
// portals.yml asli dan providers/jobstreet.mjs tidak diubah.
//
// Selain gaji, pembungkus ini mengopi teks ringkas yang memang tertulis di
// iklan (teaser + bulletPoints) ke segmen `note:` pipeline. Teks itu dipakai
// halaman ringkasan untuk menyesuaikan CV/surat hasil scan. Kami TIDAK mengisi
// `job.description`: kolom itu dibaca content_filter/visa_filter/experience_filter
// dan mengisinya akan mengubah perilaku scan. `note` adalah kolom teks bebas
// yang memang disediakan scan.mjs untuk keperluan seperti ini.

import base from './jobstreet.mjs';

const id = 'jobstreet-gaji';

/** Ambil teks ringkas apa adanya dari satu butir hasil API v5. */
function teksRingkas(item) {
  if (!item || typeof item !== 'object') return '';
  const bagian = [];
  const teaser = typeof item.teaser === 'string' ? item.teaser.trim() : '';
  if (teaser) bagian.push(teaser);
  const poin = Array.isArray(item.bulletPoints) ? item.bulletPoints : [];
  for (const b of poin) {
    const s = typeof b === 'string' ? b
      : b && typeof b === 'object' ? (b.text || b.value || b.label || '')
        : '';
    if (String(s).trim()) bagian.push(String(s).trim());
  }
  // Satu baris, tanpa karakter yang memecah tabel pipeline markdown.
  return bagian.join(' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|\\\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** Ubah "2.200.000" / "1,5" / "3 juta" ke angka, tanpa mengarang nilai. */
function angkaGaji(mentah) {
  const s = String(mentah ?? '').trim();
  if (!s) return NaN;
  const adaKoma = s.includes(',');
  const adaTitik = s.includes('.');
  let n;
  if (adaKoma && adaTitik) {
    n = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? Number(s.replace(/\./g, '').replace(',', '.'))
      : Number(s.replace(/,/g, ''));
  } else if (adaKoma) {
    n = s.split(',')[1].length === 3
      ? Number(s.replace(',', ''))
      : Number(s.replace(',', '.'));
  } else if (adaTitik) {
    n = s.split('.')[1].length === 3
      ? Number(s.replace(/\./g, ''))
      : Number(s);
  } else {
    n = Number(s);
  }
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * Parse `salaryLabel` Jobstreet menjadi {min, max, currency} tahunan.
 * Contoh yang didukung: "Rp 2.200.000 – Rp 3.000.000 per month",
 * "Rp 3 juta/bulan", "Rp 4,5 juta per month", "Rp 60 juta per tahun".
 * Mengembalikan null bila tidak ada angka jelas atau satuan waktunya bukan
 * bulan/tahun (gaji harian/mingguan sengaja dilewat, bukan ditebak).
 */
export function parseGajiJobstreet(label) {
  if (typeof label !== 'string' || !label.trim()) return null;
  const s = label
    .replace(/\u00a0/g, ' ')
    .replace(/[–—−]/g, '-')
    .toLowerCase();
  if (!/\b(rp|idr)\b/.test(s)) return null;

  const perTahun = /(per\s*tahun|per\s*year|per\s*annum|tahunan|yearly|annually|\/tahun|\/year)/.test(s);
  const perBulan = /(per\s*bulan|per\s*month|bulanan|monthly|\/bulan|\/month|\bbln\b)/.test(s);
  if (!perTahun && !perBulan) return null;
  // bila kedua-duanya tidak mungkin, bulan tetap lebih spesifik untuk iklan ID
  const faktor = (perBulan || !perTahun) ? 12 : 1;

  const nilai = [];
  const re = /(\d[\d.,]*)\s*(juta|jt|ribu|rb|k)?(?![a-z])/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const angka = angkaGaji(m[1]);
    if (!Number.isFinite(angka)) continue;
    const unit = m[2] || '';
    const pengali = unit === 'juta' || unit === 'jt' ? 1_000_000
      : unit === 'ribu' || unit === 'rb' || unit === 'k' ? 1_000
        : 1;
    nilai.push(angka * pengali);
    if (nilai.length === 2) break;
  }
  if (!nilai.length) return null;

  const mentah = nilai.map((x) => Math.round(x * faktor));
  if (mentah.some((x) => !Number.isFinite(x) || x <= 0 || x > 1e12)) return null;
  const min = Math.min(...mentah);
  const max = Math.max(...mentah);
  return { min, max, currency: 'IDR' };
}

/** @type {import('./_types.js').Provider} */
export default {
  id,

  // Sama seperti jobstreet: board agregator, hanya dipakai lewat provider: eksplisit.
  detect() {
    return null;
  },

  async fetch(entry, ctx) {
    const mentah = new Map();
    // Tangkap respons API apa adanya. ctx.fetchJson dipanggil provider asli;
    // pembungkus ini hanya mengintip salinan data, tidak mengubah isinya.
    const ctxDenganTangkap = {
      ...ctx,
      fetchJson: async (url, opts) => {
        const json = await ctx.fetchJson(url, opts);
        if (Array.isArray(json?.data)) {
          for (const item of json.data) {
            if (item && item.id != null) mentah.set(String(item.id).trim(), item);
          }
        }
        return json;
      },
    };

    const jobs = await base.fetch(entry, ctxDenganTangkap);
    const wajibGaji = entry.hanya_gaji === true || entry.hanyaGaji === true;
    const hasil = [];
    for (const job of jobs || []) {
      const jobId = String(job.url || '').split('/').filter(Boolean).pop() || '';
      const butir = mentah.get(jobId);
      const salary = parseGajiJobstreet(butir?.salaryLabel);
      if (!salary && wajibGaji) continue;
      const ringkas = teksRingkas(butir);
      const hasilJob = salary ? { ...job, salary } : { ...job };
      if (ringkas) hasilJob.note = ringkas;
      hasil.push(hasilJob);
    }
    if (jobs?.jobstreetTruncated) hasil.jobstreetTruncated = jobs.jobstreetTruncated;
    return hasil;
  },
};
