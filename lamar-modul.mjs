// lamar-modul.mjs (versi 4) - dipanggil oleh ringkasan.mjs saat tombol "Lamar" diklik.
//
// Alur otomatis:
//   1. Buka halaman lamaran JobStreet lowongan itu (/apply)
//   2. Pilih / unggah CV dan surat lamaran yang sesuai nomor lowongan
//   3. Jawab pertanyaan perusahaan: dari jawaban.json, lalu dari jawaban-tersimpan.json
//   4. Pertanyaan BARU (belum punya jawaban): skrip berhenti, kamu jawab di Chrome dan
//      klik Lanjut sekali. Jawabanmu direkam, lalu skrip lanjut sendiri sampai selesai.
//      Lain kali pertanyaan yang sama dijawab otomatis.
//   5. Di "Review dan kirim", periksa pengaman, klik "Kirim lamaran", tandai Applied.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootAktif } from './konteks-root.mjs';
import { idScan, ambilNoteBaris } from './scan-ringkasan.mjs';
import { bacaCv, susunPayload } from './buat-cv-otomatis.mjs';
import { skorCepat, bacaProfilSkor } from './skor-cepat.mjs';

/* ======== PENGATURAN ======== */
// Mode kirim diputuskan server per akun (lihat mode-kirim.mjs), bukan konstanta
// global. Trial/manual: SiapLamar menyiapkan CV dan jawaban lalu BERHENTI sebelum
// tombol Kirim. Akun isi ulang: boleh menekan Kirim otomatis, dibatasi harian.
// Nilai ini hanya fallback bila pemanggil tidak mengirim opsi kirimOtomatis.
const KIRIM_OTOMATIS_DEFAULT = false;
// Jeda antar lowongan diacak supaya tidak terlalu seragam. Pilihan user:
// rata-rata 1 menit (50-70 detik) + istirahat 2-3 menit tiap 5 lamaran.
// Ini lebih cepat dari 2-4 menit; risikonya JobStreet bisa membatasi akun.
const JEDA_BATCH_MIN_MS = 50000;
const JEDA_BATCH_MAKS_MS = 70000;
const JEDA_ISTIRAHAT_MIN_MS = 120000;
const JEDA_ISTIRAHAT_MAKS_MS = 180000;
const ISTIRAHAT_TIAP = 5;
const JEDA_MANUAL_MS = 8000;        // jeda kalau tombol "Lamar" diklik satu-satu
const TUNGGU_JAWABAN_MENIT = 15;    // lama skrip menunggu kamu menjawab pertanyaan baru
// JobStreet membatasi jumlah resume per akun (teramati: 10). Sebelum mengunggah
// CV baru, resume terlama dihapus otomatis. Berkas asli tetap aman di folder output/.
const BATAS_RESUME_JOBSTREET = 10;
const BERSIHKAN_RESUME = true;
// Tanda lowongan tutup / kadaluarsa di halaman JobStreet. Kalau terdeteksi,
// lowongan dilewati dan antrean lanjut tanpa menghentikan batch.
const LOWONGAN_TUTUP_RE = /lowongan (ini )?(sudah|telah) (ditutup|kadaluarsa|berakhir|tidak tersedia)|job (has )?(expired|closed|no longer available|is no longer)|this job (has )?(expired|closed)|posisi ini sudah tidak tersedia|lamaran (sudah|telah) ditutup|iklan ini sudah tidak aktif|halaman tidak ditemukan|page not found/i;
// Halaman login bukan alasan untuk membuang lowongan. Bedakan dari lowongan mati.
const HALAMAN_LOGIN_RE = /(?:^|\/)(?:account\/)?(?:login|sign-?in|auth)(?:[/?#]|$)/i;
/* ============================ */

const acak = (min, maks) => min + Math.floor(Math.random() * (maks - min + 1));
const jedaBatch = () => acak(JEDA_BATCH_MIN_MS, JEDA_BATCH_MAKS_MS);
const jedaIstirahat = () => acak(JEDA_ISTIRAHAT_MIN_MS, JEDA_ISTIRAHAT_MAKS_MS);

// Pakai lokasi file ini, bukan cwd: server bisa dijalankan dari folder mana pun
// (shortcut, VS Code terminal, atau bat lain) dan tetap harus membaca output/ di sini.
const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = () => rootAktif() || CODE_ROOT;
const reportsDir = () => path.join(ROOT(), 'reports');
const outputDir = () => path.join(ROOT(), 'output');
const APP = () => path.join(ROOT(), 'data', 'applications.md');
const hitungFile = () => path.join(ROOT(), '.lamar-hitung.json');
const simpanFile = () => path.join(ROOT(), 'jawaban-tersimpan.json');
// Hasil scan tidak punya nomor laporan, jadi status Applied-nya disimpan per ID
// URL (idScan) di berkas ini. Bukan tracker — tracker tetap source of truth
// untuk baris bernomor.
const scanSelesaiFile = () => path.join(ROOT(), '.lamar-scan-selesai.json');
// Hasil scan yang menemui halaman "tidak ditemukan" tidak punya baris tracker.
// Statusnya disimpan terpisah supaya tidak ikut antrean dan tidak diklaim
// sebagai lamaran terkirim.
const scanTutupFile = () => path.join(ROOT(), '.lamar-scan-ditutup.json');
// Versi CV yang dipakai tiap lamaran hasil scan (idScan -> id versi cv-versi).
const scanCvFile = () => path.join(ROOT(), '.lamar-scan-cv.json');

// Penanda "baru saja dilamar" disimpan per root: akun A tidak boleh melihat
// nomor lamaran akun B lewat panel status.
const petaDilamar = new Map();
export function daftarDilamarBaru() {
  const kunci = ROOT();
  const arr = petaDilamar.get(kunci) || [];
  const batas = Date.now() - 30 * 60 * 1000;
  while (arr.length && arr[0].waktu < batas) arr.shift();
  petaDilamar.set(kunci, arr);
  return arr.map((x) => x.num);
}
const catatDilamarBaru = (num) => {
  const kunci = ROOT();
  const arr = petaDilamar.get(kunci) || [];
  arr.push({ num, waktu: Date.now() });
  petaDilamar.set(kunci, arr);
};

const hariIni = () => new Date().toLocaleDateString('sv-SE');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Jejak versi CV yang dipakai ---------- */
function cvAktifId() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT(), 'data', 'cv', 'aktif.json'), 'utf8'));
    return /^cv-[a-z0-9-]+$/.test(String(j.id || '')) ? String(j.id) : '';
  } catch { return ''; }
}

export function daftarScanCv() {
  try {
    const j = JSON.parse(fs.readFileSync(scanCvFile(), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

export function catatScanCv(scanId, cvId) {
  try {
    const id = String(scanId || '').trim();
    if (!id) return;
    const peta = daftarScanCv();
    if (cvId) peta[id] = String(cvId);
    else delete peta[id];
    fs.writeFileSync(scanCvFile(), JSON.stringify(peta, null, 2));
  } catch { /* abaikan */ }
}

/* ---------- Penanda Applied untuk baris hasil scan ---------- */
export function daftarScanDilamar() {
  try {
    const j = JSON.parse(fs.readFileSync(scanSelesaiFile(), 'utf8'));
    return Array.isArray(j) ? j.map(String) : [];
  } catch { return []; }
}
export function tandaiScanDilamar(scanId, applied = true) {
  try {
    const id = String(scanId || '').trim();
    if (!id) return;
    const s = new Set(daftarScanDilamar());
    if (applied) s.add(id); else s.delete(id);
    fs.writeFileSync(scanSelesaiFile(), JSON.stringify([...s], null, 2));
  } catch { /* abaikan */ }
}

export function daftarScanDitutup() {
  try {
    const j = JSON.parse(fs.readFileSync(scanTutupFile(), 'utf8'));
    return Array.isArray(j) ? j.map(String) : [];
  } catch { return []; }
}
export function tandaiScanDitutup(scanId, tutup = true) {
  try {
    const id = String(scanId || '').trim();
    if (!id) return;
    const s = new Set(daftarScanDitutup());
    if (tutup) s.add(id); else s.delete(id);
    fs.writeFileSync(scanTutupFile(), JSON.stringify([...s], null, 2));
  } catch { /* abaikan */ }
}

// Halaman mati ditandai Discarded (laporan) atau disimpan sebagai "ditutup"
// (hasil scan), lalu antrean lanjut tanpa mengklaim lamaran terkirim.
function tandaiTutup(job, alasan) {
  const num = job.num || '';
  if (num) return { num, ditandai: markDiscarded(num, alasan) };
  const scanId = job.scanId || (job.url ? idScan(job.url) : '');
  if (scanId) { tandaiScanDitutup(scanId, true); return { num: scanId, ditandai: true }; }
  return { num: '', ditandai: false };
}

/* ---------- Penghitung harian ---------- */
function bacaHitung() {
  try {
    const j = JSON.parse(fs.readFileSync(hitungFile(), 'utf8'));
    if (j.tanggal === hariIni()) return j.jumlah || 0;
  } catch { /* belum ada */ }
  return 0;
}
function tulisHitung(n) {
  try { fs.writeFileSync(hitungFile(), JSON.stringify({ tanggal: hariIni(), jumlah: n })); } catch { /* abaikan */ }
}

/* ---------- Tracker ---------- */
const isTrackerRow = (l) => /^\|\s*\d/.test(l);
function markApplied(num) {
  try {
    if (!fs.existsSync(APP())) return false;
    const t = fs.readFileSync(APP(), 'utf8');
    const eol = t.includes('\r\n') ? '\r\n' : '\n';
    const lines = t.split(/\r?\n/);
    const n = parseInt(num, 10);
    const idx = lines.findIndex((l) => isTrackerRow(l) && parseInt(l.split('|')[1], 10) === n);
    if (idx < 0) return false;
    const c = lines[idx].split('|');
    const notes = (c[9] || '')
      .replace(/\.?\s*Dilamar \d{4}-\d{2}-\d{2}/g, '')
      .replace(/\.?\s*cv:[a-z0-9-]+/gi, '')
      .replace(/[.\s]+$/, '')
      .trim();
    const cv = cvAktifId();
    c[6] = ' Applied ';
    c[9] = ' ' + (notes ? notes + '. ' : '') + 'Dilamar ' + hariIni() + (cv ? ' cv:' + cv : '') + ' ';
    lines[idx] = c.join('|');
    fs.writeFileSync(APP(), lines.join(eol));
    return true;
  } catch { return false; }
}
// Lowongan mati ditandai Discarded supaya tidak muncul lagi di antrean berikutnya.
// Catatan alasan memakai penanda tanggal yang sama, jadi aman kalau terdeteksi ulang.
function markDiscarded(num, alasan) {
  try {
    if (!fs.existsSync(APP())) return false;
    const t = fs.readFileSync(APP(), 'utf8');
    const eol = t.includes('\r\n') ? '\r\n' : '\n';
    const lines = t.split(/\r?\n/);
    const n = parseInt(num, 10);
    const idx = lines.findIndex((l) => isTrackerRow(l) && parseInt(l.split('|')[1], 10) === n);
    if (idx < 0) return false;
    const c = lines[idx].split('|');
    const notes = (c[9] || '').replace(/\.?\s*Ditutup \d{4}-\d{2}-\d{2}[^.]*/g, '').replace(/[.\s]+$/, '').trim();
    const catatan = ('Ditutup ' + hariIni() + ': ' + String(alasan || 'lowongan tidak valid').replace(/\s+/g, ' ')).trim();
    c[6] = ' Discarded ';
    c[9] = ' ' + (notes ? notes + '. ' : '') + catatan + ' ';
    lines[idx] = c.join('|');
    fs.writeFileSync(APP(), lines.join(eol));
    return true;
  } catch (e) {
    console.error(`Gagal menandai #${num} sebagai Discarded: ${e.message}`);
    return false;
  }
}

/* ---------- Chrome ---------- */
let ctxPromise = null;
async function getCtx() {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      const { chromium } = await import('playwright');
      const ctx = await chromium.launchPersistentContext(path.join(ROOT(), '.browser-profile'), {
        channel: 'chrome',
        headless: false,
        viewport: null,
      });
      ctx.on('close', () => { ctxPromise = null; });
      return ctx;
    })().catch((e) => { ctxPromise = null; throw e; });
  }
  return ctxPromise;
}

/* ---------- Data lowongan ---------- */
function findJob(num) {
  const n = String(num).padStart(3, '0');
  const rep = fs.readdirSync(reportsDir()).find((f) => /\.md$/.test(f) && f.match(/^(\d+)/) && f.match(/^(\d+)/)[1].padStart(3, '0') === n);
  let url = '';
  let slug = '';
  if (rep) {
    const text = fs.readFileSync(path.join(reportsDir(), rep), 'utf8');
    const line = (text.match(/\*\*URL:\*\*.*/) || [''])[0];
    url = (line.match(/https?:\/\/[^\s)>\]]+/) || [''])[0];
    slug = rep.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
  }
  const files = fs.readdirSync(outputDir());
  // Nomor boleh muncul setelah tanda apa pun, bukan hanya '-' atau '_'.
  // [^0-9] mencegah #66 ikut cocok ke berkas #366.
  const re = new RegExp(`(^|[^0-9])${n}([^0-9]|$)`);
  const terbaru = (arr) => arr.sort((a, b) => fs.statSync(path.join(outputDir(), b)).mtimeMs - fs.statSync(path.join(outputDir(), a)).mtimeMs)[0];
  // Utamakan berkas yang memuat NOMOR lowongan. Slug hanya fallback kalau
  // tidak ada satu pun berkas ber-nomor, supaya CV lowongan lain tidak terpakai.
  const pilihBerkas = (arr) => {
    const berNomor = arr.filter((f) => re.test(f));
    if (berNomor.length) return terbaru(berNomor);
    const berSlug = slug ? arr.filter((f) => f.includes(slug)) : [];
    return berSlug.length ? terbaru(berSlug) : '';
  };
  let cvName = pilihBerkas(files.filter((f) => /^cv-.*\.pdf$/i.test(f) && !/cover|surat/i.test(f)));
  let coverName = pilihBerkas(files.filter((f) => /^surat-lamaran-.*\.pdf$/i.test(f)));

  // Fallback kanonik: data/pdf-index.tsv ditulis generate-pdf.mjs saat PDF dibuat.
  // Dipakai kalau nama berkas diubah/dipindah sehingga pencocokan nama gagal.
  const indexFile = path.join(ROOT(), 'data', 'pdf-index.tsv');
  if ((!cvName || !coverName) && fs.existsSync(indexFile)) {
    try {
      for (const line of fs.readFileSync(indexFile, 'utf8').split(/\r?\n/)) {
        const c = line.split('\t');
        if ((c[0] || '').trim().padStart(3, '0') !== n) continue;
        const rel = (c[1] || '').trim();
        const kind = (c[5] || '').trim().toLowerCase();
        if (!rel || !fs.existsSync(path.join(ROOT(), rel))) continue;
        if (kind === 'cv' && !cvName) cvName = path.basename(rel);
        if (kind === 'cover' && !coverName) coverName = path.basename(rel);
      }
    } catch { /* indeks rusak: abaikan, pakai hasil pencarian nama */ }
  }

  return {
    num: n,
    slug,
    url,
    cvName,
    cvPath: cvName ? path.join(outputDir(), cvName) : '',
    coverName,
    coverPath: coverName ? path.join(outputDir(), coverName) : '',
  };
}

// Nama berkas wajib memuat nomor lowongan ATAU slug laporan lowongan itu.
// Dipakai untuk CV dan surat lamaran. Slug dipakai untuk berkas lama yang
// dibuat sebelum nomor ikut masuk ke nama berkas.
function berkasSesuai(nama, num, slug) {
  if (!nama) return false;
  if (new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(nama)) return true;
  return !!slug && nama.includes(slug);
}
const cvSesuai = berkasSesuai;

// Kode alasan berhenti. Diteruskan ke halaman ringkasan supaya notifikasi
// suaranya bisa dibedakan: butuh jawaban vs. dokumen tidak cocok.
const STATUS = {
  JAWABAN: 'butuh-jawaban',
  LANJUT: 'butuh-lanjut',
  CV: 'cv-tidak-cocok',
  SURAT: 'surat-tidak-cocok',
  KONFIRMASI: 'butuh-konfirmasi',
  BATAS: 'batas-harian',
};

// Catat alasan berhenti, bawa tab ke depan, dan kembalikan hasil yang bisa
// dibaca jalankan() -> lamarSemua() -> halaman ringkasan.
async function berhenti(p, log, pesan, status = STATUS.KONFIRMASI) {
  log.push(pesan);
  await p.bringToFront().catch(() => {});
  return { berhenti: true, status, msg: pesan };
}

// Berbeda dengan berhenti(): ini TIDAK mengakhiri antrean. Tab dibawa ke depan,
// user diminta mengklik "Lanjut"/"Kirim" di Chrome, lalu tungguJawabanDanLanjut()
// mendeteksi lamaran selesai dan melanjutkan ke lowongan berikutnya.
// Dipakai kalau tombol Lanjut gagal diklik/dideteksi di halaman antara
// (pertanyaan, profil, dokumen) — dulu ini salah berujung pada penghentian batch.
async function butuhBantuan(p, log, pesan, status = STATUS.LANJUT, selectLabels = []) {
  log.push(pesan);
  await p.bringToFront().catch(() => {});
  return {
    jeda: { selectLabels, url: p.url(), alasan: pesan, status },
    status, msg: pesan, butuhBantuan: true,
  };
}

/* ---------- Aturan jawaban ---------- */
// jawaban.json (kamu isi sendiri). Nilai yang diawali "ISI" diabaikan.
function loadRules() {
  const f = path.join(ROOT(), 'jawaban.json');
  if (!fs.existsSync(f)) return { rules: [] };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const rules = (j.aturan || []).filter((a) => a && a.cocok && a.pilih && !/^\s*ISI/i.test(a.pilih));
    return { rules };
  } catch (e) {
    return { error: 'jawaban.json tidak bisa dibaca (ada tanda baca yang salah): ' + e.message };
  }
}
function cocokAturan(rules, label) {
  for (const r of rules) {
    try { if (new RegExp(r.cocok, 'i').test(label)) return r; } catch { /* abaikan aturan rusak */ }
  }
  return null;
}

// jawaban-tersimpan.json (direkam otomatis dari jawabanmu)
function bacaTersimpan() {
  try {
    const j = JSON.parse(fs.readFileSync(simpanFile(), 'utf8').replace(/^\uFEFF/, ''));
    return j && typeof j.tersimpan === 'object' && j.tersimpan ? j : { tersimpan: {} };
  } catch { return { tersimpan: {} }; }
}
function simpanJawaban(snapshot, selectLabels) {
  const want = new Set((selectLabels || []).map(norm));
  const data = bacaTersimpan();
  data.catatan = 'Direkam otomatis dari jawabanmu. Boleh diedit atau dihapus per baris. Kunci = teks pertanyaan.';
  let n = 0;
  for (const s of snapshot) {
    if (!s.label || !want.has(norm(s.label))) continue;
    // select/radio menyimpan satu label; checkbox menyimpan array; teks menyimpan isinya.
    const pilih = s.kind === 'text' ? s.value : s.selected;
    const kosong = pilih == null || (Array.isArray(pilih) ? pilih.length === 0 : String(pilih).trim() === '');
    if (kosong) continue;
    data.tersimpan[norm(s.label)] = { label: s.label, pilih, jenis: s.kind, tanggal: hariIni() };
    n++;
  }
  if (n) fs.writeFileSync(simpanFile(), JSON.stringify(data, null, 2), 'utf8');
  return n;
}

/* ---------- Kuota resume JobStreet ---------- */
async function daftarResume(p) {
  return p.evaluate(() => {
    const tombol = Array.from(document.querySelectorAll('button[aria-label="Opsi"][id^="resume-options-"]'));
    // Badge "Utama" ada di pembungkus yang berisi SEMUA resume, bukan di dalam
    // baris resume satu per satu. Jadi tidak bisa dicari dengan box.querySelector.
    // Badge itu muncul tepat sebelum nama resume utama di urutan DOM.
    const badge = document.querySelector('[title="Utama"]');
    const kotak = tombol.map((btn) => {
      let box = btn.parentElement;
      while (box && !box.querySelector('label[for^="id-_r_"] strong')) box = box.parentElement;
      return box;
    });
    let indexUtama = -1;
    if (badge) {
      for (let i = 0; i < kotak.length; i++) {
        const strong = kotak[i] && kotak[i].querySelector('label[for^="id-_r_"] strong');
        // DOCUMENT_POSITION_FOLLOWING = badge lebih dulu, nama resume sesudahnya.
        if (strong && (badge.compareDocumentPosition(strong) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          indexUtama = i;
          break;
        }
      }
    }
    return tombol.map((btn, index) => {
      const box = kotak[index];
      const strong = box && box.querySelector('label[for^="id-_r_"] strong');
      const radio = box && box.querySelector('input[type="radio"]');
      return {
        index,
        id: btn.id.replace('resume-options-', ''),
        nama: strong ? strong.textContent.trim() : '',
        utama: index === indexUtama,
        dipilih: !!(radio && radio.checked),
      };
    });
  });
}

// Dipanggil sebelum unggah CV baru. Yang dihapus hanya resume terlama yang
// BUKAN CV utama, BUKAN yang sedang dipilih, dan BUKAN CV lowongan ini.
async function bersihkanResume(p, log, namaCV) {
  const semua = await daftarResume(p).catch(() => []);
  if (semua.length < BATAS_RESUME_JOBSTREET) return 0;
  const korban = semua.find((r) => !r.utama && !r.dipilih && r.nama &&
    r.nama.toLowerCase() !== String(namaCV || '').toLowerCase());
  if (!korban) {
    log.push(`Resume sudah ${semua.length}, tapi tidak ada yang bisa dihapus (semuanya utama/terpilih)`);
    return 0;
  }
  try {
    await p.locator(`button[id="resume-options-${korban.id}"]`).click({ timeout: 6000 });
    await p.locator(`button[id="resume-delete-${korban.id}"]`).click({ timeout: 6000 });
    const dialog = p.locator('#delete-resume-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 6000 });
    await dialog.locator('[data-testid="delete-confirmation"]').click({ timeout: 6000 });
    await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(1200);
    const sesudah = await daftarResume(p).catch(() => semua);
    log.push(`Kuota resume penuh (${semua.length}). Resume terlama dihapus: ${korban.nama}. Sisa ${sesudah.length}.`);
    return 1;
  } catch (e) {
    log.push(`Gagal menghapus resume lama (${String(e.message).split('\n')[0]}). Lanjut unggah; kalau gagal, proses berhenti dengan notifikasi.`);
    return 0;
  }
}

/* ---------- Langkah 1: dokumen ---------- */
async function pastikanBerkas(p, namaFile, inputSel, pathFile, jenis, log) {
  const lbl = () => p.locator('label').filter({ hasText: namaFile }).first();
  let diunggah = false;
  if (!(await lbl().count())) {
    try {
      const input = p.locator(inputSel).first();
      await input.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
      try {
        await input.setInputFiles(pathFile, { timeout: 15000 });
      } catch (e) {
        // JobStreet kadang lambat memasang input file; coba sekali lagi sebelum menyerah.
        await p.waitForTimeout(1500);
        await p.locator(inputSel).first().setInputFiles(pathFile, { timeout: 20000 });
      }
      diunggah = true;
      await lbl().waitFor({ state: 'attached', timeout: 25000 }).catch(() => {});
    } catch (e) {
      log.push(`${jenis}: gagal unggah (${String(e.message).split('\n')[0]}). Unggah manual: ${pathFile}`);
      return { ada: false, terpilih: false };
    }
  }
  if (await lbl().count()) {
    const radio = p.getByRole('radio', { name: namaFile }).first();
    await radio.check({ force: true, timeout: 4000 }).catch(() => lbl().click().catch(() => {}));
    const sel = await radio.isChecked().catch(() => false);
    log.push(`${jenis}: ${diunggah ? 'diunggah' : 'sudah ada di JobStreet'}${sel ? ', terpilih' : ', TIDAK bisa dipastikan terpilih'}`);
    return { ada: true, terpilih: sel === true };
  }
  log.push(`${jenis}: ${diunggah ? 'diunggah, tapi tidak terlihat di daftar' : 'tidak ditemukan'}`);
  return { ada: diunggah, terpilih: false };
}

// Klik tombol Lanjut dengan beberapa fallback selector + retry. JobStreet tidak
// memakai satu testid yang sama di semua langkah (dokumen, profil, pertanyaan),
// jadi mengandalkan [data-testid="continue-button"] saja sering gagal dan dulu
// membuat seluruh antrean berhenti di halaman profil.
async function lanjut(p) {
  const before = p.url();
  const selector = [
    '[data-testid="continue-button"]',
    '[data-testid="continue"]',
    'button:has-text("Lanjut")',
    'button:has-text("Lanjutkan")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'a:has-text("Lanjut")',
    'a:has-text("Lanjutkan")',
    'a:has-text("Continue")',
  ];
  let clicked = false;
  for (let attempt = 0; attempt < 2 && !clicked; attempt++) {
    for (const sel of selector) {
      const el = p.locator(sel).first();
      if (!(await el.count().catch(() => 0))) continue;
      if (!(await el.isVisible({ timeout: 1500 }).catch(() => false))) continue;
      try {
        await el.click({ timeout: 5000 });
        clicked = true;
        break;
      } catch { /* coba selector berikutnya */ }
    }
    if (!clicked) {
      for (const role of ['button', 'link']) {
        try {
          await p.getByRole(role, { name: /lanjut|lanjutkan|continue|next/i }).first().click({ timeout: 5000 });
          clicked = true;
          break;
        } catch { /* coba role berikutnya */ }
      }
    }
    if (!clicked) await p.waitForTimeout(800);
  }
  if (!clicked) return false;

  await p.waitForFunction((u) => location.href !== u, before, { timeout: 25000 }).catch(() => {});
  await p.waitForLoadState('domcontentloaded').catch(() => {});
  await p.waitForTimeout(1200);
  return p.url() !== before;
}

/* ---------- Langkah 2: pertanyaan perusahaan ---------- */
// Membaca SEMUA jenis pertanyaan (dropdown, radio, checkbox, teks) sekaligus.
// Dipakai untuk mengisi otomatis dan untuk merekam jawaban setelah kamu menjawab.
async function bacaPertanyaan(p) {
  return p.evaluate(() => {
    const rapikan = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const labelOf = (el) => {
      const l = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
      let t = l ? l.innerText : '';
      let e = el;
      for (let i = 0; i < 6 && !t && e.parentElement; i++) {
        e = e.parentElement;
        const lb = e.querySelector('label, legend');
        if (lb) t = lb.innerText;
      }
      return rapikan(t);
    };
    const labelOpsi = (el) => {
      const l = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
      if (l) return rapikan(l.innerText);
      const p = el.closest('label');
      if (p) return rapikan(p.innerText);
      return rapikan(el.value);
    };
    // Untuk radio/checkbox, label[for] menunjuk ke OPSI, bukan pertanyaan.
    // Ambil teks pertanyaan dari legend/heading pembungkusnya.
    const labelGrup = (el) => {
      const fs = el.closest('fieldset');
      if (fs) {
        const lg = fs.querySelector('legend');
        if (lg && rapikan(lg.innerText)) return rapikan(lg.innerText);
      }
      let e = el;
      for (let i = 0; i < 8 && e.parentElement; i++) {
        e = e.parentElement;
        const cand = e.querySelector('legend, [role="heading"], h1, h2, h3, h4, h5, h6');
        if (cand && rapikan(cand.innerText)) return rapikan(cand.innerText);
      }
      return labelOf(el);
    };
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[name^="questionnaire."]')) {
      const name = el.getAttribute('name');
      const type = (el.type || '').toLowerCase();
      if (el.tagName === 'SELECT') {
        out.push({
          kind: 'select', name, id: el.id, label: labelOf(el),
          options: [...el.options].map((o) => o.text.trim()),
          selected: el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.trim() : '',
        });
        continue;
      }
      if (type === 'radio' || type === 'checkbox') {
        if (seen.has(name)) continue;
        seen.add(name);
        const group = [...document.querySelectorAll('input[name="' + CSS.escape(name) + '"]')];
        const opts = group.map((g, idx) => ({ label: labelOpsi(g), id: g.id, idx, checked: g.checked }));
        out.push({
          kind: type, name, label: labelGrup(el),
          options: opts.map((o) => o.label),
          ids: opts.map((o) => o.id),
          selected: type === 'radio'
            ? ((opts.find((o) => o.checked) || {}).label || '')
            : opts.filter((o) => o.checked).map((o) => o.label),
        });
        continue;
      }
      if (['text', 'number', 'email', 'tel', 'date', 'url', 'textarea'].includes(type) || el.tagName === 'TEXTAREA') {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ kind: 'text', name, id: el.id, label: labelOf(el), value: (el.value || '').trim() });
      }
    }
    return out;
  });
}

// Pertanyaan "berapa tahun pengalaman / how many years experience" dijawab 1 tahun
// otomatis. Jawaban diambil dari PILIHAN yang ada di halaman — tidak mengarang.
function jawabanTahun(it) {
  const label = String(it.label || '');
  if (!/(how many\s+years?|berapa\s+tahun|years?\s+of\s+(?:relevant\s+)?experience)/i.test(label)) return null;
  const opts = Array.isArray(it.options) ? it.options : [];
  const aman = (o) => !/(less than|kurang dari|di bawah|under|<\s*1|0\s*[-–])/i.test(String(o));
  if (opts.length) {
    const sama = opts.find((o) => /^\s*1\s*(years?|tahun)\s*$/i.test(String(o)) && aman(o));
    if (sama) return String(sama).trim();
    const mirip = opts.find((o) => /\b1\s*(years?|tahun)\b/i.test(String(o)) && aman(o));
    if (mirip) return String(mirip).trim();
    return null; // tidak ada pilihan 1 tahun → tetap minta jawabanmu
  }
  return /tahun/i.test(label) ? '1 tahun' : '1 year';
}

// Pertanyaan ya/tidak dijawab "Ya"/"Yes" otomatis, tapi hanya kalau pilihannya
// memang berpasangan ya vs tidak — jangan menebak pada pertanyaan lain.
const YA_RE = /^(ya\b|y\b|iya\b|yes\b|yeah\b|true\b|benar\b|betul\b)/i;
const TIDAK_RE = /^(tidak\b|tdk\b|no\b|nope\b|false\b|salah\b|bukan\b)/i;
function jawabanYaTidak(it) {
  const opts = Array.isArray(it.options) ? it.options : [];
  if (opts.length < 2) return null;
  const bersih = (o) => String(o).trim().replace(/[.!?]+$/, '');
  const ya = opts.find((o) => YA_RE.test(bersih(o)));
  const tidak = opts.find((o) => TIDAK_RE.test(bersih(o)));
  return ya && tidak ? bersih(ya) : null;
}

// Kalau pertanyaan/about field memang soal pilihan bahasa dan ada opsi
// English/Inggris, pilih English. Tidak dipakai untuk pertanyaan keahlian
// bahasa yang tidak menawarkan pilihan bahasa.
function jawabanBahasa(it) {
  const label = String(it.label || '');
  if (!/bahasa|language/i.test(label)) return null;
  const opts = Array.isArray(it.options) ? it.options : [];
  if (opts.length < 2) return null;
  const inggris = opts.find((o) => /^(english|inggris)\b/i.test(String(o).trim()));
  if (!inggris) return null;
  return String(inggris).trim();
}

async function isiPertanyaan(p, rules, log, ketat) {
  const items = await bacaPertanyaan(p);
  const tersimpan = bacaTersimpan().tersimpan;
  const belum = [];
  const selectLabels = [];
  const terisiSendiri = [];

  // Urutan: aturan tulisanmu → jawaban yang pernah direkam → otomatis 1 tahun.
  const jawabanUntuk = (it) => {
    const label = it.label;
    // Pilihan bahasa didahulukan: kalau ada English, pakai English.
    const bahasa = jawabanBahasa(it);
    if (bahasa) return { pilih: bahasa, sumber: ' (otomatis English)' };
    const rule = cocokAturan(rules, label);
    if (rule && rule.pilih) return { pilih: rule.pilih, sumber: '' };
    const hafal = tersimpan[norm(label)];
    if (hafal && hafal.pilih != null && String(hafal.pilih).trim()) return { pilih: hafal.pilih, sumber: ' (dari rekaman)' };
    // Ya/tidak otomatis Ya hanya kalau belum ada jawaban yang direkam.
    const ya = jawabanYaTidak(it);
    if (ya) return { pilih: ya, sumber: ' (otomatis Ya)' };
    const tahun = jawabanTahun(it);
    if (tahun) return { pilih: tahun, sumber: ' (otomatis 1 tahun)' };
    return { pilih: null, sumber: '' };
  };

  const centangOpsi = async (it, pilih) => {
    const wants = Array.isArray(pilih) ? pilih : String(pilih).split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
    let dipilih = 0;
    for (const w of wants) {
      let idx = it.options.findIndex((o) => o.toLowerCase() === w.toLowerCase());
      if (idx === -1) idx = it.options.findIndex((o) => o.toLowerCase().includes(w.toLowerCase()));
      if (idx === -1) continue;
      const id = it.ids[idx];
      const loc = id
        ? p.locator('[id="' + id + '"]')
        : p.locator('input[name="' + it.name + '"][type="' + it.kind + '"]').nth(idx);
      const ok = await loc.check({ force: true, timeout: 5000 }).then(() => true).catch(() => false);
      if (ok) dipilih++;
    }
    return dipilih;
  };

  for (const it of items) {
    if (it.kind === 'text') {
      if (it.value) continue; // sudah diisi
      const { pilih, sumber } = jawabanUntuk(it);
      if (pilih == null || !String(pilih).trim()) { belum.push(it.label); selectLabels.push(it.label); continue; }
      const loc = it.id ? p.locator('[id="' + it.id + '"]') : p.locator('[name="' + it.name + '"]').first();
      const ok = await loc.fill(String(pilih), { timeout: 5000 }).then(() => true).catch(() => false);
      if (ok) log.push(`jawab "${it.label}" -> ${pilih}${sumber}`);
      else { belum.push(it.label); selectLabels.push(it.label); }
      continue;
    }

    if (it.kind === 'radio' || it.kind === 'checkbox') {
      const sudah = it.kind === 'radio' ? !!it.selected : (it.selected && it.selected.length > 0);
      if (sudah) continue; // sudah dipilih (olehmu atau JobStreet)
      const { pilih, sumber } = jawabanUntuk(it);
      if (pilih == null) { belum.push(it.label); selectLabels.push(it.label); continue; }
      let n = await centangOpsi(it, pilih);
      let catatan = sumber;
      if (!n && jawabanTahun(it)) {
        const cadangan = jawabanTahun(it);
        if (cadangan !== pilih) {
          n = await centangOpsi(it, cadangan);
          if (n) catatan = ' (otomatis 1 tahun; jawaban tersimpan tidak tersedia)';
        }
      }
      if (n) log.push(`jawab "${it.label}" -> ${Array.isArray(pilih) ? pilih.join(', ') : pilih}${catatan}`);
      else {
        belum.push(`${it.label} (pilihan "${Array.isArray(pilih) ? pilih.join(', ') : pilih}" tidak ada di pertanyaan ini)`);
        selectLabels.push(it.label);
      }
      continue;
    }

    // select / dropdown
    const { pilih, sumber } = jawabanUntuk(it);
    if (pilih) {
      const loc = it.id ? p.locator('[id="' + it.id + '"]') : p.locator('[name="' + it.name + '"]').first();
      const want = String(pilih).trim().toLowerCase();
      let opt = it.options.find((o) => o.toLowerCase() === want) || it.options.find((o) => o.toLowerCase().includes(want));
      let catatan = sumber;
      // Jawaban lama seperti "Less than 1 year" belum tentu ada di lowongan ini.
      // Untuk pertanyaan tahun, pakai "1 year"/"1 tahun" yang memang tersedia.
      if (!opt && jawabanTahun(it)) {
        const cadangan = jawabanTahun(it);
        opt = it.options.find((o) => o.trim().toLowerCase() === cadangan.toLowerCase());
        if (opt) catatan = ' (otomatis 1 tahun; jawaban tersimpan tidak tersedia)';
      }
      if (opt) {
        await loc.selectOption({ label: opt }).catch(() => {});
        log.push(`jawab "${it.label}" -> ${opt}${catatan}`);
      } else {
        belum.push(`${it.label} (pilihan "${pilih}" tidak ada di pertanyaan ini)`);
        selectLabels.push(it.label);
      }
    } else if (it.selected && it.selected !== '') {
      const info = `${it.label} (terisi "${it.selected}" oleh JobStreet, belum ada jawaban darimu)`;
      if (ketat) { belum.push(info); selectLabels.push(it.label); }
      else terisiSendiri.push(info);
    } else {
      belum.push(it.label);
      selectLabels.push(it.label);
    }
  }
  if (terisiSendiri.length) log.push('terisi otomatis oleh JobStreet (periksa di Review): ' + terisiSendiri.join(' | '));
  return { belum, selectLabels };
}

// Tunggu sampai user meninggalkan halaman yang sedang macet (bisa pertanyaan,
// profil, maupun dokumen) atau sampai lamaran terkirim. Jawaban terakhir tetap
// direkam supaya pertanyaan yang sama terjawab otomatis di lowongan berikutnya.
async function tungguPindah(p, urlStuck) {
  let terakhir = [];
  const mulai = Date.now();
  while (Date.now() - mulai < TUNGGU_JAWABAN_MENIT * 60 * 1000) {
    if (p.isClosed()) break;
    if (!urlStuck || p.url() !== urlStuck) break;
    const s = await bacaPertanyaan(p).catch(() => null);
    if (s && s.length) terakhir = s;
    await tunggu(1000);
  }
  return terakhir;
}

// User boleh menyelesaikan pengiriman sendiri di Chrome. Deteksi halaman sukses
// supaya automation tahu lamaran sudah terkirim dan bisa lanjut ke antrean.
async function suksesManual(p) {
  const u = p.url();
  if (/\/apply\/(success|submitted|complete|thank|confirmation)/i.test(u)) return true;
  if (/\/apply\/(profile|role-requirements|review)/i.test(u)) return false;
  const teks = await p.locator('body').innerText().catch(() => '');
  return /lamaran.{0,40}(terkirim|dikirim|berhasil)|application.{0,30}(submitted|sent|successful)|terima kasih atas lamaran/i.test(teks);
}

/* ---------- Langkah 4: kirim ---------- */
async function kirimLamaran(p, job, log) {
  const num = job.num || '';
  const scanId = job.scanId || (job.url ? idScan(job.url) : '');
  const sebelum = p.url();
  const tombol = p.locator('[data-testid="review-submit-application"]').first();
  try {
    await tombol.click({ timeout: 8000 });
  } catch (e) {
    const msg = 'BERHENTI: tombol "Kirim lamaran" tidak bisa diklik (' + String(e.message).split('\n')[0] + '). Klik sendiri di Chrome';
    log.push(msg);
    return { ok: false, status: STATUS.KONFIRMASI, msg };
  }
  await p.waitForFunction(
    (u) => location.href !== u || /lamaran.{0,30}(terkirim|dikirim)|application.{0,20}(sent|submitted)/i.test(document.body.innerText),
    sebelum,
    { timeout: 25000 },
  ).catch(() => {});
  await p.waitForTimeout(1500);
  const teks = await p.locator('body').innerText().catch(() => '');
  const sukses = /success|submitted|confirm|terkirim/i.test(p.url()) ||
    /lamaran.{0,30}(terkirim|dikirim)|application.{0,20}(sent|submitted)/i.test(teks);
  if (sukses) {
    tulisHitung(bacaHitung() + 1);
    const t = num ? markApplied(num) : false;
    if (!num && scanId) {
      tandaiScanDilamar(scanId, true);
      catatScanCv(scanId, cvAktifId());
    }
    const tuntas = t || (!num && !!scanId);
    log.push(`TERKIRIM. ${t ? 'Tracker: Applied.' : num ? 'Tracker tidak diubah (nomor tidak ditemukan).' : `Hasil scan ${scanId} ditandai Applied.`} Total terkirim: ${bacaHitung()} (tanpa batas harian).`);
    if (tuntas) catatDilamarBaru(num || scanId);
    // Dilanjutkan ke halaman ringkasan supaya kotak centangnya berubah SEKETIKA
    // (tidak perlu menunggu batch selesai dan halaman dimuat ulang).
    return { ok: true, dilamar: !!tuntas };
  }
  const msg = `Tombol Kirim sudah diklik, tapi konfirmasi terkirim tidak terdeteksi (alamat akhir: ${p.url()}). Periksa di JobStreet > Lamaran saya. Tracker TIDAK diubah.`;
  log.push(msg);
  return { ok: false, status: STATUS.KONFIRMASI, msg };
}

/* ---------- Menjalankan langkah-langkah lamaran ---------- */
// Hasil: { selesai } | { berhenti, status, msg } | { jeda, status, msg, belum, selectLabels }
async function langkah(p, st, log, kirimOtomatis = KIRIM_OTOMATIS_DEFAULT) {
  const { job, rules } = st;
  for (let i = 0; i < 8; i++) {
    const u = p.url();

    // "Halaman tidak ditemukan" bisa muncul di TENGAH alur, setelah klik Lanjut.
    // Jangan menunggu 15 menit: tandai Discarded lalu lewati ke antrean berikutnya.
    const teksHalaman = await p.locator('body').innerText().catch(() => '');
    if (LOWONGAN_TUTUP_RE.test(teksHalaman)) {
      const alasan = 'halaman tidak ditemukan / lowongan tutup saat melamar';
      const t = tandaiTutup(job, alasan);
      log.push(`DILEWATI: ${alasan}${t.ditandai ? '; ditandai Discarded' : ''}. Lanjut ke antrean berikutnya.`);
      return { skip: true, status: 'lowongan-tutup', ditandai: t.ditandai, num: t.num, msg: log.join('; ') };
    }

    if (/\/apply\/review/.test(u)) {
      if (!kirimOtomatis) { log.push('SIAP: periksa isinya di Chrome, lalu klik "Kirim lamaran"'); return { selesai: true }; }

      const teks = await p.locator('body').innerText().catch(() => '');
      const cvs = (teks.match(/cv-[a-z0-9._-]+\.pdf/gi) || []).map((x) => x.toLowerCase());
      const surats = (teks.match(/surat-lamaran-[a-z0-9._-]+\.pdf/gi) || []).map((x) => x.toLowerCase());
      const alasan = [];
      let status = STATUS.KONFIRMASI;
      if (!st.cvTerpilih) { alasan.push('CV belum terkonfirmasi terpilih'); status = STATUS.CV; }
      if (job.coverPath && !st.suratTerpilih) { alasan.push('surat lamaran belum terkonfirmasi terpilih'); if (status === STATUS.KONFIRMASI) status = STATUS.SURAT; }
      if (cvs.length && !cvs.includes(job.cvName.toLowerCase())) { alasan.push('halaman Review menampilkan CV lain'); status = STATUS.CV; }
      if (job.coverName && surats.length && !surats.includes(job.coverName.toLowerCase())) { alasan.push('halaman Review menampilkan surat lamaran lain'); if (status !== STATUS.CV) status = STATUS.SURAT; }

      if (alasan.length) {
        log.push('TIDAK dikirim otomatis: ' + alasan.join('; ') + '. Periksa di Chrome lalu klik "Kirim lamaran" sendiri');
        await p.bringToFront().catch(() => {});
        // Tab sengaja dibiarkan terbuka supaya kamu bisa periksa / kirim sendiri.
        return { berhenti: true, status, msg: alasan.join('; ') };
      }
      let dilamar = false;
      if (/\/apply\/review/.test(p.url())) {
        const kirim = await kirimLamaran(p, job, log);
        if (!kirim.ok) return await butuhBantuan(p, log, kirim.msg, kirim.status || STATUS.LANJUT);
        dilamar = !!kirim.dilamar;
      }
      return { selesai: true, dilamar };
    }

    if (/\/apply\/role-requirements/.test(u)) {
      const r = await isiPertanyaan(p, rules, log, kirimOtomatis);
      if (r.belum.length) {
        const pesan = 'Menunggu jawabanmu. Jawab di Chrome lalu klik Lanjut SEKALI; jawabanmu direkam dan antrean lanjut setelah halaman berpindah. Periksa status lamaran di Chrome. Belum terjawab: ' + r.belum.join(' | ');
        log.push(pesan);
        await p.bringToFront().catch(() => {});
        return { jeda: { ...r, url: p.url(), alasan: pesan, status: STATUS.JAWABAN }, status: STATUS.JAWABAN, msg: pesan };
      }
      if (!(await lanjut(p).catch(() => false))) return await butuhBantuan(p, log,
        'Tombol Lanjut di halaman pertanyaan tidak bisa diklik otomatis. Klik Lanjut SATU kali di jendela Chrome — antrean lanjut setelah halaman berpindah. Periksa status lamaran di Chrome.', STATUS.LANJUT);
      continue;
    }

    if (/\/apply\/profile/.test(u)) {
      if (!(await lanjut(p).catch(() => false))) return await butuhBantuan(p, log,
        'Tombol Lanjut di halaman profil tidak bisa diklik otomatis. Lengkapi field wajib bila ada, lalu klik Lanjut SATU kali di jendela Chrome — antrean lanjut setelah halaman berpindah. Periksa status lamaran di Chrome.', STATUS.LANJUT);
      continue;
    }

    if (/\/apply\/?(\?.*)?$/.test(u)) {
      await p.locator('input[data-testid="file-input"]').first().waitFor({ state: 'attached', timeout: 25000 }).catch(() => {});
      // Pengaman: dokumen harus jelas milik lowongan ini. Kalau tidak, berhenti di halaman ini.
      if (!berkasSesuai(job.cvName, job.num, job.slug)) {
        return await berhenti(p, log, `BERHENTI: CV "${job.cvName || '(tidak ada)'}" bukan untuk lowongan #${job.num} ("${job.slug || 'tanpa slug'}"). Tidak ada berkas yang diunggah; periksa folder output.`, STATUS.CV);
      }
      if (job.coverName && !berkasSesuai(job.coverName, job.num, job.slug)) {
        return await berhenti(p, log, `BERHENTI: surat lamaran "${job.coverName}" bukan untuk lowongan #${job.num} ("${job.slug || 'tanpa slug'}"). Tidak ada berkas yang diunggah; periksa folder output.`, STATUS.SURAT);
      }
      if (BERSIHKAN_RESUME) await bersihkanResume(p, log, job.cvName);
      const cv = await pastikanBerkas(p, job.cvName, '#resume-fileFile', job.cvPath, 'CV', log);
      st.cvTerpilih = cv.terpilih;
      if (job.coverPath) {
        const sr = await pastikanBerkas(p, job.coverName, '#coverLetter-fileFile', job.coverPath, 'Surat lamaran', log);
        st.suratTerpilih = sr.terpilih;
      } else {
        st.suratTerpilih = true;
        log.push('Surat lamaran: tidak ada PDF untuk lowongan ini');
      }
      if (!cv.ada) return await berhenti(p, log, 'BERHENTI: CV belum beres, atur sendiri di Chrome', STATUS.CV);
      // Jangan lanjut kalau CV yang benar belum terkonfirmasi terpilih — bisa saja
      // JobStreet menampilkan CV lain atau unggahan gagal senyap.
      if (!cv.terpilih) return await berhenti(p, log, `BERHENTI: CV "${job.cvName}" belum terkonfirmasi terpilih di halaman ini. Tidak dilanjutkan. Periksa di Chrome.`, STATUS.CV);
      if (!(await lanjut(p).catch(() => false))) return await butuhBantuan(p, log,
        'Tombol Lanjut di halaman pilih dokumen tidak bisa diklik otomatis. Klik Lanjut SATU kali di jendela Chrome — antrean lanjut setelah halaman berpindah. Periksa status lamaran di Chrome.', STATUS.LANJUT);
      continue;
    }

    return await butuhBantuan(p, log,
      `Halaman tidak dikenal (${u}). Periksa di jendela Chrome, klik Lanjut/Kirim bila perlu — antrean lanjut setelah halaman berpindah. Periksa status lamaran di Chrome.`);
  }
  return await berhenti(p, log, 'BERHENTI: sudah 8 langkah tanpa hasil, lanjutkan manual di Chrome');
}

// Menunggu kamu menyelesaikan langkah yang macet di Chrome (menjawab pertanyaan
// BARU ATAU sekadar mengklik Lanjut/Kirim), merekam jawabannya, lalu menyelesaikan
// lowongan ini. Fungsi ini DITUNGGU oleh antrean, jadi setelah halaman berpindah
// (atau kamu menandai sudah dilamar) batch lanjut ke lowongan berikutnya.
async function tungguJawabanDanLanjut(p, st, jedaAwal, log, kabar) {
  const label = st.job.num ? `#${st.job.num}` : (st.job.scanId || st.job.url);
  const tag = `[${label}]`;
  let jeda = jedaAwal;
  while (jeda) {
    kabar({
      tahap: 'menunggu-jawaban', sedang: st.job,
      pesan: jeda.alasan || `Menunggu kamu di Chrome untuk ${label}. Selesaikan langkah ini — antrean lanjut setelah halaman berpindah. Periksa status lamaran di Chrome.`,
    });
    console.log(`${tag} menunggu di Chrome (maks ${TUNGGU_JAWABAN_MENIT} menit)...`);
    // jeda dari isiPertanyaan tidak membawa url; pakai halaman saat ini.
    const urlStuck = jeda.url || p.url();
    const snap = await tungguPindah(p, urlStuck);
    const n = simpanJawaban(snap, jeda.selectLabels);
    if (n) console.log(`${tag} ${n} jawaban baru direkam ke jawaban-tersimpan.json`);
    if (p.isClosed()) {
      const msg = 'Jendela Chrome ditutup saat menunggu. Antrean dihentikan.';
      log.push(msg);
      return { berhenti: true, status: STATUS.JAWABAN, msg };
    }
    if (p.url() === urlStuck) {
      const msg = `Waktu tunggu ${TUNGGU_JAWABAN_MENIT} menit habis untuk ${label}. Antrean dihentikan; selesaikan manual di Chrome.`;
      log.push(msg);
      return { berhenti: true, status: jeda.status || STATUS.JAWABAN, msg };
    }
    // Kamu mengirim sendiri di Chrome → tandai Applied, lalu lanjut antrean.
    if (await suksesManual(p)) {
      const num = st.job.num || '';
      const scanId = st.job.scanId || (st.job.url ? idScan(st.job.url) : '');
      const t = num ? markApplied(num) : false;
      if (!num && scanId) {
        tandaiScanDilamar(scanId, true);
        catatScanCv(scanId, cvAktifId());
      }
      const tuntas = t || (!num && !!scanId);
      if (tuntas) catatDilamarBaru(num || scanId);
      log.push(`TERKIRIM manual di Chrome. ${tuntas ? 'Ditandai Applied.' : 'Tracker tidak diubah (nomor tidak ditemukan).'}`);
      return { selesai: true, dilamar: !!tuntas };
    }
    await tunggu(2500);
    const langkahLog = [];
    let r;
    try {
      r = await langkah(p, st, langkahLog);
    } catch (e) {
      const msg = `Gagal melanjutkan setelah dibantu: ${e.message}`;
      log.push(msg);
      return { berhenti: true, status: STATUS.JAWABAN, msg };
    }
    log.push(...langkahLog);
    console.log(`${tag} ${langkahLog.join('; ')}`);
    if (r.jeda) { jeda = r.jeda; continue; } // masih ada langkah yang perlu bantuan
    return r;
  }
  return { berhenti: true, status: STATUS.JAWABAN, msg: 'Tidak bisa melanjutkan.' };
}

/* ---------- Proses satu lowongan ---------- */
async function jalankan(arg, kabar = () => {}, opsi = {}) {
  // Argumen boleh nomor laporan ATAU item hasil scan (objek berisi url + berkas).
  const kirimOtomatis = opsi.kirimOtomatis === undefined
    ? KIRIM_OTOMATIS_DEFAULT : !!opsi.kirimOtomatis;
  const job = arg && typeof arg === 'object' ? arg : findJob(arg);
  const num = job.num || '';
  const label = num ? `#${num}` : (job.scanId || job.url);
  if (!job.url) return { ok: false, error: 'Link lowongan tidak ditemukan di laporan' };
  if (!/jobstreet/i.test(job.url)) return { ok: false, error: 'Bukan lowongan JobStreet, buka lewat tombol "Buka lowongan"' };
  if (!job.cvPath) {
    const contoh = fs.readdirSync(outputDir()).filter((f) => /^cv-.*\.pdf$/i.test(f) && f.includes(job.num)).slice(0, 3);
    return { ok: false, error: `CV PDF lowongan #${job.num} tidak ditemukan di ${outputDir()} (nomor ${job.num}${job.slug ? ', slug "' + job.slug + '"' : ''}).` +
      (contoh.length ? ` Berkas yang mirip: ${contoh.join(', ')}.` : ' Tidak ada berkas cv-*.pdf yang memuat nomor ini.') +
      ` Buat CV dulu lewat career-ops, lalu refresh halaman ringkasan.` };
  }
  const { rules, error: ruleErr } = loadRules();
  if (ruleErr) return { ok: false, error: ruleErr };

  const ctx = await getCtx();
  let p = await ctx.newPage();
  const st = { job, rules, cvTerpilih: false, suratTerpilih: false };

  const m = job.url.match(/id\.jobstreet\.com\/(?:id\/)?job\/(\d+)/i);
  const applyUrl = m ? `https://id.jobstreet.com/id/job/${m[1]}/apply` : '';
  await p.goto(applyUrl || job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(2500);

  if (!/\/apply/.test(p.url())) {
    for (const role of ['link', 'button']) {
      const b = p.getByRole(role, { name: /lamar|apply/i }).first();
      if (await b.isVisible({ timeout: 5000 }).catch(() => false)) { await b.click().catch(() => {}); break; }
    }
    await p.waitForTimeout(4000);
    const pages = ctx.pages();
    p = pages[pages.length - 1];
  }
  const teksAwal = await p.locator('body').innerText().catch(() => '');
  const urlAwal = p.url();
  // Sesi habis → redirect ke login. Ini BUKAN lowongan tutup, jadi jangan ditandai
  // Discarded; hentikan batch sampai login kembali.
  if (!/\/apply/.test(urlAwal) && (HALAMAN_LOGIN_RE.test(urlAwal) || /sign in to (?:your )?account|masuk ke akun|create account/i.test(teksAwal))) {
    await p.bringToFront().catch(() => {});
    return { ok: false, berhenti: true, status: 'perlu-login',
      msg: `Perlu login lagi di jendela Chrome. Lowongan ${label} tidak diubah. Setelah login, klik Lamar otomatis lagi.` };
  }
  const tutupTerdeteksi = LOWONGAN_TUTUP_RE.test(teksAwal);
  if (!/\/apply/.test(urlAwal) || tutupTerdeteksi) {
    await p.close().catch(() => {}); // jangan biarkan tab menumpuk untuk lowongan mati
    const alasan = tutupTerdeteksi
      ? 'lowongan tutup/kadaluarsa terdeteksi di halaman JobStreet'
      : 'halaman lamaran (/apply) tidak bisa dibuka';
    const t = tandaiTutup(job, alasan);
    return {
      ok: false, skip: true, status: 'lowongan-tutup', ditandai: t.ditandai, num: t.num,
      msg: `Lowongan ${label} sudah tutup / kadaluarsa / tidak valid, dilewati${t.ditandai ? ' dan ditandai selesai (Discarded)' : ''}. Lanjut ke antrean berikutnya.`,
    };
  }

  const log = [];
  const r = await langkah(p, st, log, kirimOtomatis);
  const msg = log.join('; ');
  console.log(`[${label}] ${msg}`);
  if (r.jeda) {
    // Tab tetap terbuka. Antrean DITUNGGU di sini; setelah kamu menjawab dan
    // halaman berpindah, lamarSemua() lanjut ke lowongan berikutnya. Tombol Kirim
    // tetap ada di tanganmu.
    const akhir = await tungguJawabanDanLanjut(p, st, r.jeda, log, kabar);
    const pesanAkhir = log.join('; ');
    console.log(`[${label}] ${pesanAkhir}`);
    if (akhir.selesai && kirimOtomatis) await p.close().catch(() => {});
    return {
      ok: true, msg: pesanAkhir, status: akhir.status || '', jeda: false,
      selesai: !!akhir.selesai, berhenti: !!akhir.berhenti, dilamar: !!akhir.dilamar,
      menungguDijawab: true,
    };
  }
  // Kalau sudah terkirim / dilewati karena halaman mati, tutup tab agar
  // antrean tidak menumpuk. Kalau berhenti / menunggu review manual, biarkan
  // tab terbuka untukmu.
  if ((r.selesai || r.status === 'lowongan-tutup') && kirimOtomatis) await p.close().catch(() => {});
  return { ok: true, msg, status: r.status || '', jeda: false, selesai: !!r.selesai, berhenti: !!r.berhenti, dilamar: !!r.dilamar };
}

/* ---------- Daftar lowongan yang siap dilamar ---------- */
// Discarded (lowongan tutup/kadaluarsa) dan SKIP (keputusan tidak melamar)
// tidak boleh masuk antrean lagi, walau sudah dihapus dari daftar sekalipun.
const DONE_STATES = new Set(['applied', 'responded', 'assessment', 'interview', 'offer', 'hired', 'rejected', 'discarded', 'skip']);

function statusTracker() {
  const map = {};
  if (!fs.existsSync(APP())) return map;
  for (const l of fs.readFileSync(APP(), 'utf8').split(/\r?\n/)) {
    if (!isTrackerRow(l)) continue;
    const c = l.split('|');
    map[parseInt(c[1], 10)] = (c[6] || '').trim();
  }
  return map;
}

const kunciUrl = (u) => String(u || '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');

function daftarSiap(minScore) {
  const status = statusTracker();
  const out = [];
  const urlSudah = new Set();
  for (const f of fs.readdirSync(reportsDir())) {
    if (!/\.md$/.test(f)) continue;
    const m = f.match(/^(\d+)/);
    if (!m) continue;
    const num = m[1].padStart(3, '0');
    const text = fs.readFileSync(path.join(reportsDir(), f), 'utf8');
    const score = parseFloat((text.match(/^\*\*Score:\*\* ([0-9.]+)\/5$/m) || [])[1] || '0');
    const decision = ((text.match(/^\*\*Decision:\*\* (.+)$/m) || [])[1] || '').trim();
    if (!(score >= minScore)) continue;
    if (/^skip$/i.test(decision)) continue;
    if (DONE_STATES.has((status[parseInt(num, 10)] || '').toLowerCase())) continue;
    const job = findJob(num);
    if (!job.url || !/jobstreet/i.test(job.url)) continue;
    if (!job.cvPath || !fs.existsSync(job.cvPath) || !cvSesuai(job.cvName, job.num, job.slug)) continue;
    const head = ((text.match(/^# Evaluation:\s*(.+)$/m) || [])[1] || '').trim();
    const [company, role] = head.split(' — ');
    urlSudah.add(kunciUrl(job.url));
    out.push({ ...job, score, company: (company || '').trim(), role: (role || '').trim() });
  }

  // Baris hasil scan juga ikut antrean. Mereka tidak punya nomor laporan, jadi
  // identitasnya memakai idScan(url) dan berkas CV/surat yang dibuat ringkasan.
  const pipe = path.join(ROOT(), 'data', 'pipeline.md');
  if (fs.existsSync(pipe)) {
    const selesai = new Set(daftarScanDilamar());
    const ditutup = new Set(daftarScanDitutup());
    // Sama seperti tabel ringkasan: pakai tanggal kalender lokal supaya
    // lowongan persis 14 hari masih masuk antrean.
    const hariIni = new Date();
    hariIni.setHours(0, 0, 0, 0);
    const batas = hariIni.getTime() - 14 * 86_400_000;
    const berkas = fs.readdirSync(outputDir());
    // Skor cepat hasil scan dihitung dengan input yang SAMA seperti di
    // ringkasan.mjs, supaya urutan antrean mengikuti angka di tabel. Ini bukan
    // skor evaluasi career-ops resmi dan bukan peluang diterima.
    let cvSkor = null;
    let profilSkor = null;
    try { cvSkor = bacaCv(); } catch { /* tanpa CV, skor tidak dihitung */ }
    try { profilSkor = bacaProfilSkor(); } catch { /* tanpa profil, skor tetap dihitung sebagian */ }
    for (const l of fs.readFileSync(pipe, 'utf8').split(/\r?\n/)) {
      if (!/^- \[ \] /.test(l)) continue;
      const c = l.replace(/^- \[ \] /, '').split(' | ').map((x) => x.trim());
      const url = c[0] || '';
      if (!/^https?:\/\//.test(url) || !/jobstreet/i.test(url)) continue;
      const posted = (l.match(/posted:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
      if (posted && Date.parse(posted + 'T00:00:00') < batas) continue;
      const kunci = kunciUrl(url);
      if (urlSudah.has(kunci)) continue;
      const scanId = idScan(url);
      if (selesai.has(scanId) || ditutup.has(scanId)) continue;
      const cvName = berkas.find((f) => /^cv-.*\.pdf$/i.test(f) && f.includes(`${scanId}-`)) || '';
      const coverName = berkas.find((f) => /^surat-lamaran-scan-.*\.pdf$/i.test(f) && f.includes(`${scanId}-`)) || '';
      if (!cvName || !coverName) continue; // belum siap: tidak masuk antrean
      const gaji = /^\d+(?:-\d+)?\s+[A-Z]{3}$/.test(c[4] || '') ? c[4] : '';
      const jdText = ambilNoteBaris(l);
      let skorScan = null;
      try {
        const payloadCepat = cvSkor
          ? susunPayload(cvSkor, { role: c[2] || '', jd: jdText, company: c[1] || '' })
          : null;
        skorScan = skorCepat({
          judul: c[2] || '', jdText, lokasi: c[3] || '', gaji,
          cv: cvSkor, profil: profilSkor, kompetensi: payloadCepat?.competencies || [],
        }).skor;
      } catch { /* skor gagal dihitung → taruh di akhir antrean */ }
      urlSudah.add(kunci);
      out.push({
        num: '', scanId, slug: '', url, score: skorScan, posted,
        company: c[1] || '(perusahaan tidak tercantum)', role: c[2] || '(lihat lowongan)',
        cvName, cvPath: path.join(outputDir(), cvName),
        coverName, coverPath: path.join(outputDir(), coverName),
      });
    }
  }

  // Urutan antrean: SKOR TERTINGGI dulu, baru turun ke yang lebih rendah.
  // Laporan memakai skor evaluasi; hasil scan memakai skor cepat berbasis bukti.
  // Kalau skor tidak bisa dihitung, taruh di akhir. Ikatan: nomor terbesar,
  // lalu tanggal posting terbaru.
  out.sort((a, b) => {
    const sa = Number.isFinite(a.score) ? a.score : -Infinity;
    const sb = Number.isFinite(b.score) ? b.score : -Infinity;
    if (sa !== sb) return sb - sa;
    const an = parseInt(a.num, 10), bn = parseInt(b.num, 10);
    if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an;
    if (Number.isFinite(an)) return -1;
    if (Number.isFinite(bn)) return 1;
    return String(b.posted || '').localeCompare(String(a.posted || ''));
  });
  return out;
}

/* ---------- Antrean otomatis: lamar semua yang siap, satu per satu ---------- */
export async function lamarSemua(opsi = {}) {
  const minScore = Number.isFinite(Number(opsi.minScore)) ? Number(opsi.minScore) : 3.0;
  // Tanpa batas jumlah: kalau opsi.maks tidak diberikan, proses semua yang siap.
  const minta = Number(opsi.maks);
  const maks = Number.isFinite(minta) && minta > 0 ? Math.floor(minta) : Infinity;
  const daftar = daftarSiap(minScore);
  const dry = !!opsi.dry || process.env.CAREER_OPS_LAMAR_DRY === '1';
  if (dry) {
    // Mode uji: hanya melaporkan apa yang akan dilamar, tidak membuka browser.
    return { minScore, total: daftar.length, diproses: 0, hasil: [], dry: true, daftar };
  }
  const hasil = [];
  let diproses = 0;
  const kabar = typeof opsi.onProgres === 'function' ? opsi.onProgres : () => {};
  kabar({ tahap: 'mulai', total: daftar.length, diproses, hasil });
  for (const item of daftar) {
    // Kuota harian sengaja tidak ada: antrean berjalan sampai daftar habis.
    if (diproses >= maks) { hasil.push({ num: item.num || item.scanId, status: 'batas-batch', msg: `Batas ${maks} lamaran untuk batch ini tercapai` }); break; }
    // Cek ulang status tepat sebelum membuka: kalau lowongan ini sudah dilamar
    // (misalnya dari tab lain saat batch berjalan), lewati tanpa membuka browser.
    const statusKini = item.num ? (statusTracker()[parseInt(item.num, 10)] || '').toLowerCase() : '';
    if (DONE_STATES.has(statusKini)) {
      hasil.push({ num: item.num, company: item.company, role: item.role,
        skip: true, status: 'sudah-dilamar', msg: `Status tracker sudah ${statusKini}, dilewati.` });
      kabar({ tahap: 'selesai-satu', total: daftar.length, diproses, sedang: item, hasil });
      continue;
    }
    kabar({ tahap: 'memproses', total: daftar.length, diproses, sedang: item, hasil });
    const r = await jalankan(item, kabar, { kirimOtomatis: !!opsi.kirimOtomatis });
    diproses++;
    hasil.push({ num: item.num || item.scanId, company: item.company, role: item.role, ...r });
    kabar({ tahap: 'selesai-satu', total: daftar.length, diproses, sedang: item, hasil });
    // Pertanyaan baru / dokumen tidak cocok butuh campur tanganmu; hentikan batch
    // di sini supaya tidak ada lamaran berikutnya yang terkirim dengan salah dokumen.
    if (r.jeda || r.berhenti) break;
    if (r.ok) {
      const istirahat = diproses % ISTIRAHAT_TIAP === 0;
      const lama = istirahat ? jedaIstirahat() : jedaBatch();
      const detik = Math.round(lama / 1000);
      kabar({
        tahap: 'jeda', total: daftar.length, diproses, hasil,
        pesan: `Jeda ${Math.floor(detik / 60)} menit ${detik % 60} detik${istirahat ? ' (istirahat panjang tiap 5 lamaran)' : ''} sebelum lowongan berikutnya...`,
      });
      await tunggu(lama);
    }
  }
  kabar({ tahap: 'selesai', total: daftar.length, diproses, hasil });
  return { minScore, total: daftar.length, diproses, hasil };
}

/* ---------- Antrean: satu lowongan sekali jalan, dengan jeda ---------- */
let antrian = Promise.resolve();
export function bukaLamaran(num, opsi = {}) {
  const hasil = antrian.then(() => jalankan(num, () => {}, opsi));
  antrian = hasil.catch(() => {}).then(() => tunggu(JEDA_MANUAL_MS));
  return hasil;
}

// Diekspor untuk pengecekan cepat: node -e "import('./lamar-modul.mjs').then(m=>console.log(m.findJob('366')))"
export { findJob, bacaPertanyaan, isiPertanyaan, daftarSiap, statusTracker, STATUS, berkasSesuai, daftarResume, bersihkanResume, jawabanYaTidak, jawabanBahasa, BATAS_RESUME_JOBSTREET, BERSIHKAN_RESUME };
