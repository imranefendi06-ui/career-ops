// ringkasan.mjs  (versi 7: urutan berdasarkan nomor terbaru + kotak centang + halaman dibuat ulang otomatis tiap browser di-refresh)
//
// Untuk setiap lowongan di reports\ (skor >= batas), skrip ini:
//   1. Membaca CV khusus lowongan itu: output\cv-...-NNN-....json
//   2. Membuat surat lamaran dari isi CV tersebut (nama, kontak, pendidikan,
//      pengalaman, kompetensi). Bagian yang dipilih diurutkan berdasarkan
//      kecocokan kata dengan teks lowongan. TIDAK ada fakta karangan.
//   3. Menyimpan surat sebagai output\surat-lamaran-NNN-<perusahaan>.pdf/.html
//   4. Membuat output\RINGKASAN-LAMARAN.html: CV, surat lamaran, link lowongan,
//      dan semua bagian laporan. Urutan tabel: nomor terbesar (terbaru) di atas.
//
// Tanpa AI, tanpa limit. Tidak mengubah file career-ops lain.
//
// Pemakaian (dari folder career-ops):
//   node ringkasan.mjs          -> skor minimal 3.0
//   node ringkasan.mjs 3.5      -> skor minimal 3.5
//   node ringkasan.mjs 0        -> semua lowongan

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { exec, execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { bukaLamaran, lamarSemua, daftarSiap, daftarDilamarBaru, daftarScanDilamar, tandaiScanDilamar, daftarScanDitutup, tandaiScanDitutup } from './lamar-modul.mjs';
import { WILAYAH, jalankanScan, formatGajiBulanan, idScan, ambilNoteBaris } from './scan-ringkasan.mjs';
import { bacaCv, susunPayload } from './buat-cv-otomatis.mjs';
import { skorCepat, bacaProfilSkor } from './skor-cepat.mjs';
import { bacaStatusCv, pratinjauCv, simpanCv, bacaIsiCv } from './cv-versi.mjs';
import { pratinjauEntri, simpanEntri, cekCv, skillGap } from './cv-entri.mjs';
import { ekstrakTeksPdf, cvDariTeks } from './cv-pdf.mjs';
import { daftarPreset, bacaPreset, simpanPreset, hapusPreset } from './scan-preset.mjs';
import { bacaTargeting, simpanTargeting, ringkasanTargeting } from './targeting-cv.mjs';
import { daftarProfil, bacaProfilAktif, buatProfilLokal, pakaiProfilLokal } from './profil-lokal.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { denganKonteks, konteksAktif, rootAktif, rootPenggunaAktif, penggunaAktif, csrfAktif, tetapkanRoot } from './konteks-root.mjs';
import {
  daftarPengguna, cariPenggunaId, cariPenggunaNama, cariPenggunaEmail,
  daftarPenggunaEmail, kirimUlangKodeEmail, verifikasiEmail, verifikasiKataSandi,
  buatSesi, bacaSesi, hapusSesi, tandaiSandiDiubah, izinCoba, catatGagal,
  hapusGagal, gantiSandi, rootDariPengguna, cookieSesi,
  buatTokenLupaSandi, cariAkunDariTokenLupa, setSandiDariLupa,
} from './auth-pengguna.mjs';
import { bacaKuota, bisaPakai, catatPemakaian, riwayatKuota, HARGA } from './kuota.mjs';
import { bacaModeKirim, catatKirimOtomatis } from './mode-kirim.mjs';
import { statusEmail, kirimKodeVerifikasi, kirimTautanReset } from './email-kirim.mjs';
import { daftarPaket, statusPembayaran, buatTransaksi, terimaWebhook, riwayatPembayaran } from './pembayaran.mjs';
import { cekUndangan, pakaiUndangan } from './undangan.mjs';

const execFileAsync = promisify(execFile);

// CODE_ROOT = tempat skrip sistem. BASE_ROOT = root data awal (pemilik).
// ROOT() = root profil aktif untuk request yang sedang berjalan.
const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE_ROOT = path.resolve(getCareerOpsRoot());
// Konfigurasi email/pembayaran dibaca dari .env kode dan .env data root.
// dotenv tidak menimpa variabel yang sudah disetel shell/launcher.
dotenv.config({ path: path.join(CODE_ROOT, '.env'), quiet: true });
if (BASE_ROOT !== CODE_ROOT) dotenv.config({ path: path.join(BASE_ROOT, '.env'), quiet: true });
const ROOT = () => rootAktif() || BASE_ROOT;
const rootPengguna = () => rootPenggunaAktif() || BASE_ROOT;
const kuotaUntuk = (id) => {
  const k = id ? bacaKuota(BASE_ROOT, id) : { ok: false, sisa: 0 };
  if (!k.ok) return { ...k, takTerbatas: false, sisa: 0, label: '—' };
  return { ...k, label: k.takTerbatas ? '∞' : String(k.sisa) };
};
const kuotaSaatIni = () => kuotaUntuk(penggunaAktif()?.id);
const kunciLamar = (target) => `lamar:${rootPengguna()}:${String(target || '')}`;
const catatKodeUji = (email, kode) => {
  const f = path.join(BASE_ROOT, 'data', 'verifikasi-email.log');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${new Date().toISOString()}\t${email}\t${kode}\n`, 'utf8');
};
const PIPELINE_TAMPIL = () => process.env.SCAN_PIPELINE || path.join(ROOT(), 'data', 'pipeline.md');
const MIN = parseFloat(process.argv[2] ?? '3.0');
const reportsDir = () => path.join(ROOT(), 'reports');
const outputDir = () => path.join(ROOT(), 'output');
const trackerDir = () => path.join(ROOT(), 'batch', 'tracker-additions');
const outFile = () => path.join(outputDir(), 'RINGKASAN-LAMARAN.html');
const profileFile = () => path.join(ROOT(), 'surat-profil.json');
const customDir = () => path.join(ROOT(), 'surat-khusus');
const APP = () => path.join(ROOT(), 'data', 'applications.md');
const PORT = Number(process.env.PORT || 3000);
const DONE = ['applied', 'responded', 'assessment', 'interview', 'offer', 'hired'];

// Cache dan penanda scan disimpan per root. Tanpa ini, build akun A bisa
// terlewat karena signature akun B kebetulan sama.
const petaScanBerkas = new Map();
const petaSignature = new Map();
const terakhirScanBerkas = () => petaScanBerkas.get(ROOT()) || { total: 0, dibuat: 0, gagal: 0 };
const simpanScanBerkas = (o) => petaScanBerkas.set(ROOT(), o);
const signatureTerakhir = () => petaSignature.get(ROOT()) || null;

const fileDirs = () => [
  { dir: path.join(ROOT(), 'output'), rel: '' },
  { dir: path.join(ROOT(), 'interview-prep'), rel: '../interview-prep/' },
];

const envAnak = () => ({ ...process.env, CAREER_OPS_ROOT: ROOT() });

const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ---------- Tracker (data/applications.md) ---------- */
const isTrackerRow = (l) => /^\|\s*\d/.test(l);
function readTracker() {
  const t = fs.readFileSync(APP(), 'utf8');
  return { lines: t.split(/\r?\n/), eol: t.includes('\r\n') ? '\r\n' : '\n' };
}
function trackerStatus() {
  const map = {};
  if (!fs.existsSync(APP())) return map;
  for (const l of readTracker().lines) {
    if (!isTrackerRow(l)) continue;
    const c = l.split('|');
    map[parseInt(c[1], 10)] = c[6].trim();
  }
  return map;
}
function toggleApplied(num, applied) {
  const n = parseInt(num, 10);
  const { lines, eol } = readTracker();
  const idx = lines.findIndex((l) => isTrackerRow(l) && parseInt(l.split('|')[1], 10) === n);
  if (idx < 0) return { ok: false, error: 'Lowongan tidak ada di data/applications.md' };
  const c = lines[idx].split('|');
  const cur = c[6].trim().toLowerCase();
  let notes = (c[9] || '').replace(/\.?\s*Dilamar \d{4}-\d{2}-\d{2}/g, '').trim();
  if (applied) {
    if (cur !== 'applied') c[6] = ' Applied ';
    notes = (notes ? notes + '. ' : '') + 'Dilamar ' + new Date().toLocaleDateString('sv-SE');
  } else {
    if (cur !== 'applied') return { ok: false, error: 'Status bukan Applied, tidak diubah' };
    c[6] = ' Evaluated ';
  }
  c[9] = ' ' + notes + ' ';
  lines[idx] = c.join('|');
  fs.writeFileSync(APP(), lines.join(eol));
  return { ok: true };
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/* ---------- Markdown mini-renderer ---------- */
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s;
}

function md(src) {
  const lines = src.split(/\r?\n/);
  let html = '';
  let para = [];
  let i = 0;
  const flush = () => {
    if (para.length) html += `<p>${inline(para.join(' '))}</p>\n`;
    para = [];
  };
  const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre>${esc(buf.join('\n'))}</pre>\n`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lvl = Math.min(h[1].length + 2, 6);
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>\n`;
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flush(); html += '<hr>\n'; i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      html += '<div class="tw"><table class="md"><thead><tr>' +
        head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>\n';
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
        items.push({ indent: Math.floor(m[1].length / 2), text: m[3] });
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>` + items.map((it) => `<li style="margin-left:${it.indent * 18}px">${inline(it.text)}</li>`).join('') + `</${tag}>\n`;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${buf.map(inline).join('<br>')}</blockquote>\n`;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return html;
}

function splitReport(text) {
  const lines = text.split(/\r?\n/);
  const head = [];
  const sections = [];
  let cur = null;
  let fence = false;
  for (const l of lines) {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && l.match(/^##\s+(.*)$/);
    if (m) {
      cur = { title: m[1].trim(), lines: [] };
      sections.push(cur);
    } else if (cur) cur.lines.push(l);
    else head.push(l);
  }
  return { head: head.join('\n'), sections: sections.map((s) => ({ title: s.title, body: s.lines.join('\n') })) };
}

/* ---------- Surat lamaran dari CV JSON ---------- */
// Memperbaiki tanda yang rusak (mis. "â€“" seharusnya "–")
const fix = (s) =>
  String(s ?? '')
    .replace(/\u00e2\u20ac[\u201c]/g, '–')
    .replace(/\u00e2\u20ac[\u201d]/g, '—')
    .replace(/\u00e2\u20ac\u2122/g, '’')
    .trim();
const lcFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const stripDot = (s) => String(s).replace(/[.\s]+$/, '');

const STOP = new Set([
  'dengan', 'untuk', 'yang', 'dalam', 'pada', 'serta', 'dari', 'atau', 'dapat', 'sesuai', 'adalah',
  'akan', 'oleh', 'lebih', 'harus', 'memiliki', 'tidak', 'juga', 'minimal', 'maksimal', 'kandidat',
  'posisi', 'perusahaan', 'kemampuan', 'pengalaman', 'bekerja', 'lowongan', 'tanggung', 'jawab',
]);
const wordsOf = (s) => (String(s).toLowerCase().match(/[a-z]{5,}/g) || []).filter((w) => !STOP.has(w));
function overlap(text, jdSet) {
  let n = 0;
  for (const w of new Set(wordsOf(text))) if (jdSet.has(w)) n++;
  return n;
}
const rank = (items, getText, jdSet) =>
  items
    .map((it, i) => ({ it, i, s: overlap(getText(it), jdSet) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);

function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]}; serta ${items[1]}`;
  return `${items.slice(0, -1).join('; ')}; serta ${items[items.length - 1]}`;
}

function sourceName(url) {
  if (/jobstreet/i.test(url)) return 'JobStreet';
  if (/linkedin/i.test(url)) return 'LinkedIn';
  if (/glints/i.test(url)) return 'Glints';
  if (/kalibrr/i.test(url)) return 'Kalibrr';
  if (/indeed/i.test(url)) return 'Indeed';
  return 'situs lowongan';
}

function loadOptionalProfile() {
  const out = { lampiran: ['CV', 'Ijazah dan transkrip nilai'], motivasi: '' };
  try {
    if (fs.existsSync(profileFile())) {
      const p = JSON.parse(readText(profileFile()));
      if (Array.isArray(p.lampiran) && p.lampiran.length) out.lampiran = p.lampiran;
      if (p.motivasi && !/^\s*ISI/i.test(p.motivasi)) out.motivasi = p.motivasi;
    }
  } catch {
    /* abaikan, pakai bawaan */
  }
  return out;
}

function buildLetter(cv, ctx, opt) {
  const c = cv.candidate || {};
  const name = fix(c.name);
  const city = fix((c.location || 'Pekanbaru').split(',')[0]);
  const contact = [fix(c.phone), fix(c.email)].filter(Boolean).join(' | ');
  const tanggal = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const sub = (t) => String(t).replaceAll('{perusahaan}', ctx.company).replaceAll('{posisi}', ctx.role);
  const jdSet = new Set(wordsOf(`${ctx.jdText} ${ctx.role}`));

  // Pendidikan
  const edu = (cv.education || [])[0];
  let eduText = '';
  if (edu) {
    const years = fix(edu.year).match(/\d{4}/g) || [];
    const ipk = (fix(edu.description).match(/IPK\s*([\d.,]+)/i) || [])[1];
    eduText = `lulusan ${fix(edu.title)} ${fix(edu.org)}` +
      (years.length ? ` tahun ${years[years.length - 1]}` : '') +
      (ipk ? ` dengan IPK ${stripDot(ipk)}` : '');
  }

  // Pengalaman: pilih butir yang paling cocok dengan lowongan
  const exp = (cv.experience || [])[0];
  let expPara = '';
  let matched = false;
  if (exp && Array.isArray(exp.bullets) && exp.bullets.length) {
    const ranked = rank(exp.bullets, (b) => b, jdSet).slice(0, 3);
    if (ranked.some((r) => r.s > 0)) matched = true;
    const picked = ranked.map((r) => lcFirst(stripDot(fix(r.it))));
    const roleShort = fix(exp.role).split(/\s*[–—-]\s*/)[0].trim();
    expPara =
      `Saya memiliki pengalaman ${roleShort.toLowerCase()} di ${fix(exp.company)}` +
      (exp.location ? `, ${fix(exp.location)}` : '') +
      (exp.dates ? ` (${fix(exp.dates)})` : '') +
      `. Dalam kegiatan tersebut, saya ${joinList(picked)}.`;
  }

  // Kompetensi: pilih yang paling cocok dengan lowongan
  let compPara = '';
  const comps = Array.isArray(cv.competencies) ? cv.competencies : [];
  if (comps.length) {
    const rc = rank(comps, (x) => x, jdSet).slice(0, 4);
    const hit = rc.some((r) => r.s > 0);
    if (hit) matched = true;
    compPara = `Kompetensi saya${hit ? ' yang relevan dengan posisi ini' : ''} antara lain ${rc.map((r) => fix(r.it)).join(', ')}.`;
    const office = (cv.skills || []).find((s) => /office/i.test(s.category || ''));
    if (office && office.items) compPara += ` Saya juga terbiasa menggunakan Microsoft Office (${fix(office.items)}).`;
  }

  const closingWish = ctx.khusus
    ? sub(ctx.khusus.trim())
    : sub(opt.motivasi || `Saya ingin berkontribusi pada posisi {posisi} di {perusahaan} dan siap belajar dengan cepat sesuai kebutuhan perusahaan.`);

  const paragraphs = [
    'Dengan hormat,',
    `Saya ${name}${eduText ? `, ${eduText}` : ''}. Melalui ${sourceName(ctx.url)}, saya mengetahui lowongan ${ctx.role} di ${ctx.company} dan dengan ini mengajukan lamaran untuk posisi tersebut.`,
    expPara,
    compPara,
    closingWish,
    `Sebagai kelengkapan, saya lampirkan: ${opt.lampiran.join(', ')}. Saya bersedia mengikuti tahapan seleksi sesuai jadwal yang ditentukan. Terima kasih atas waktu dan perhatian Bapak/Ibu.`,
  ].filter(Boolean);

  const text =
    `${city}, ${tanggal}\n\nPerihal: Lamaran Pekerjaan - ${ctx.role}\n\nKepada Yth.\nBagian HRD\n${ctx.company}\n\n` +
    paragraphs.join('\n\n') +
    `\n\nHormat saya,\n\n\n${name}\n${contact}\n`;

  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><title>Surat Lamaran - ${esc(ctx.company)}</title>
<style>
  @page { size: A4; margin: 22mm; }
  body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.45; color:#000; }
  p { margin: 0 0 11pt; text-align: justify; }
  .r { text-align: right; }

  /* Kompatibilitas kelas lama yang masih dipakai bagian detail */
  .belum { display:inline-block; padding:2px 9px; border-radius:999px; font-size:.72rem; font-weight:700; background:var(--surface-soft); color:var(--muted); border:1px solid var(--line); }
  .hd { margin: 8px 0 12px; }
  .scan-baru { }
</style></head><body>
<p class="r">${esc(city)}, ${esc(tanggal)}</p>
<p>Perihal: Lamaran Pekerjaan - ${esc(ctx.role)}</p>
<p>Kepada Yth.<br>Bagian HRD<br>${esc(ctx.company)}</p>
${paragraphs.map((x) => `<p>${esc(x)}</p>`).join('\n')}
<p>Hormat saya,<br><br><br>${esc(name)}<br>${esc(contact)}</p>
</body></html>`;
  return { text, html, matched };
}

let lastPdfError = '';
async function htmlToPdf(htmlPath, pdfPath) {
  for (const pkg of ['playwright', 'playwright-core']) {
    try {
      const { chromium } = await import(pkg);
      const browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(pathToFileURL(htmlPath).href);
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
      await browser.close();
      return true;
    } catch (e) {
      lastPdfError = `${pkg}: ${String(e.message).split('\n')[0]}`;
    }
  }
  return false;
}

/* ---------- Seluruh proses pembuatan ringkasan (dijalankan tiap halaman dibuka) ---------- */
async function build() {
if (!fs.existsSync(reportsDir())) {
  throw new Error('Folder reports\\ tidak ditemukan. Jalankan dari folder career-ops.');
}
if (fs.existsSync(APP())) fs.copyFileSync(APP(), path.join(ROOT(), 'data', 'applications.backup-ringkasan.md'));

const tsvInfo = {};
for (const f of walk(trackerDir()).filter((f) => f.endsWith('.tsv'))) {
  for (const line of readText(f).split(/\r?\n/)) {
    const c = line.split('\t');
    if (!/^\d+$/.test((c[0] || '').trim())) continue;
    tsvInfo[c[0].trim().padStart(3, '0')] = { company: c[2], role: c[3] };
  }
}

const rows = [];
for (const name of fs.readdirSync(reportsDir()).filter((n) => /^\d+.*\.md$/.test(n))) {
  const text = readText(path.join(reportsDir(), name));
  const num = name.match(/^(\d+)/)[1].padStart(3, '0');
  const slug = name.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
  const { head, sections } = splitReport(text);

  const score = parseFloat((head.match(/\*\*Score:\*\*\s*([\d.]+)/) || [])[1]);
  if (Number.isNaN(score) || score < MIN) continue;

  const urlLine = (head.match(/\*\*URL:\*\*.*/) || [''])[0];
  const url = (urlLine.match(/https?:\/\/[^\s)>\]]+/) || [''])[0];
  const legit = ((head.match(/\*\*Legitimacy:\*\*\s*(.*)/) || [])[1] || 'tidak tercatat').replace(/\*\*/g, '').trim();

  const title = (head.match(/^#\s+(.*)$/m) || [])[1] || '';
  let company = tsvInfo[num]?.company;
  let role = tsvInfo[num]?.role;
  if (!company || !role) {
    const t = title.replace(/^[^:]*:\s*/, '');
    const parts = t.split(/\s+(?:--|—|–|-)\s+/);
    company = company || parts[0] || slug;
    role = role || parts.slice(1).join(' - ') || '(lihat laporan)';
  }
  const jdText = (sections.find((s) => /^Job Description/i.test(s.title)) || {}).body || '';
  rows.push({ num, slug, company, role, score, url, legit, report: name, head, sections, title, jdText, letterText: '' });
}
rows.sort((a, b) => parseInt(b.num, 10) - parseInt(a.num, 10));

function bacaLowonganScan() {
  const pipe = PIPELINE_TAMPIL();
  if (!fs.existsSync(pipe)) return [];
  const sudah = new Set(rows.map((r) => String(r.url || '').trim()).filter(Boolean));
  // Bandingkan tanggal kalender, bukan selisih jam: lowongan yang persis 14
  // hari tetap tampil. Date.now() - 14*hari menyembunyikan lowongan yang
  // diunggah 14 hari lalu sebelum jam sekarang.
  const hariIni = new Date();
  hariIni.setHours(0, 0, 0, 0);
  const batas = hariIni.getTime() - 14 * 86_400_000;
  const keluar = [];
  const dilihat = new Set();
  for (const l of fs.readFileSync(pipe, 'utf8').split(/\r?\n/)) {
    if (!/^- \[ \] /.test(l)) continue;
    const c = l.replace(/^- \[ \] /, '').split(' | ').map((x) => x.trim());
    const url = c[0] || '';
    if (!/^https?:\/\//.test(url) || sudah.has(url) || dilihat.has(url)) continue;
    const posted = (l.match(/posted:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    if (posted && Date.parse(posted + 'T00:00:00') < batas) continue;
    const gaji = /^\d+(?:-\d+)?\s+[A-Z]{3}$/.test(c[4] || '') ? c[4] : '';
    const location = c[3] || '';
    dilihat.add(url);
    keluar.push({
      scan: true, scanIdx: keluar.length, num: '', company: c[1] || '(perusahaan tidak tercantum)',
      role: c[2] || '(lihat lowongan)', url, location, posted, score: null, legit: 'Belum dinilai',
      gaji, gajiTeks: formatGajiBulanan(gaji),
      jdText: ambilNoteBaris(l), scanId: idScan(url),
    });
  }
  keluar.sort((a, b) => String(b.posted || '').localeCompare(String(a.posted || '')));
  keluar.forEach((r, i) => { r.scanIdx = i; });
  return keluar;
}
const scanRows = bacaLowonganScan();
const semuaBaris = [...scanRows, ...rows];

/* ---------- Buat surat lamaran dari CV JSON ---------- */
fs.mkdirSync(outputDir(), { recursive: true });
const isCoverName = (n) => /cover|surat/i.test(n);
const numRe = (num) => new RegExp(`(^|[-_])${num}([-_.]|$)`);
const opt = loadOptionalProfile();
const existing = fs.readdirSync(outputDir());

let cvScan = null;
try { cvScan = bacaCv(); }
catch (e) { console.error('cv.md tidak bisa dibaca untuk CV hasil scan: ' + e.message); }

let profilSkor = null;
try { profilSkor = bacaProfilSkor(ROOT()); }
catch (e) { console.error('config/profile.yml tidak bisa dibaca untuk skor cepat: ' + e.message); }

const slugScan = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/[0-9]+/g, '')
  .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'lowongan';

let scanDibuat = 0;
const scanGagal = [];
for (const r of scanRows) {
  const hash = String(r.scanId || idScan(r.url)).replace(/^scan-/, '');
  const nm = slugScan(cvScan?.candidate?.name) || 'imran-efendi-pane';
  const cvDasar = `cv-${nm}-scan-${hash}-${slugScan(r.company)}-${slugScan(r.role)}`;
  const suratDasar = `surat-lamaran-scan-${hash}-${slugScan(r.company)}-${slugScan(r.role)}`;
  const cvJsonPath = path.join(outputDir(), `${cvDasar}.json`);
  const cvHtmlPath = path.join(outputDir(), `${cvDasar}.html`);
  const cvPdfPath = path.join(outputDir(), `${cvDasar}.pdf`);
  const suratHtmlPath = path.join(outputDir(), `${suratDasar}.html`);
  const suratPdfPath = path.join(outputDir(), `${suratDasar}.pdf`);
  const suratTxtPath = path.join(outputDir(), `${suratDasar}.txt`);
  let baru = false;

  let payloadScan = null;
  try {
    payloadScan = cvScan
      ? susunPayload(cvScan, { role: r.role, jd: r.jdText || '', company: r.company })
      : null;
  } catch (e) {
    scanGagal.push(`${r.company}: payload (${String(e.message || e).split('\n')[0].slice(0, 120)})`);
  }
  try {
    const cepat = skorCepat({
      judul: r.role, jdText: r.jdText || '', lokasi: r.location, gaji: r.gaji,
      cv: cvScan, profil: profilSkor, kompetensi: payloadScan?.competencies || [],
    });
    r.skorCepat = cepat.skor;
    r.skorRincian = cepat.rincian;
    r.skorJumlahTerukur = cepat.jumlahTerukur;
    r.skorMaksTerukur = cepat.maksTerukur;
  } catch (e) {
    r.skorCepat = null;
    r.skorRincian = [];
    r.skorJumlahTerukur = 0;
    r.skorMaksTerukur = 0;
    scanGagal.push(`${r.company}: skor (${String(e.message || e).split('\n')[0].slice(0, 120)})`);
  }

  if (cvScan && !fs.existsSync(cvPdfPath)) {
    try {
      if (!payloadScan) throw new Error('payload CV tidak tersedia');
      const payload = payloadScan;
      fs.writeFileSync(cvJsonPath, JSON.stringify(payload, null, 2), 'utf8');
      await execFileAsync(process.execPath, [path.join(CODE_ROOT, 'build-cv-html.mjs'), cvJsonPath, cvHtmlPath], {
        cwd: CODE_ROOT, env: envAnak(), timeout: 60_000,
      });
      await execFileAsync(process.execPath, [
        path.join(CODE_ROOT, 'generate-pdf.mjs'), cvHtmlPath, cvPdfPath,
        '--format=a4', '--kind=cv', '--allow-nonchronological',
      ], { cwd: CODE_ROOT, env: envAnak(), timeout: 180_000 });
      if (!fs.existsSync(cvPdfPath)) throw new Error('PDF CV tidak terbentuk.');
      baru = true;
    } catch (e) {
      scanGagal.push(`${r.company}: CV (${String(e.message || e).split('\n')[0].slice(0, 120)})`);
    }
  }

  if (cvScan && !fs.existsSync(suratPdfPath)) {
    try {
      const payload = payloadScan || (fs.existsSync(cvJsonPath)
        ? JSON.parse(readText(cvJsonPath))
        : null);
      if (!payload) throw new Error('payload CV tidak tersedia');
      const { text, html } = buildLetter(payload, {
        company: r.company, role: r.role, url: r.url, jdText: r.jdText || '', khusus: '',
      }, opt);
      fs.writeFileSync(suratTxtPath, text, 'utf8');
      fs.writeFileSync(suratHtmlPath, html, 'utf8');
      if (!fs.existsSync(suratPdfPath)) await htmlToPdf(suratHtmlPath, suratPdfPath);
      r.letterText = text;
      baru = true;
    } catch (e) {
      scanGagal.push(`${r.company}: surat (${String(e.message || e).split('\n')[0].slice(0, 120)})`);
    }
  }

  if (fs.existsSync(suratTxtPath) && !r.letterText) {
    try { r.letterText = readText(suratTxtPath); } catch { /* abaikan */ }
  }
  if (baru) scanDibuat++;
  r.cvScan = fs.existsSync(cvPdfPath) ? { name: `${cvDasar}.pdf`, href: `${cvDasar}.pdf` } : null;
  r.suratScan = fs.existsSync(suratPdfPath)
    ? { name: `${suratDasar}.pdf`, href: `${suratDasar}.pdf` }
    : fs.existsSync(suratHtmlPath)
      ? { name: `${suratDasar}.html`, href: `${suratDasar}.html` }
      : null;
}
simpanScanBerkas({ total: scanRows.length, dibuat: scanDibuat, gagal: scanGagal.length });

let made = 0;
let pdfs = 0;
const noCv = [];
for (const r of rows) {
  const re = numRe(r.num);
  if (existing.some((f) => isCoverName(f) && re.test(f) && !f.startsWith('surat-lamaran-'))) continue;

  const cvJson = existing.find((f) => /^cv-.*\.json$/i.test(f) && re.test(f));
  if (!cvJson) { noCv.push(r.num); continue; }

  let cv;
  try {
    cv = JSON.parse(readText(path.join(outputDir(), cvJson)));
  } catch (e) {
    console.error(`CV JSON ${cvJson} tidak bisa dibaca: ${e.message}`);
    noCv.push(r.num);
    continue;
  }

  const khususFile = path.join(customDir(), `${r.num}.txt`);
  const khusus = fs.existsSync(khususFile) ? readText(khususFile) : '';
  const { text, html, matched } = buildLetter(cv, { company: r.company, role: r.role, url: r.url, jdText: r.jdText, khusus }, opt);
  r.letterText = text;
  r.letterMatched = matched;

  const base = `surat-lamaran-${r.num}-${r.slug}`;
  const htmlPath = path.join(outputDir(), `${base}.html`);
  const pdfPath = path.join(outputDir(), `${base}.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  if (fs.existsSync(pdfPath)) pdfs++;
  else if (await htmlToPdf(htmlPath, pdfPath)) pdfs++;
  made++;
}

let letterStatus = `Surat lamaran dibuat dari CV: ${made} (PDF: ${pdfs}).`;
if (made > pdfs) {
  letterStatus += `\nYang belum PDF: buka file surat-lamaran-*.html di folder output, tekan Ctrl+P, lalu Simpan sebagai PDF.\nAlasan PDF gagal dibuat otomatis: ${lastPdfError || 'tidak diketahui'}`;
}
if (noCv.length) {
  letterStatus += `\nTidak ada CV JSON untuk lowongan nomor: ${noCv.join(', ')} (surat tidak dibuat).`;
}
if (scanRows.length) {
  letterStatus += `\nCV + surat hasil scan: ${scanDibuat} dibuat dari ${scanRows.length} lowongan hasil scan di tabel.`;
  if (scanGagal.length) letterStatus += `\nGagal: ${scanGagal.slice(0, 5).join('; ')}`;
  if (!cvScan) letterStatus += '\ncv.md tidak bisa dibaca, sehingga berkas scan tidak dibuat.';
}

/* ---------- Cocokkan berkas ---------- */
const allFiles = [];
for (const { dir, rel } of fileDirs()) {
  for (const f of walk(dir)) {
    const sub = path.relative(dir, f).split(path.sep).join('/');
    allFiles.push({ name: path.basename(f), href: rel + sub });
  }
}

for (const r of rows) {
  const re = numRe(r.num);
  const mine = allFiles.filter((f) => {
    if (/^cv-.*\.(html|json)$/i.test(f.name)) return false;
    if (/\.json$/i.test(f.name)) return false;
    if (f.name === 'RINGKASAN-LAMARAN.html') return false;
    return re.test(f.name) || f.name.includes(r.slug);
  });
  const isCover = (f) => isCoverName(f.name);
  const isCv = (f) => /^cv-.*\.pdf$/i.test(f.name) && !isCover(f);
  r.cv = mine.find(isCv);
  let covers = mine.filter(isCover);
  if (covers.some((c) => /\.pdf$/i.test(c.name))) covers = covers.filter((c) => /\.pdf$/i.test(c.name));
  r.covers = covers;
  r.others = mine.filter((f) => !isCover(f) && !isCv(f));
}

/* ---------- HTML ringkasan ---------- */
const lnk = (href, label, ext = true) =>
  `<a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${esc(label)}</a>`;
const dash = '<span class="muted">-</span>';

const stMap = trackerStatus();
const scanApplied = new Set(daftarScanDilamar().map(String));
const scanDitutup = new Set(daftarScanDitutup().map(String));
const appliedCount = semuaBaris.filter((r) => DONE.includes((stMap[parseInt(r.num, 10)] || '').toLowerCase())).length;
let siapHitung = 0;
try { siapHitung = daftarSiap(MIN).length; } catch (e) { console.error('Gagal menghitung lowongan siap: ' + e.message); }

/* ---------- Fase 2: pengayaan tabel dari sumber eksplisit ----------
 * Aturan: tidak ada yang ditebak.
 * - Tanggal ditemukan = first_seen di data/scan-history.tsv.
 * - Tanggal unggah = posted: di pipeline (scan) atau posted_at di riwayat scan.
 * - **Date:** di laporan adalah tanggal EVALUASI, bukan tanggal unggah — tidak dipakai.
 * - Wilayah/kota = teks lokasi yang memang tertulis, dipetakan ke daftar WILAYAH.
 * - Gaji/bulan = kolom comp pipeline yang sudah dikonversi formatGajiBulanan().
 *   Laporan tidak punya kolom gaji eksplisit → tetap "tidak dicantumkan".
 * - Portal = kolom portal di riwayat scan, atau hostname URL bila kosong.
 * - CV dipakai = catatan `cv:` di tracker / .lamar-scan-cv.json.
 */
const riwayatScan = new Map();
try {
  const sh = path.join(ROOT(), 'data', 'scan-history.tsv');
  if (fs.existsSync(sh)) {
    const garis = readText(sh).split(/\r?\n/);
    const hdr = (garis.shift() || '').split('\t').map((x) => x.trim());
    const i = (n) => hdr.indexOf(n);
    const iu = i('url'), ia = i('first_seen'), ip = i('portal'), il = i('location'), ib = i('posted_at');
    for (const g of garis) {
      const c = g.split('\t');
      const u = (c[iu] || '').trim();
      if (!u || riwayatScan.has(u)) continue;
      riwayatScan.set(u, {
        ditemukan: ia >= 0 ? (c[ia] || '').trim() : '',
        portal: ip >= 0 ? (c[ip] || '').trim() : '',
        lokasi: il >= 0 ? (c[il] || '').trim() : '',
        posted: ib >= 0 ? (c[ib] || '').trim() : '',
      });
    }
  }
} catch (e) { console.error('Fase 2: riwayat scan tidak bisa dibaca: ' + e.message); }

const cvScanMap = (() => {
  try {
    const o = JSON.parse(readText(path.join(ROOT(), '.lamar-scan-cv.json')));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
})();
const cvTrackerMap = {};
for (const g of readTracker().lines) {
  if (!isTrackerRow(g)) continue;
  const c = g.split('|');
  const m = (c[9] || '').match(/cv:(cv-[a-z0-9-]+)/i);
  if (m) cvTrackerMap[parseInt(c[1], 10)] = m[1];
}

// Alias tambahan HANYA untuk tampilan/filter tabel, tidak mengubah perilaku scan.
// Portals/JobStreet kerap memakai nama provinsi bahasa Inggris.
const aliasInggris = {
  'Sumatera Utara': ['North Sumatra'], 'Sumatera Barat': ['West Sumatra'],
  'Sumatera Selatan': ['South Sumatra'], 'Kepulauan Riau': ['Riau Islands'],
  'Kepulauan Bangka Belitung': ['Bangka Belitung Islands'],
  'DKI Jakarta': ['Jakarta'], 'Jawa Barat': ['West Java'], 'Jawa Tengah': ['Central Java'],
  'DI Yogyakarta': ['Yogyakarta'], 'Jawa Timur': ['East Java'],
  'Nusa Tenggara Barat': ['West Nusa Tenggara'], 'Nusa Tenggara Timur': ['East Nusa Tenggara'],
  'Kalimantan Barat': ['West Kalimantan'], 'Kalimantan Tengah': ['Central Kalimantan'],
  'Kalimantan Selatan': ['South Kalimantan'], 'Kalimantan Timur': ['East Kalimantan'],
  'Kalimantan Utara': ['North Kalimantan'], 'Sulawesi Utara': ['North Sulawesi'],
  'Sulawesi Tengah': ['Central Sulawesi'], 'Sulawesi Selatan': ['South Sulawesi'],
  'Sulawesi Tenggara': ['Southeast Sulawesi'], 'Sulawesi Barat': ['West Sulawesi'],
  'Maluku Utara': ['North Maluku'], 'Papua Barat': ['West Papua'],
  'Papua Selatan': ['South Papua'], 'Papua Tengah': ['Central Papua'],
  'Papua Pegunungan': ['Highland Papua'], 'Papua Barat Daya': ['Southwest Papua'],
};
// Urutkan alias terpanjang lebih dulu: "Riau Islands" harus menang atas "Riau",
// "Kepulauan Riau" atas "Riau", "South Sumatra" atas "Sumatra".
const petakanAlias = WILAYAH.flatMap((pulau) => pulau.provinsi.flatMap((p) => {
  const alias = [...new Set([p.nama, ...(p.alias || []), ...(aliasInggris[p.nama] || [])])];
  return alias.map((a) => ({ alias: String(a).toLowerCase(), nama: p.nama, kota: p.kota || [] }));
})).sort((a, b) => b.alias.length - a.alias.length);
function petakanLokasi(teks) {
  const s = String(teks || '').toLowerCase();
  if (!s.trim()) return { provinsi: '', kota: '' };
  for (const e of petakanAlias) {
    if (!e.alias || !s.includes(e.alias)) continue;
    const kota = e.kota.find((k) => s.includes(String(k).toLowerCase())) || '';
    return { provinsi: e.nama, kota };
  }
  return { provinsi: '', kota: '' };
}
function sumberDari(url, portal) {
  if (portal) return portal;
  const h = String(url || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (!h) return '';
  if (/jobstreet/.test(h)) return 'jobstreet (agregator)';
  if (/linkedin/.test(h)) return 'linkedin (agregator)';
  if (/ashby/.test(h)) return 'ashby (ATS)';
  if (/greenhouse|boards\.gh/.test(h)) return 'greenhouse (ATS)';
  if (/lever\.co/.test(h)) return 'lever (ATS)';
  if (/workday|myworkdayjobs/.test(h)) return 'workday (ATS)';
  return h;
}
const HARI_MS = 86_400_000;
const _hr = new Date();
const hariIniUTC = Date.UTC(_hr.getUTCFullYear(), _hr.getUTCMonth(), _hr.getUTCDate());
function umurDari(posted) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(posted || '')) return null;
  const u = Math.round((hariIniUTC - Date.parse(posted + 'T00:00:00Z')) / HARI_MS);
  return u >= 0 ? u : 0;
}
function angkaGajiBulanan(teks) {
  const m = String(teks || '').match(/^(\d+)(?:-(\d+))?\s+[A-Z]{3}$/);
  return m ? Math.round(Number(m[1]) / 12) : null;
}
function lokasiDariJudul(title) {
  const m = String(title || '').match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : '';
}

for (const r of semuaBaris) {
  const hist = riwayatScan.get(String(r.url || '').trim()) || null;
  const lokasi = r.scan ? (r.location || '') : ((hist && hist.lokasi) || lokasiDariJudul(r.title));
  const petakan = petakanLokasi(lokasi);
  const posted = r.scan ? (r.posted || '') : ((hist && hist.posted) || '');
  const gaji = r.scan ? (r.gaji || '') : '';
  const id = String(r.scanId || idScan(r.url));
  r.wilayah = petakan.provinsi;
  r.kota = petakan.kota;
  r.lokasiTampil = lokasi;
  r.gajiBulanan = r.scan && r.gajiTeks ? r.gajiTeks : '';
  r.gajiAngka = angkaGajiBulanan(gaji);
  r.postedTampil = posted;
  r.ditemukan = hist ? hist.ditemukan : '';
  r.umur = umurDari(posted);
  r.sumber = sumberDari(r.url, hist ? hist.portal : '');
  r.statusTeks = r.scan
    ? (scanDitutup.has(id) ? 'Discarded' : scanApplied.has(id) ? 'Applied' : 'Baru')
    : (stMap[parseInt(r.num, 10)] || 'Belum tercatat');
  r.cvDipakai = r.scan ? (cvScanMap[id] || '') : (cvTrackerMap[parseInt(r.num, 10)] || '');
  r.skorTampil = r.scan ? r.skorCepat : r.score;
  r.skorLabel = r.scan ? 'Skor cepat' : 'Skor laporan';
}

const legitKelas = (t) => {
  const s = String(t).toLowerCase();
  if (/high|tinggi|verified|terverifikasi/.test(s)) return 'ok';
  if (/suspicious|scam|low|rendah|waspada/.test(s)) return 'bad';
  if (/caution|hati|medium|sedang|proceed/.test(s)) return 'warn';
  return 'neutral';
};
const skorKelas = (s) => (s >= 4.5 ? 'tinggi' : s >= 4.0 ? 'sedang' : 'rendah');
const chip = (href, label) => `<a class="chip" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;

const kosongTeks = (teks) => `<span class="muted">${esc(teks)}</span>`;
const umurBadge = (u) => u == null
  ? kosongTeks('tanpa tanggal')
  : `<span class="umur-badge${u > 14 ? ' tua' : ''}" title="${u > 14 ? 'Lewat 14 hari — disarankan Discarded' : 'Dihitung dari tanggal unggah yang tercantum'}">${u} hari${u > 14 ? ' ⚠' : ''}</span>`;
const wilayahSel = (r) => r.wilayah
  ? `<span title="${esc(r.lokasiTampil || r.wilayah)}">${esc(r.wilayah)}${r.kota ? `<div class="muted" style="font-size:.74rem;margin-top:2px">${esc(r.kota)}</div>` : ''}</span>`
  : kosongTeks(r.lokasiTampil ? `${r.lokasiTampil} (provinsi tidak dikenal)` : 'tidak dicantumkan');
const atributBaris = (r) => [
  `data-num="${esc(r.num)}"`,
  `data-scan="${esc(r.scan ? String(r.scanId || idScan(r.url)) : '')}"`,
  `data-skor="${r.skorTampil == null ? '0' : Number(r.skorTampil).toFixed(1)}"`,
  `data-belum="${r.scan ? '1' : '0'}"`,
  `data-wilayah="${esc((r.wilayah || '').toLowerCase())}"`,
  `data-kota="${esc((r.kota || '').toLowerCase())}"`,
  `data-gaji="${r.gajiAngka == null ? '' : r.gajiAngka}"`,
  `data-umur="${r.umur == null ? '' : r.umur}"`,
  `data-sumber="${esc((r.sumber || '').toLowerCase())}"`,
  `data-status="${esc((r.statusTeks || '').toLowerCase())}"`,
  `data-cv="${esc(r.cvDipakai || '')}"`,
  `data-detail="${esc(r.scan ? '#scan-' + r.scanIdx : '#job-' + r.num)}"`,
  `data-cari="${esc([r.num, r.company, r.role, r.lokasiTampil, r.wilayah, r.kota, r.sumber, r.cvDipakai].filter(Boolean).join(' ').toLowerCase())}"`,
].join(' ');

const tableRows = semuaBaris.map((r) => {
  const kolomTengah = [
    `<td>${wilayahSel(r)}</td>`,
    `<td>${r.gajiBulanan ? esc(r.gajiBulanan) : kosongTeks('tidak dicantumkan')}</td>`,
    `<td>${r.postedTampil ? esc(r.postedTampil) : kosongTeks('tanpa tanggal')}</td>`,
    `<td>${r.ditemukan ? esc(r.ditemukan) : kosongTeks('tidak dicantumkan')}</td>`,
    `<td>${umurBadge(r.umur)}</td>`,
    `<td>${r.sumber ? esc(r.sumber) : kosongTeks('tidak dicantumkan')}</td>`,
  ].join('\n  ');
  const cvDipakai = r.cvDipakai
    ? `<span class="chip" title="Versi CV yang tercatat dipakai">${esc(r.cvDipakai)}</span>`
    : kosongTeks('belum tercatat');

  if (r.scan) {
    const scanId = String(r.scanId || idScan(r.url));
    const ditutup = scanDitutup.has(scanId);
    const sudah = scanApplied.has(scanId) || ditutup;
    const skor = r.skorCepat == null
      ? '<span class="badge badge-neutral">Belum dinilai</span>'
      : `<span class="skor ${skorKelas(r.skorCepat)}" title="Skor cepat berbasis bukti, bukan evaluasi resmi dan bukan peluang diterima">${r.skorCepat.toFixed(1)}</span><div class="muted" style="font-size:.72rem;margin-top:3px">${r.skorJumlahTerukur}/4 terukur</div>`;
    return `<tr class="scan-baru${sudah ? ' done' : ''}" ${atributBaris(r)}>
  <td class="ck"><input type="checkbox"${sudah ? ' checked' : ''}${ditutup ? ' disabled' : ''} data-scan-cb="${esc(scanId)}" aria-label="Tandai hasil scan ${esc(scanId)} sudah dilamar" title="${ditutup ? 'Halaman tidak ditemukan, dilewati' : 'Centang otomatis setelah lamaran terkirim'}"></td>
  <td class="job">
    <div class="t"><strong>${esc(r.company)}</strong><span class="badge badge-scan">BARU</span></div>
    <div class="role">${esc(r.role)}</div>
  </td>
  ${kolomTengah}
  <td>${skor}</td>
  <td><span class="st ${sudah ? 'st-done' : ''}">${ditutup ? 'Discarded' : sudah ? 'Applied' : 'Baru'}</span></td>
  <td>${cvDipakai}</td>
  <td class="berkas">${[
    r.cvScan ? chip(r.cvScan.href, 'CV PDF') : '',
    r.suratScan ? chip(r.suratScan.href, /\.pdf$/i.test(r.suratScan.name) ? 'Surat PDF' : 'Surat HTML') : '',
  ].filter(Boolean).join('') || '<span class="chip off">Belum ada</span>'}</td>
  <td><span class="legit neutral">Belum dinilai</span></td>
  <td class="aksi"><div class="aksi-baris">${r.url ? lnk(r.url, 'Buka lowongan') : dash}<button class="buka-detail" type="button" aria-label="Ringkasan lowongan">Detail</button></div><div class="hasil">${ditutup ? '✓ Dilewati: halaman tidak ditemukan' : sudah ? '✓ Dilamar otomatis' : ''}</div></td>
</tr>`;
  }
  const st = stMap[parseInt(r.num, 10)];
  const done = !!st && DONE.includes(st.toLowerCase());
  const locked = done && st.toLowerCase() !== 'applied';
  const missing = st === undefined;
  const berkas = r.cv || r.covers.length
    ? `${r.cv ? chip(encodeURI(r.cv.href), 'CV PDF') : ''}${r.covers.map((c) => chip(encodeURI(c.href), /\.pdf$/i.test(c.name) ? 'Surat PDF' : 'Surat HTML')).join('')}`
    : kosongTeks('Belum ada');
  return `<tr class="${done ? 'done' : ''}" ${atributBaris(r)}>
  <td class="ck"><input type="checkbox" ${done ? 'checked' : ''} ${locked || missing ? 'disabled' : ''} aria-label="Tandai lowongan ${esc(r.num)} sudah dilamar" title="${missing ? 'Tidak ada di tracker' : locked ? 'Status sudah naik tahap' : 'Tandai sudah dilamar'}"></td>
  <td class="job"><div class="t"><strong>${esc(r.company)}</strong><span class="no">#${esc(r.num)}</span></div><div class="role">${esc(r.role)}</div></td>
  ${kolomTengah}
  <td><span class="skor ${skorKelas(r.score)}" title="Skor laporan — bukan penilaian A–H resmi dan bukan peluang diterima">${r.score.toFixed(1)}</span></td>
  <td><span class="st ${done ? 'st-done' : ''}" data-s="${esc((st || '').toLowerCase())}">${esc(st || 'Belum tercatat')}</span></td>
  <td>${cvDipakai}</td>
  <td class="berkas">${berkas}</td>
  <td><span class="legit ${legitKelas(r.legit)}" title="${esc(r.legit)}">${esc(r.legit)}</span></td>
  <td class="aksi"><div class="aksi-baris"><button class="lamar" data-num="${esc(r.num)}">Lamar</button>${r.url ? lnk(r.url, 'Buka lowongan') : dash}<button class="buka-detail" type="button" aria-label="Ringkasan lowongan">Detail</button></div><div class="hasil"></div></td>
</tr>`;
}).join('\n');

const scanDetails = scanRows.map((r) => {
  const berkas = [
    r.cvScan ? lnk(encodeURI(r.cvScan.href), 'CV PDF') : '',
    r.suratScan ? lnk(encodeURI(r.suratScan.href), /\.pdf$/i.test(r.suratScan.name) ? 'Surat PDF' : 'Surat HTML') : '',
  ].filter(Boolean).join(' · ');
  const surat = r.letterText
    ? `<details open><summary>Surat lamaran otomatis (bisa disalin)</summary><div class="sec">
<button class="cp" onclick="navigator.clipboard.writeText(this.nextElementSibling.innerText);this.textContent='Tersalin'">Salin teks</button><pre class="letter">${esc(r.letterText)}</pre></div></details>`
    : '';
  const jd = r.jdText
    ? `<details><summary>Teks ringkas lowongan (dari iklan JobStreet)</summary><div class="sec"><pre class="letter">${esc(r.jdText)}</pre></div></details>`
    : '';
  const rincian = (r.skorRincian || []).map((x) => `<p>${esc(x.label)}: <strong>${x.terukur ? `${x.nilai}/${x.maks}` : 'tidak dihitung'}</strong> — ${esc(x.alasan)}${x.bukti && x.bukti.length ? ` <span class="muted">Bukti: ${esc(x.bukti.join(', '))}</span>` : ''}</p>`).join('\n');
  const skor = r.skorCepat == null ? '' : `<details open><summary>Skor cepat: ${r.skorCepat.toFixed(1)}/5 — bukti</summary><div class="sec">
<p class="meta">Dari cv.md, config/profile.yml, dan teks iklan. ${r.skorJumlahTerukur} dari 4 komponen terukur; komponen tanpa data tidak dihitung. Bukan skor evaluasi resmi dan bukan angka peluang diterima.</p>
${rincian}
</div></details>`;
  const poin = (label) => (r.skorRincian || []).find((x) => x.label === label);
  const cek = [
    (poin('Judul/peran')?.nilai > 0 ? '✓' : '—') + ' Judul lowongan cocok dengan peran di CV',
    (poin('Keterampilan')?.nilai > 0 ? '✓' : '—') + ' Kata keterampilan iklan terbukti ada di cv.md',
    (poin('Lokasi')?.terukur ? '✓' : '—') + ' Lokasi iklan bisa dinilai',
    (poin('Gaji')?.terukur ? '✓' : '—') + ' Gaji iklan bisa dinilai',
    (r.posted ? '✓' : '—') + ' Tanggal unggah diketahui',
    (r.cvScan && r.suratScan ? '✓' : '—') + ' CV dan surat sudah tersedia',
  ];
  const siap = `<details><summary>Kesiapan lamaran (bukan peluang diterima)</summary><div class="sec">${cek.map((s) => `<p>${esc(s)}</p>`).join('\n')}<p class="meta">Tidak ada data untuk menghitung probabilitas diterima. Tanda ✓ hanya berarti faktanya ada dan bisa dicek.</p></div></details>`;
  return `<article id="scan-${r.scanIdx}">
<div class="ah"><h3>${esc(r.company)} <span class="badge badge-scan">BARU</span></h3><span class="badge badge-neutral">Belum dinilai</span></div>
<p class="meta">${esc(r.role)}${r.location ? ' — ' + esc(r.location) : ''}${r.gajiTeks ? ' — ' + esc(r.gajiTeks) : ''}${r.posted ? ' — diunggah ' + esc(r.posted) : ''}</p>
<p class="links">${r.url ? lnk(r.url, 'Buka lowongan') : '<span class="muted">Link tidak ada</span>'}${berkas ? `<span class="muted">Berkas: ${berkas}</span>` : ''}${lnk('#atas', 'Kembali ke tabel', false)}</p>
${skor}${siap}${surat}${jd}
<p class="muted" style="font-size:.84rem">CV dan surat dibuat otomatis dari cv.md${r.jdText ? '; penyesuaian memakai teks ringkas yang tertulis di iklan' : '; tanpa teks iklan, penyesuaian hanya memakai judul dan nama perusahaan'}. Skor cepat berbasis bukti, bukan evaluasi resmi; status legitimasi tetap "Belum dinilai". Tidak ada lamaran yang dikirim otomatis.</p>
</article>`;
}).join('\n');

const details = scanDetails + rows.map((r) => {
  const headNoTitle = r.head.replace(/^#\s+.*$/m, '');
  const letterBlock = r.letterText
    ? `<details open><summary>Surat lamaran (dibuat dari CV lowongan ini, bisa disalin)</summary><div class="sec">
<p class="meta">Link lowongan: ${r.url ? lnk(r.url, r.url) : 'tidak ada'}</p>
<button class="cp" onclick="navigator.clipboard.writeText(this.nextElementSibling.innerText);this.textContent='Tersalin'">Salin teks</button><pre class="letter">${esc(r.letterText)}</pre></div></details>`
    : '';
  const secs = r.sections
    .filter((s) => !/^Machine Summary/i.test(s.title))
    .map((s) => {
      const isJd = /^Job Description/i.test(s.title);
      const open = /^Kesimpulan/i.test(s.title) ? ' open' : '';
      const label = isJd ? 'Teks lowongan asli (arsip)' : s.title;
      return `<details${open}><summary>${esc(label)}</summary><div class="sec">${md(s.body)}</div></details>`;
    })
    .join('\n');
  const berkasLain = r.others.length
    ? `<p class="meta">Berkas lain: ${r.others.map((o) => lnk(encodeURI(o.href), o.name)).join(', ')}</p>`
    : '';
  return `<article id="job-${esc(r.num)}">
<div class="ah"><h3>${esc(r.company)} <span class="no">#${esc(r.num)}</span></h3><span class="skor ${skorKelas(r.score)}">${r.score.toFixed(1)}/5</span></div>
<p class="meta">${esc(r.role)}</p>
<p class="links">${r.url ? lnk(r.url, 'Buka lowongan') : '<span class="muted">Link tidak ada</span>'}${lnk('../reports/' + encodeURI(r.report), 'File laporan')}${lnk('#atas', 'Kembali ke tabel', false)}</p>
${berkasLain}
<div class="hd">${md(headNoTitle)}</div>
${letterBlock}
${secs}
</article>`;
}).join('\n');

const profilSekarang = bacaProfilAktif(rootPengguna());

// Dua contoh CV disimpan di system layer (templates/), bukan data akun.
// Teksnya hanya dipakai sebagai kerangka: pengguna tetap wajib mengisi data
// sendiri lewat pratinjau dan konfirmasi yang sama seperti CV lainnya.
const CONTOH_CV = [
  { id: 'perkantoran', judul: 'Perkantoran', ringkas: 'Staf administrasi, data entry, layanan pelanggan.' },
  { id: 'teknik-mesin', judul: 'Teknik mesin', ringkas: 'Teknisi maintenance, operator produksi, perawatan mesin.' },
];
function bacaContohCv() {
  const keluar = {};
  for (const c of CONTOH_CV) {
    const f = path.join(CODE_ROOT, 'templates', 'contoh-cv', c.id + '.md');
    try { keluar[c.id] = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); }
    catch { keluar[c.id] = ''; }
  }
  return keluar;
}
const contohCvTeks = bacaContohCv();
const contohCvHtml = CONTOH_CV.filter((c) => contohCvTeks[c.id]).map((c) => `
  <div class="contoh-kartu">
    <strong>${esc(c.judul)}</strong>
    <span class="muted">${esc(c.ringkas)}</span>
    <div class="cv-aksi">
      <button type="button" data-contoh-lihat="${esc(c.id)}">Lihat contoh</button>
      <button type="button" data-contoh-pakai="${esc(c.id)}">Pakai sebagai kerangka</button>
    </div>
  </div>`).join('');

const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="__CSRF_TOKEN__">
<title>SiapLamar — Ringkasan Lamaran</title>
<script>
/* Setiap POST ke server ini membawa token CSRF milik sesi yang sedang masuk.
   Token disuntikkan saat halaman disajikan, bukan ditulis permanen ke berkas. */
(() => {
  const token = document.querySelector('meta[name="csrf-token"]').content || '';
  const asli = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const opsi = init || {};
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    const metode = String(opsi.method || (input && input.method) || 'GET').toUpperCase();
    if (metode !== 'GET' && metode !== 'HEAD' && !url.startsWith('/login')) {
      const h = new Headers(opsi.headers || (input && input.headers) || {});
      h.set('X-CSRF-Token', token);
      return asli(input, Object.assign({}, opsi, { headers: h })).then((r) => {
        if (r.status === 401) window.location.href = '/login';
        return r;
      });
    }
    return asli(input, opsi).then((r) => {
      if (r.status === 401) window.location.href = '/login';
      return r;
    });
  };
})();
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f8fafc;
    --surface: #ffffff;
    --surface-soft: #f1f5f9;
    --ink: #0f172a;
    --text-sec: #475569;
    --muted: #64748b;
    --line: #e2e8f0;
    --line-strong: #cbd5e1;

    --accent: #2563eb;
    --accent-hover: #1d4ed8;
    --accent-soft: #eff6ff;
    --accent-border: #bfdbfe;
    --accent-ink: #ffffff;

    --ok: #059669;
    --ok-soft: #ecfdf5;
    --ok-border: #a7f3d0;

    --warn: #b45309;
    --warn-soft: #fffbeb;
    --warn-border: #fde68a;

    --bad: #dc2626;
    --bad-soft: #fef2f2;
    --bad-border: #fecaca;

    --radius-lg: 16px;
    --radius-md: 10px;
    --radius-sm: 6px;
    --shadow-card: 0 4px 18px -4px rgba(15, 23, 42, 0.05), 0 1px 3px 0 rgba(15, 23, 42, 0.03);
    --shadow-btn: 0 2px 6px rgba(37, 99, 235, 0.2);
    --font: "Plus Jakarta Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font);
    font-size: 14.5px;
    line-height: 1.55;
  }
  main { max-width: 1360px; margin: 0 auto; padding: 28px 24px 64px; }

  h1 { font-size: 1.65rem; font-weight: 700; letter-spacing: -0.025em; margin: 0; color: var(--ink); }
  h2 { font-size: 1.12rem; font-weight: 700; letter-spacing: -0.015em; margin: 0; color: var(--ink); }
  h3 { font-size: 1.08rem; font-weight: 700; margin: 0; color: var(--ink); }
  a { color: var(--accent); text-decoration: none; font-weight: 500; }
  a:hover { color: var(--accent-hover); text-decoration: underline; }
  .muted { color: var(--muted); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Header Bar */
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 20px 26px;
    box-shadow: var(--shadow-card);
    margin-bottom: 20px;
  }
  .sub { margin: 4px 0 0; color: var(--muted); font-size: 0.88rem; }
  .akun { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .keluar-form { margin: 0; }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    border-radius: var(--radius-md);
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    font-size: 0.86rem;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.18s ease;
  }
  .btn:hover {
    background: var(--surface-soft);
    border-color: var(--accent);
    color: var(--accent);
    text-decoration: none;
    transform: translateY(-1px);
  }
  .btn.sm { padding: 5px 12px; font-size: 0.8rem; }

  /* Panel & Metrics */
  .panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    margin-top: 20px;
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 16px;
    background: transparent;
    border: 0;
    box-shadow: none;
    overflow: visible;
    margin-top: 0;
  }
  .stat {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 20px 22px;
    box-shadow: var(--shadow-card);
    transition: transform 0.18s ease, border-color 0.18s ease;
  }
  .stat:hover { transform: translateY(-2px); border-color: var(--line-strong); }
  .stat .k { display: block; font-size: 0.82rem; font-weight: 600; color: var(--muted); margin-bottom: 6px; }
  .stat .v { display: block; font-size: 1.9rem; font-weight: 700; letter-spacing: -0.03em; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .stat .v small { font-size: 0.82rem; font-weight: 500; color: var(--muted); margin-left: 6px; }
  .meter { height: 7px; border-radius: 999px; background: var(--surface-soft); margin-top: 12px; overflow: hidden; }
  .meter i { display: block; height: 100%; background: var(--ok); border-radius: 999px; transition: width 0.35s ease; }

  /* Scan Panel */
  .scan { padding: 22px 26px; }
  .scan-grid { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 20px; align-items: start; margin-top: 16px; }
  .scan-grid label.k { display: block; font-size: 0.8rem; font-weight: 700; color: var(--text-sec); margin-bottom: 6px; }
  .scan select, .scan input[type=number] {
    font: inherit;
    font-size: 0.88rem;
    padding: 8px 12px;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .scan select:focus, .scan input[type=number]:focus {
    border-color: var(--accent);
    background: var(--surface);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
    outline: none;
  }
  .prov-list {
    max-height: 150px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    background: var(--bg);
  }
  .prov-list .sw { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 0.86rem; }
  .prov-list .sw.semua { font-weight: 700; border-bottom: 1px solid var(--line); margin-bottom: 4px; padding-bottom: 6px; }
  .prov-list input[type=checkbox] { width: 15px; height: 15px; }

  /* Tingkat ketiga: kota/kabupaten di provinsi yang dicentang */
  .kota-panel { margin-top: 18px; }
  .kota-panel > label.k { display: block; font-size: 0.8rem; font-weight: 700; color: var(--text-sec); margin-bottom: 6px; }
  .target-cv { margin-top: 18px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgba(127,127,127,0.04); }
  .target-cv > label.k { display: block; font-size: 0.8rem; font-weight: 700; color: var(--text-sec); margin-bottom: 6px; }
  .target-cv .target-baris { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .target-cv .target-baris input { flex: 1 1 320px; min-width: 200px; }
  .target-cv .target-baris button { flex: 0 0 auto; }
  .kota-grup { border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--bg); padding: 8px 12px; margin-bottom: 8px; }
  .kota-judul { font-size: 0.82rem; font-weight: 700; color: var(--accent); margin-bottom: 6px; }
  .kota-grup .sw.sama { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; font-weight: 700; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px dashed var(--line); }
  .kota-grup .sw.sama input[type=checkbox] { width: 15px; height: 15px; }
  .kota-chip { display: flex; flex-wrap: wrap; gap: 4px 14px; max-height: 156px; overflow: auto; }
  .kota-chip .sw { display: flex; align-items: center; gap: 6px; font-size: 0.84rem; padding: 2px 0; }
  .kota-chip input[type=checkbox] { width: 14px; height: 14px; }
  .kota-lain { margin-top: 10px; max-width: 420px; }
  .skor-baris { display: flex; align-items: center; gap: 8px; }
  .skor-baris span { color: var(--muted); font-size: 0.85rem; }
  /* Kotak gaji memuat 8 digit (Rp 40.000.000), jadi lebih lebar dari kotak skor. */
  .scan-grid .skor-baris input { width: 148px; padding-right: 6px; }
  .scan-grid select { width: 100%; }
  .umur { display: flex; flex-wrap: wrap; gap: 6px; }
  .umur button {
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--ink);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .umur button:hover { border-color: var(--accent); color: var(--accent); }
  .umur button.aktif { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent); }
  /* ===== Panel CV saya (versi CV) ===== */
  .cv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
  .cv-kartu { border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); padding: 14px 16px; }
  .cv-lebar { grid-column: 1 / -1; }
  .cv-label { font-size: 0.76rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 8px; }
  .cv-nama { font-size: 1.02rem; font-weight: 700; color: var(--text); margin-bottom: 3px; }
  .cv-meta { font-size: 0.82rem; color: var(--muted); line-height: 1.55; }
  .cv-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .cv-aksi { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .cv-catatan { font-size: 0.78rem; color: var(--muted); margin: 6px 0 0; line-height: 1.5; }
  .contoh-cv { border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); padding: 14px 16px; }
  .contoh-cv > summary { cursor: pointer; font-weight: 700; font-size: 0.88rem; }
  .contoh-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  .contoh-kartu { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  .contoh-kartu strong { font-size: 0.9rem; }
  .contoh-kartu .muted { font-size: 0.8rem; }
  @media (max-width: 760px) { .contoh-grid { grid-template-columns: 1fr; } }
  .cv-kartu select, .cv-kartu input[type=text] { width: 100%; margin-bottom: 8px; }
  .cv-kartu textarea {
    width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.82rem; line-height: 1.55; padding: 10px 12px; border-radius: var(--radius-sm);
    border: 1px solid var(--line); background: var(--bg); color: var(--text); resize: vertical;
  }
  .cv-kartu textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12); outline: none; }
  .cv-isi {
    margin: 10px 0 0; padding: 12px; max-height: 340px; overflow: auto; white-space: pre-wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.78rem;
    line-height: 1.6; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-sm);
  }
  .cv-diff-box { margin-top: 16px; border: 1px solid var(--accent-border); border-radius: var(--radius-md); background: var(--accent-soft); padding: 14px 16px; }
  .cv-diff-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .cv-diff { max-height: 380px; overflow: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.78rem; line-height: 1.55; }
  .cv-diff .baris { display: flex; gap: 10px; padding: 1px 12px; white-space: pre-wrap; word-break: break-word; }
  .cv-diff .baris .no { flex: 0 0 34px; text-align: right; color: var(--muted); user-select: none; font-variant-numeric: tabular-nums; }
  .cv-diff .baris .tanda { flex: 0 0 12px; font-weight: 700; }
  .cv-diff .baris.tambah { background: var(--ok-soft); color: var(--ok); }
  .cv-diff .baris.hapus { background: var(--bad-soft); color: var(--bad); }
  .cv-diff .baris.sama { color: var(--text-sec); }
  .cv-peringatan { margin-top: 10px; padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--warn-border); background: var(--warn-soft); color: var(--warn); font-size: 0.82rem; line-height: 1.55; }
  .cv-peringatan ul { margin: 4px 0 0; padding-left: 18px; }
  .cv-konfirmasi { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; font-size: 0.83rem; line-height: 1.5; }
  .cv-konfirmasi input { width: 16px; height: 16px; margin-top: 1px; }
  .cv-pesan { margin-top: 10px; font-size: 0.84rem; font-weight: 600; }
  .gap-bucket { margin: 8px 0; padding: 9px 11px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg); font-size: 0.82rem; line-height: 1.55; }
  .gap-bucket b { display: block; margin-bottom: 3px; }
  .gap-bucket.ada b { color: var(--ok); }
  .gap-bucket.prosa b { color: var(--accent); }
  .gap-bucket.kurang b { color: var(--warn); }
  .gap-catatan { font-size: 0.76rem; color: var(--muted); line-height: 1.5; margin-top: 8px; }
  .cek-entri { padding: 3px 0; border-bottom: 1px solid var(--line); }
  .cek-entri:last-child { border-bottom: 0; }
  @media (max-width: 760px) { .cv-grid { grid-template-columns: 1fr; } }

  .scan-aksi { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
  button.scan-btn {
    font: inherit;
    font-weight: 600;
    font-size: 0.88rem;
    padding: 9px 18px;
    border-radius: var(--radius-md);
    border: 0;
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: var(--shadow-btn);
    cursor: pointer;
    transition: all 0.18s ease;
  }
  button.scan-btn:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); }
  button.scan-btn:disabled { opacity: 0.6; cursor: wait; }
  .scan-catatan { font-size: 0.8rem; color: var(--muted); }
  .scan-status { margin-top: 12px; font-size: 0.86rem; font-weight: 600; color: var(--accent); }
  .scan-hasil { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
  .scan-hasil ul { margin: 6px 0 0; padding-left: 18px; }
  .scan-hasil li { margin: 4px 0; font-size: 0.85rem; }
  .preset-panel { margin-top: 18px; border: 1px solid var(--line); border-radius: var(--radius-md); padding: 14px 16px; background: rgba(127,127,127,0.04); }
  .preset-judul { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
  .preset-judul .k { display: block; font-size: 0.82rem; font-weight: 700; color: var(--text-sec); }
  .preset-baris { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .preset-baris input { flex: 1 1 220px; min-width: 160px; }
  .preset-baris button { flex: 0 0 auto; }
  .preset-status { font-size: 0.8rem; font-weight: 600; color: var(--accent); }
  .preset-daftar { margin-top: 10px; display: grid; gap: 6px; }
  .preset-item { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm, 6px); }
  .preset-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .preset-info strong { font-size: 0.86rem; }
  .preset-info span { font-size: 0.76rem; line-height: 1.4; overflow-wrap: anywhere; }
  .preset-aksi { display: flex; gap: 6px; flex: 0 0 auto; }
  .preset-aksi button { font: inherit; font-size: 0.78rem; padding: 5px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm, 6px); background: transparent; color: var(--text); cursor: pointer; }
  .preset-aksi button:hover { border-color: var(--accent); color: var(--accent); }
  .preset-aksi button[data-aksi="hapus"]:hover { border-color: var(--warn); color: var(--warn); }
  @media (max-width: 760px) { .scan-grid { grid-template-columns: 1fr; } .preset-item { flex-direction: column; align-items: flex-start; } }
  .profil-panel { padding: 20px 26px; }
  .profil-daftar { margin-top: 12px; display: grid; gap: 6px; }
  .profil-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 11px; border: 1px solid var(--line); border-radius: var(--radius-md); }
  .profil-item.aktif { border-color: var(--accent); background: rgba(127,127,127,0.05); }
  .profil-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .profil-info strong { font-size: .9rem; }
  .profil-info small { font-size: .74rem; color: var(--muted); overflow-wrap: anywhere; }
  .profil-item button { font: inherit; font-size: .78rem; padding: 5px 11px; border: 1px solid var(--line); border-radius: var(--radius-sm, 6px); background: transparent; color: var(--text); cursor: pointer; flex: 0 0 auto; }
  .profil-item button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .profil-item button:disabled { cursor: default; opacity: .75; }
  .profil-buat { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .profil-buat input { flex: 1 1 240px; min-width: 160px; }
  .profil-status { font-size: .8rem; font-weight: 600; color: var(--accent); }
  @media (max-width: 760px) { .profil-panel { padding: 16px; } .profil-item { flex-direction: column; align-items: flex-start; } }

  /* Batch Panel */
  .otomatis { padding: 22px 26px; }
  .p-head { display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap; }
  .p-head p { margin: 4px 0 0; font-size: 0.88rem; max-width: 66ch; }
  .p-ctl { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  button.batch {
    padding: 10px 18px;
    font: inherit;
    font-weight: 600;
    font-size: 0.88rem;
    border-radius: var(--radius-md);
    border: 0;
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: var(--shadow-btn);
    cursor: pointer;
    transition: all 0.18s ease;
  }
  button.batch:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); }
  button.batch:disabled { opacity: 0.6; cursor: not-allowed; }
  .batch-alert {
    display: none;
    margin-top: 14px;
    padding: 11px 14px;
    border-radius: var(--radius-md);
    border: 1px solid var(--warn-border);
    background: var(--warn-soft);
    color: var(--warn);
    font-weight: 600;
    font-size: 0.88rem;
  }
  .batch-alert.tampil { display: block; }
  .batch-alert.dokumen { border-color: var(--bad-border); background: var(--bad-soft); color: var(--bad); }
  pre.batchlog { margin: 14px 0 0; max-height: 220px; overflow: auto; }
  .sw { display: inline-flex; align-items: center; gap: 8px; font-size: 0.86rem; font-weight: 500; cursor: pointer; }
  input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--accent); cursor: pointer; border-radius: 4px; }
  input[type=checkbox]:disabled { cursor: not-allowed; }

  /* Table */
  .tbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    padding: 18px 24px;
    border-bottom: 1px solid var(--line);
  }
  .tools { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  input[type=search] {
    width: 250px;
    max-width: 100%;
    padding: 8px 13px;
    font: inherit;
    font-size: 0.88rem;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    transition: border-color 0.18s, box-shadow 0.18s;
  }
  input[type=search]:focus {
    border-color: var(--accent);
    background: var(--surface);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
    outline: none;
  }
  input[type=search]::placeholder { color: var(--muted); }
  .tools select {
    padding: 8px 10px;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .wrap { overflow: auto; max-height: 70vh; }
  table.main { width: 100%; min-width: 1600px; border-collapse: separate; border-spacing: 0; }
  table.main th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface-soft);
    text-align: left;
    font-size: 0.76rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  table.main td {
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
    font-size: 0.88rem;
    background: var(--surface);
    transition: background 0.14s ease;
  }
  table.main tbody tr:last-child td { border-bottom: 0; }
  table.main tbody tr:hover td { background: var(--surface-soft); }
  tr.done td { background: #f3fcf7; }
  tr.done td:first-child { box-shadow: inset 3px 0 0 var(--ok); }
  tr.sembunyi { display: none; }

  /* ===== Fase 2: filter, paginasi, drawer ===== */
  .tools.f2 { gap: 10px; }
  .tools input.angka {
    width: 150px;
    padding: 8px 10px;
    font: inherit;
    font-size: 0.85rem;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .tools input.angka:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12); outline: none; }
  .f2-petunjuk {
    margin: 0;
    padding: 10px 24px;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    font-size: 0.78rem;
    line-height: 1.55;
    color: var(--muted);
  }
  .f2-petunjuk b { color: var(--ink); }
  .f2-petunjuk code { background: var(--surface-soft); padding: 1px 5px; border-radius: 4px; }
  .umur-badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    background: var(--ok-soft);
    color: var(--ok);
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .umur-badge.tua { background: var(--warn-soft); color: var(--warn); }
  button.buka-detail {
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--accent);
    cursor: pointer;
  }
  button.buka-detail:hover { border-color: var(--accent); background: var(--accent-soft); }
  .halaman {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 24px;
    border-top: 1px solid var(--line);
    font-size: 0.84rem;
  }
  .halaman select { font: inherit; font-size: 0.84rem; padding: 4px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .halaman button:disabled { opacity: 0.5; cursor: not-allowed; }
  .drawer {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(15, 23, 42, 0.45);
    display: flex;
    justify-content: flex-end;
  }
  .drawer[hidden] { display: none; }
  .drawer-panel {
    width: min(440px, 100%);
    height: 100%;
    overflow: auto;
    background: var(--surface);
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.18);
    padding: 20px 22px;
  }
  .drawer-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 12px;
    margin-bottom: 14px;
  }
  .drawer-head button { font: inherit; font-size: 1.4rem; line-height: 1; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
  .drawer h3 { margin: 0 0 14px; font-size: 1rem; }
  .dr {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 10px;
    padding: 9px 0;
    border-bottom: 1px solid var(--line);
    font-size: 0.84rem;
  }
  .dr span { color: var(--muted); }
  .dr strong { font-weight: 600; word-break: break-word; }
  .dr-link { margin: 14px 0 0; font-size: 0.84rem; }
  .dr-link a { color: var(--accent); font-weight: 600; }
  .dr-catatan { margin-top: 16px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg); color: var(--muted); font-size: 0.76rem; line-height: 1.55; }

  td.ck { text-align: center; width: 58px; }
  td.job { min-width: 240px; }
  td.job .t { display: flex; align-items: center; gap: 8px; }
  .no { color: var(--muted); font-size: 0.78rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .role { color: var(--text-sec); font-size: 0.85rem; font-weight: 500; margin-top: 2px; }
  .meta-sub { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 5px; font-size: 0.76rem; color: var(--muted); }
  td.berkas { white-space: nowrap; }
  .kosong { padding: 36px 20px; text-align: center; color: var(--muted); }
  .kosong[hidden] { display: none; }
  .foot {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin: 0;
    padding: 14px 24px;
    border-top: 1px solid var(--line);
    background: var(--bg);
    font-size: 0.82rem;
    color: var(--muted);
  }

  /* Badges & Chips */
  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 700; }
  .badge-scan { background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent-border); }
  .badge-neutral { background: var(--surface-soft); color: var(--muted); border: 1px solid var(--line); }
  .badge-warning { background: #fff7ed; color: #b45309; border: 1px solid #fed7aa; }

  /* Panduan 3 langkah untuk pengguna baru */
  .onboarding {
    display: flex; align-items: stretch; gap: 10px; flex-wrap: wrap;
    padding: 14px 18px; margin: 0 0 16px;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-card);
  }
  .onboarding-step {
    display: flex; align-items: center; gap: 10px;
    flex: 1 1 220px; min-width: 210px;
    padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-md);
    background: var(--surface-soft); font-size: 0.86rem;
  }
  .onboarding-step b { display: block; color: var(--ink); }
  .onboarding-step span { display: block; color: var(--muted); font-size: 0.8rem; margin-top: 2px; }
  .onboarding-step .n {
    flex: 0 0 28px; height: 28px; display: grid; place-items: center;
    border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 800;
  }
  .onboarding-step.selesai { border-color: var(--ok-border); background: var(--ok-soft); }
  .onboarding-step.selesai .n { background: var(--ok); color: #fff; }

  /* Alat lanjutan: tersembunyi sampai pengguna membukanya */
  .lanjutan { border: 1px dashed var(--line); border-radius: var(--radius-md); padding: 6px 10px; margin: 8px 0; }
  .lanjutan > summary { cursor: pointer; font-size: 0.82rem; font-weight: 700; color: var(--muted); user-select: none; }
  .lanjutan > summary:hover { color: var(--accent); }
  .lanjutan[open] > summary { margin-bottom: 8px; }
  .filter-lanjutan { flex: 1 1 100%; }

  .skor { display: inline-block; min-width: 2.8em; text-align: center; font-weight: 700; font-size: 0.84rem; padding: 3px 9px; border-radius: var(--radius-sm); font-variant-numeric: tabular-nums; }
  .skor.tinggi { background: var(--ok-soft); color: var(--ok); border: 1px solid var(--ok-border); }
  .skor.sedang { background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent-border); }
  .skor.rendah { background: var(--warn-soft); color: var(--warn); border: 1px solid var(--warn-border); }

  .st { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 0.76rem; font-weight: 700; background: var(--surface-soft); color: var(--muted); border: 1px solid var(--line); }
  .st.st-done, tr.done .st { background: var(--ok-soft); color: var(--ok); border-color: var(--ok-border); }
  tr .st[data-s="interview"], tr .st[data-s="assessment"], tr .st[data-s="responded"] { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-border); }
  tr .st[data-s="offer"], tr .st[data-s="hired"] { background: var(--ok-soft); color: var(--ok); border-color: var(--ok-border); }
  tr .st[data-s="rejected"], tr .st[data-s="discarded"] { background: var(--bad-soft); color: var(--bad); border-color: var(--bad-border); }

  .legit { display: inline-block; max-width: 155px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; font-size: 0.76rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; background: var(--surface-soft); color: var(--muted); border: 1px solid var(--line); }
  .legit.ok { background: var(--ok-soft); color: var(--ok); border-color: var(--ok-border); }
  .legit.warn { background: var(--warn-soft); color: var(--warn); border-color: var(--warn-border); }
  .legit.bad { background: var(--bad-soft); color: var(--bad); border-color: var(--bad-border); }

  .chip {
    display: inline-block;
    padding: 3px 10px;
    margin: 2px 6px 2px 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
    transition: all 0.14s ease;
  }
  a.chip:hover { border-color: var(--accent); background: var(--accent-soft); text-decoration: none; }
  .chip.off { color: var(--muted); border-style: dashed; background: var(--bg); font-weight: 500; }

  /* Row Actions */
  td.aksi { min-width: 215px; }
  .aksi-baris { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 0.84rem; }
  button.lamar {
    padding: 6px 14px;
    font: inherit;
    font-size: 0.82rem;
    font-weight: 700;
    border-radius: var(--radius-sm);
    border: 1px solid var(--accent-border);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  button.lamar:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button.lamar:disabled { opacity: 0.6; cursor: wait; }
  .hasil { margin-top: 5px; max-width: 220px; font-size: 0.75rem; color: var(--muted); }
  .hasil:empty { display: none; }

  /* Detail Articles */
  .detail-list { margin-top: 36px; }
  .detail-list > .note { margin: 6px 0 0; color: var(--muted); font-size: 0.88rem; max-width: 82ch; }
  article {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 22px 26px;
    margin-top: 16px;
    box-shadow: var(--shadow-card);
    scroll-margin-top: 18px;
  }
  article:target { border-color: var(--accent); box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12); }
  .ah { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .ah h3 { display: flex; align-items: center; gap: 8px; }
  .meta { color: var(--muted); margin: 4px 0 12px; font-size: 0.88rem; }
  .links { display: flex; gap: 16px; flex-wrap: wrap; margin: 0 0 14px; font-size: 0.86rem; }
  details { border: 1px solid var(--line); border-radius: var(--radius-md); margin: 10px 0; overflow: hidden; }
  summary { cursor: pointer; padding: 11px 16px; font-weight: 600; font-size: 0.9rem; background: var(--bg); color: var(--ink); user-select: none; }
  summary:hover { background: var(--surface-soft); }
  details[open] > summary { border-bottom: 1px solid var(--line); }
  .sec { padding: 10px 18px 16px; max-width: 100%; overflow-x: auto; background: var(--surface); }
  .sec p, .sec li { max-width: 82ch; }
  .sec h3, .sec h4, .sec h5 { margin: 14px 0 4px; font-size: 0.96rem; }
  pre { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); padding: 14px 16px; border-radius: var(--radius-md); font-size: 0.84rem; }
  pre.letter { font-family: Georgia, "Times New Roman", serif; font-size: 0.96rem; line-height: 1.65; max-width: 82ch; background: #fcfcfd; }
  button.cp {
    margin: 8px 0 4px;
    padding: 5px 12px;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink);
  }
  button.cp:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  code { background: var(--surface-soft); padding: 2px 6px; border-radius: 4px; font-size: 0.86em; }
  blockquote { border-left: 3px solid var(--accent-border); margin: 10px 0; padding: 4px 14px; color: var(--text-sec); background: var(--bg); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
  li { margin: 3px 0; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
  table.md { border-collapse: collapse; width: 100%; margin: 10px 0; }
  table.md th, table.md td { border: 1px solid var(--line); padding: 8px 12px; font-size: 0.86rem; text-align: left; vertical-align: top; }
  table.md th { background: var(--surface-soft); }

  @media (max-width: 760px) {
    main { padding: 16px 12px 48px; }
    .top { flex-direction: column; align-items: stretch; }
    article { padding: 18px; }
  }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
</style>
</head>
<body>
<main>
<header class="top" id="atas">
  <div>
    <h1>SiapLamar</h1>
    <p class="sub">Ringkasan lamaran skor minimal ${MIN.toFixed(1)} (nomor terbaru di atas) · Dibuat ${esc(new Date().toLocaleString('id-ID'))}.</p>
  </div>
  <div class="akun">
    <span class="badge badge-neutral" title="Akun yang sedang masuk">__NAMA_PENGGUNA__</span>
    <a class="btn" href="/kuota" title="Sisa kredit dan riwayat pemakaian">🎟️ Kuota: __SISA_KUOTA__</a>
    <a class="btn" href="?paksa=1" title="Bangun ulang ringkasan dari data terbaru">⚡ Segarkan Data</a>
    <form method="post" action="/logout" class="keluar-form">
      <input type="hidden" name="_csrf" value="__CSRF_TOKEN__">
      <button class="btn" type="submit" title="Keluar dari akun ini">Keluar</button>
    </form>
  </div>
</header>

<section class="onboarding" aria-label="Panduan mulai">
  <div class="onboarding-step" id="langkahCv"><span class="n">1</span><div><b>Isi CV Anda</b><span>Unggah PDF CV atau tempel teks, lalu pratinjau dan konfirmasi.</span></div></div>
  <div class="onboarding-step ${scanRows.length ? 'selesai' : ''}"><span class="n">2</span><div><b>Pilih wilayah &amp; scan</b><span>Atur provinsi/kota, umur, gaji, lalu jalankan scan.</span></div></div>
  <div class="onboarding-step ${appliedCount ? 'selesai' : ''}"><span class="n">3</span><div><b>Buka antrean &amp; lamar</b><span>__MODE_KIRIM_PENDEK__</span></div></div>
</section>

<section class="stats" aria-label="Angka ringkas">
  <div class="stat"><span class="k">Total Lowongan Terdaftar</span><span class="v">${semuaBaris.length}</span></div>
  <div class="stat"><span class="k">Sudah Dilamar</span><span class="v"><span id="n">${appliedCount}</span><small>dari ${rows.length} dinilai</small></span><div class="meter"><i id="progres" style="width:${rows.length ? Math.round((appliedCount * 100) / rows.length) : 0}%"></i></div></div>
  <div class="stat"><span class="k">Belum Dilamar</span><span class="v" id="belum">${rows.length - appliedCount}</span></div>
  <div class="stat"><span class="k">Hasil Scan Baru</span><span class="v">${scanRows.length}</span></div>
  <div class="stat" title="__MODE_KIRIM_TOOLTIP__"><span class="k">Siap Diproses</span><span class="v" style="color:var(--accent)">${siapHitung}</span></div>
</section>

<section class="panel profil-panel" aria-label="Profil lokal">
  <div class="p-head">
    <div>
      <h2>👤 Profil Lokal</h2>
      <p class="muted" style="margin:2px 0 0;font-size:.88rem">Satu server, satu profil aktif. Memindah profil mengganti CV, tracker, laporan, hasil scan, dan preset yang dipakai halaman ini.</p>
    </div>
    <div class="p-ctl"><span id="profilAktif" class="badge badge-neutral">${profilSekarang.ok ? esc(profilSekarang.profil.nama) : 'Profil tidak diketahui'}</span></div>
  </div>
  <details class="lanjutan">
    <summary>Buka pengaturan profil lokal</summary>
    <div id="profilDaftar" class="profil-daftar"><span class="muted" style="font-size:.85rem">Memuat daftar profil…</span></div>
    <div class="profil-buat">
      <input type="text" id="profilNamaBaru" placeholder="Nama profil baru" aria-label="Nama profil baru">
      <button id="profilBuat" class="btn sm" type="button">Buat profil kosong</button>
      <span id="profilStatus" class="profil-status" role="status" aria-live="polite"></span>
    </div>
    <p class="scan-catatan" style="margin:8px 0 0">Profil baru dimulai kosong: tidak ada CV, gaji, lokasi, pengalaman, atau skor yang disalin dari profil lain. Profil tidak dihapus otomatis supaya data tidak hilang.</p>
  </details>
</section>

<section class="panel cv" aria-label="CV saya">
  <div class="p-head">
    <div>
      <h2>🗂️ CV Saya</h2>
      <p class="muted" style="margin:2px 0 0;font-size:.88rem">Satu CV aktif dipakai semua alat. Mengganti CV selalu lewat pratinjau perbedaan dan arsip otomatis — versi lama tidak pernah dihapus.</p>
    </div>
    <div class="p-ctl"><span id="cvStatus" class="badge badge-neutral">memuat…</span></div>
  </div>

  <div class="cv-grid">
    <div class="cv-kartu">
      <div class="cv-label">CV aktif</div>
      <div id="cvAktifNama" class="cv-nama">—</div>
      <div id="cvAktifMeta" class="cv-meta">Memuat…</div>
      <div id="cvAktifRingkas" class="cv-chips"></div>
      <div class="cv-aksi">
        <button id="cvLihat" class="btn sm" type="button">Lihat isi CV</button>
        <button id="cvTutupLihat" class="btn sm" type="button" hidden>Tutup</button>
      </div>
      <pre id="cvIsi" class="cv-isi" hidden></pre>
    </div>

    <div class="cv-kartu">
      <div class="cv-label">Ganti ke versi tersimpan</div>
      <select id="cvPilihArsip" aria-label="Pilih versi CV">
        <option value="">— belum ada versi tersimpan —</option>
      </select>
      <div id="cvArsipMeta" class="cv-meta">Versi pertama dibuat otomatis saat CV diganti.</div>
      <div class="cv-aksi">
        <button id="cvPratinjauArsip" class="btn sm" type="button">Pratinjau perbedaan</button>
      </div>
      <p class="cv-catatan">Rollback memakai jalur yang sama: pratinjau dulu, lalu konfirmasi.</p>
    </div>

    <div class="cv-kartu cv-lebar">
      <div class="cv-label">Unggah CV PDF</div>
      <input id="cvPdfNama" type="text" placeholder="Nama versi, misalnya: CV PDF 2026" maxlength="80" aria-label="Nama versi CV dari PDF">
      <input id="cvPdfFile" type="file" accept=".pdf,application/pdf" aria-label="Berkas CV PDF">
      <div class="cv-aksi">
        <button id="cvPdfProses" class="btn sm" type="button">Baca PDF &amp; siapkan pratinjau</button>
        <span id="cvPdfPesan" class="cv-catatan" role="status" aria-live="polite"></span>
      </div>
      <p class="cv-catatan">Teks PDF dibaca di komputer operator dan dirapikan mengikuti format CV aplikasi. File PDF tidak disimpan; hasil tetap harus Anda lihat dan setujui lewat pratinjau. PDF hasil scan tanpa teks akan ditolak.</p>
    </div>

    <div class="cv-kartu cv-lebar">
      <div class="cv-label">Tempel CV baru</div>
      <input id="cvNamaBaru" type="text" placeholder="Nama versi, misalnya: Admin Staff 2026" maxlength="80" aria-label="Nama versi CV">
      <textarea id="cvTeksBaru" rows="10" placeholder="Tempel isi CV di sini (teks atau markdown). Tidak ada yang disimpan sebelum Anda melihat perbedaannya dan mencentang konfirmasi." aria-label="Isi CV baru"></textarea>
      <div class="cv-aksi">
        <button id="cvPratinjauTempel" class="btn sm" type="button">Pratinjau perbedaan</button>
        <span class="cv-catatan">Hasil unggah PDF muncul di kotak ini. CV lama tetap tersimpan sebagai versi.</span>
      </div>
    </div>

    <details class="contoh-cv cv-lebar">
      <summary>Belum punya CV? Lihat 2 contoh (perkantoran &amp; teknik mesin)</summary>
      <p class="cv-catatan">Kedua contoh memakai data fiktif dan berlabel CONTOH. Tombol “Pakai sebagai kerangka” hanya mengisi kotak CV — Anda tetap harus mengganti data, melihat pratinjau, lalu mencentang konfirmasi.</p>
      <div class="contoh-grid">${contohCvHtml}</div>
      <pre id="contohCvIsi" class="cv-isi" hidden></pre>
      <p id="contohCvPesan" class="cv-catatan" role="status" aria-live="polite"></p>
    </details>
  </div>

  <details class="lanjutan cv-lanjutan">
    <summary>Alat CV lanjutan — tambah entri, cek struktur, skill gap</summary>
  <div class="cv-grid" style="margin-top:16px">
    <div class="cv-kartu cv-lebar">
      <div class="cv-label">Tambah entri pengalaman (kata-kata Anda sendiri)</div>
      <div class="cv-grid" style="margin-top:0">
        <div>
          <label class="cv-label" for="entBagian">Bagian CV</label>
          <select id="entBagian" aria-label="Bagian CV tujuan"></select>
          <label class="cv-label" for="entPerusahaan">Perusahaan / instansi</label>
          <input id="entPerusahaan" type="text" maxlength="120" aria-label="Perusahaan atau instansi">
          <label class="cv-label" for="entLokasi">Kota / lokasi</label>
          <input id="entLokasi" type="text" maxlength="100" aria-label="Kota atau lokasi">
        </div>
        <div>
          <label class="cv-label" for="entJabatan">Jabatan / peran</label>
          <input id="entJabatan" type="text" maxlength="140" aria-label="Jabatan atau peran">
          <label class="cv-label" for="entTanggal">Rentang tanggal</label>
          <input id="entTanggal" type="text" maxlength="80" placeholder="2024 – 2025" aria-label="Rentang tanggal">
          <p class="cv-catatan">Judul dan tanggal harus sesuai pola agar alat CV bisa membacanya. Tidak ada yang dikarang otomatis.</p>
        </div>
      </div>
      <label class="cv-label" for="entPoin">Poin pengalaman (satu per baris)</label>
      <textarea id="entPoin" rows="5" placeholder="Menginput data harian&#10;Menyusun laporan mingguan" aria-label="Poin pengalaman"></textarea>
      <div class="cv-aksi">
        <button id="entPratinjau" class="btn sm" type="button">Pratinjau entri</button>
        <span class="cv-catatan">Entri dicek duplikatnya dulu. Penulisan hanya terjadi setelah pratinjau dan konfirmasi.</span>
      </div>
    </div>

    <div class="cv-kartu">
      <div class="cv-label">Pemeriksaan struktur CV</div>
      <p class="cv-catatan" style="margin-top:0">Memakai parser yang sama dengan alat career-ops: bagian pengalaman, jabatan, dan tanggal yang bisa dibaca.</p>
      <div class="cv-aksi"><button id="cekCvJalankan" class="btn sm" type="button">Jalankan pemeriksaan</button></div>
      <div id="cekCvHasil" class="cv-meta" style="margin-top:10px" hidden></div>
    </div>

    <div class="cv-kartu">
      <div class="cv-label">Skill gap dari lowongan</div>
      <p class="cv-catatan" style="margin-top:0">Tempel teks lowongan. Kata dibagi jadi tiga keranjang. Tidak ada kata yang otomatis masuk ke CV.</p>
      <textarea id="gapJd" rows="6" placeholder="Tempel deskripsi lowongan di sini…" aria-label="Teks lowongan"></textarea>
      <div class="cv-aksi"><button id="gapJalankan" class="btn sm" type="button">Hitung skill gap</button></div>
      <div id="gapHasil" class="cv-meta" style="margin-top:10px" hidden></div>
    </div>
  </div>
  </details>

  <div id="cvDiffBox" class="cv-diff-box" hidden>
    <div class="cv-diff-head">
      <strong id="cvDiffJudul">Perbedaan</strong>
      <span id="cvDiffStat" class="muted"></span>
    </div>
    <div id="cvDiff" class="cv-diff"></div>
    <div id="cvPeringatan" class="cv-peringatan" hidden></div>
    <label class="cv-konfirmasi" for="cvSetuju"><input type="checkbox" id="cvSetuju"> <span id="cvSetujuTeks">Saya sudah memeriksa perbedaan di atas dan setuju menjadikannya CV aktif. Versi sekarang akan diarsipkan otomatis.</span></label>
    <div class="cv-aksi">
      <button id="cvSimpan" class="btn sm" type="button" disabled>Jadikan CV aktif</button>
      <button id="cvBatal" class="btn sm" type="button">Batal</button>
    </div>
    <div id="cvPesan" class="cv-pesan" role="status" aria-live="polite"></div>
  </div>
</section>

<section class="panel scan" aria-label="Scan lowongan terbaru">
  <div class="p-head">
    <div>
      <h2>🔍 Scan Lowongan Terbaru</h2>
      <p class="muted" style="margin:2px 0 0;font-size:.88rem">Pilih wilayah, rentang gaji, dan umur lowongan, lalu klik scan. Tidak perlu membuka OpenCode.</p>
    </div>
  </div>
  <div class="scan-grid">
    <div>
      <label class="k" for="pulau">Pulau / wilayah</label>
      <select id="pulau"><option value="">— pilih pulau —</option>${WILAYAH.map((w) => `<option value="${esc(w.pulau)}">${esc(w.pulau)}</option>`).join('')}</select>
      <div class="prov-list" id="provinsi" style="margin-top:8px"><span class="muted" style="font-size:.85rem">Pilih pulau dulu, lalu centang provinsi.</span></div>
    </div>
    <div>
      <label class="k">Rentang gaji per bulan (Rp)</label>
      <div class="skor-baris">
        <input type="number" id="gajiMin" min="0" max="100000000" step="100000" value="3500000" aria-label="Gaji minimum per bulan">
        <span>s/d</span>
        <input type="number" id="gajiMax" min="0" max="100000000" step="100000" value="40000000" aria-label="Gaji maksimum per bulan">
      </div>
      <p class="scan-catatan" style="margin:6px 0 0">Hanya gaji yang memang tertulis di iklan yang dipakai. Lowongan tanpa gaji tetap tampil dan ditandai.</p>
      <label class="k" style="margin-top:14px">Umur lowongan (tanggal unggah)</label>
      <div class="umur" id="umur">
        <button type="button" data-umur="today">Hari ini</button>
        <button type="button" data-umur="3">3 hari</button>
        <button type="button" data-umur="7" class="aktif">7 hari</button>
        <button type="button" data-umur="14">14 hari</button>
      </div>
    </div>
    <div>
      <label class="k">Ringkasan pilihan</label>
      <div id="ringkasanPilihan" class="muted" style="font-size:.86rem;line-height:1.6">Belum ada provinsi dipilih.</div>
    </div>
  </div>

  <div class="kota-panel">
    <label class="k">Wilayah di provinsi yang dipilih</label>
    <div id="kotaList"><span class="muted" style="font-size:.85rem">Pilih provinsi dulu. Lalu pilih “Seluruh wilayah” atau centang kota/kabupaten tertentu. Contoh: Riau → Pekanbaru.</span></div>
    <p class="scan-catatan" style="margin:8px 0 0">“Seluruh wilayah” = semua kota di provinsi itu discan. Kalau Anda mencentang kota tertentu, hanya kota itu yang dicari. Menghapus semua centang kota otomatis kembali ke seluruh wilayah.</p>
    <div class="kota-lain">
      <label class="k" for="kotaLain">Wilayah lain di luar daftar (opsional, pisahkan koma)</label>
      <input type="text" id="kotaLain" placeholder="Contoh: Siak, Bangkinang, Rengat" aria-label="Wilayah lain di luar daftar">
    </div>
  </div>

  <div class="target-cv" aria-label="Target dari CV">
    <label class="k" for="kataKunci">Kata kunci jabatan (diisi dari CV, bisa diubah)</label>
    <div class="target-baris">
      <input type="text" id="kataKunci" placeholder="Contoh: Staf Administrasi, Data Entry" aria-label="Kata kunci jabatan">
      <button id="targetSimpan" class="btn sm" type="button">Simpan target</button>
    </div>
    <p id="targetSumber" class="scan-catatan" style="margin:8px 0 0" role="status" aria-live="polite">Membaca CV yang sedang aktif…</p>
  </div>

  <div class="scan-aksi">
    <button id="scanBaru" class="scan-btn" type="button">Scan lowongan terbaru</button>
    <span class="scan-catatan">Lowongan bertanggal &gt;14 hari dibuang; yang tanpa tanggal tetap tampil dan ditandai.</span>
  </div>

  <div class="preset-panel" aria-label="Preset pencarian">
    <div class="preset-judul">
      <label class="k" for="namaPreset">Preset pencarian</label>
      <span class="scan-catatan">Simpan pilihan wilayah, gaji, dan umur supaya bisa dipakai lagi. Tidak menjalankan scan dan tidak mengirim lamaran.</span>
    </div>
    <div class="preset-baris">
      <input type="text" id="namaPreset" placeholder="Nama preset, misal: Riau 7 hari" aria-label="Nama preset">
      <button id="presetSimpan" class="btn sm" type="button">Simpan preset ini</button>
      <span id="presetStatus" class="preset-status" role="status" aria-live="polite"></span>
    </div>
    <div id="presetDaftar" class="preset-daftar"><span class="muted" style="font-size:.85rem">Belum ada preset tersimpan.</span></div>
  </div>

  <div id="scanStatus" class="scan-status" role="status" aria-live="polite"></div>
  <div id="scanHasil" class="scan-hasil" hidden></div>
</section>

<section class="panel otomatis" aria-label="Lamar otomatis">
  <div class="p-head">
    <div>
      <h2>🚀 Otomatisasi Lamaran</h2>
      <p id="batchStatus" class="muted">__MODE_KIRIM_PANJANG__</p>
    </div>
    <div class="p-ctl">
      <details class="lanjutan"><summary>Suara (opsional)</summary>
        <label class="sw" title="Bunyi alarm saat otomatisasi berhenti karena butuh jawaban atau dokumen tidak cocok"><input type="checkbox" id="suaraNotifikasi" checked> Audio Status</label>
        <button id="ujiSuara" class="btn sm" type="button">Uji suara</button>
      </details>
      <button id="lamarSemua" class="batch">Lamar Semua Siap (${siapHitung})</button>
    </div>
  </div>
  <div id="batchAlert" class="batch-alert" role="status" aria-live="assertive"></div>
  <pre id="batchLog" class="batchlog" hidden></pre>
</section>

<section class="panel" aria-label="Daftar lowongan">
  <div class="tbar">
    <h2>📋 Daftar Lowongan</h2>
    <div class="tools f2">
      <input type="search" id="cari" placeholder="Cari perusahaan, posisi, wilayah..." aria-label="Cari lowongan">
      <select id="filterProvinsi" aria-label="Filter provinsi"><option value="">Semua provinsi</option></select>
      <select id="filterKota" aria-label="Filter kota/kabupaten"><option value="">Seluruh wilayah</option></select>
      <details class="lanjutan filter-lanjutan">
        <summary>Filter lanjutan</summary>
        <div class="tools f2">
      <input type="number" id="f2GajiMin" class="angka" min="0" step="500000" placeholder="Gaji min /bulan" aria-label="Gaji minimum per bulan pada tabel">
      <input type="number" id="f2GajiMax" class="angka" min="0" step="500000" placeholder="Gaji max /bulan" aria-label="Gaji maksimum per bulan pada tabel">
      <select id="umurMaks" aria-label="Umur lowongan maksimum">
        <option value="">Umur: semua</option><option value="0">Hari ini</option><option value="3">≤ 3 hari</option><option value="7">≤ 7 hari</option><option value="14">≤ 14 hari</option>
      </select>
      <select id="filterStatus" aria-label="Filter status"><option value="">Semua status</option>${['Baru', 'Evaluated', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'].map((s) => `<option value="${s.toLowerCase()}">${s}</option>`).join('')}</select>
      <span class="muted" style="font-size:.8rem" title="Skor cepat/evaluasi career-ops untuk baris yang punya laporan. Bukan peluang diterima. Hasil scan tanpa laporan tetap tampil, apa pun filternya.">Skor laporan (bukan peluang):</span>
      <select id="skorMin" aria-label="Skor laporan minimum">${[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5].map((n) => `<option value="${n}"${n === 0 ? ' selected' : ''}>${n.toFixed(1)}</option>`).join('')}</select>
      <span class="muted" style="font-size:.8rem">s/d</span>
      <select id="skorMax" aria-label="Skor laporan maksimum">${[0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((n) => `<option value="${n}"${n === 5 ? ' selected' : ''}>${n.toFixed(1)}</option>`).join('')}</select>
      <label class="sw"><input type="checkbox" id="hide"> Sembunyikan selesai</label>
      <button type="button" id="resetFilter" class="btn sm">Reset filter</button>
        </div>
      </details>
    </div>
  </div>
  <p class="f2-petunjuk">Nilai diambil dari data yang memang tertulis. <b>tanpa tanggal</b> dan <b>tidak dicantumkan</b> berarti sumbernya tidak menyebutkan — tidak ditebak. Umur &gt; 14 hari ditandai ⚠ dan disarankan <code>Discarded</code>. Saat filter gaji atau umur aktif, baris tanpa data ikut disembunyikan.</p>
  <div class="wrap">
    <table class="main">
      <thead><tr><th>Dilamar</th><th>Lowongan</th><th>Wilayah</th><th>Gaji/bulan</th><th>Diposting</th><th>Ditemukan</th><th>Umur</th><th>Sumber</th><th title="Skor laporan untuk baris dinilai; skor cepat untuk hasil scan">Skor</th><th>Status</th><th>CV dipakai</th><th>Berkas</th><th>Legitimasi</th><th>Aksi</th></tr></thead>
      <tbody>
${tableRows}
      </tbody>
    </table>
    <div id="kosong" class="kosong" hidden>Tidak ada lowongan yang cocok. Ubah kata kunci atau matikan filter di atas.</div>
  </div>
  <div class="halaman">
    <label>Baris per halaman <select id="perHalaman" aria-label="Baris per halaman"><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="0">Semua</option></select></label>
    <button type="button" id="halSebelum" class="btn sm">← Sebelumnya</button>
    <span id="halInfo" class="muted">Halaman 1 / 1</span>
    <button type="button" id="halBerikut" class="btn sm">Berikutnya →</button>
  </div>
  <p class="foot"><span>Menampilkan <strong id="jumlahTampil">${semuaBaris.length}</strong> dari ${semuaBaris.length} lowongan</span><span>Filter skor hanya untuk baris yang punya laporan; hasil scan tetap tampil. Centang kotak untuk menandai sudah dilamar — tidak ada lamaran yang dikirim otomatis.</span></p>
</section>

<section class="detail-list" aria-label="Detail lowongan">
  <h2>📄 Detail Lowongan &amp; Surat Lamaran</h2>
  <p class="note">Surat lamaran disusun dari isi CV tiap lowongan, tanpa tambahan fakta. Baca ulang CV dan surat sebelum dikirim, dan cek bagian Legitimasi untuk lowongan yang belum terkonfirmasi.</p>
${details}
</section>

<div id="drawer" class="drawer" hidden>
  <div class="drawer-panel" role="dialog" aria-modal="true" aria-label="Ringkasan lowongan">
    <div class="drawer-head"><strong>Ringkasan lowongan</strong><button type="button" id="drawerTutup" aria-label="Tutup ringkasan">×</button></div>
    <div id="drawerIsi"></div>
  </div>
</div>
</main>
<script>
/* ===== Profil lokal: satu server, satu root aktif ===== */
const escP = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const profilDaftarEl = document.getElementById('profilDaftar');
const profilStatusEl = document.getElementById('profilStatus');
const profilNamaEl = document.getElementById('profilNamaBaru');
function renderProfil(j) {
  const daftar = j.daftar || [];
  const aktif = daftar.find((p) => p.id === j.aktif);
  document.getElementById('profilAktif').textContent = aktif ? aktif.nama : 'Profil';
  profilDaftarEl.innerHTML = daftar.map((p) => {
    const aktifSekarang = p.id === j.aktif;
    const letak = p.utama ? 'data utama' : (p.root || 'folder profil');
    return '<div class="profil-item' + (aktifSekarang ? ' aktif' : '') + '" data-id="' + escP(p.id) + '">'
      + '<div class="profil-info"><strong>' + escP(p.nama) + '</strong><small>' + escP(letak)
      + (p.dibuat ? ' · dibuat ' + escP(p.dibuat) : '') + '</small></div>'
      + '<button type="button" data-pakai="' + escP(p.id) + '"' + (aktifSekarang ? ' disabled' : '') + '>'
      + (aktifSekarang ? 'Aktif' : 'Pakai') + '</button></div>';
  }).join('');
}
async function muatProfil() {
  try {
    const r = await fetch('/profil');
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'tidak diketahui');
    renderProfil(j);
  } catch (e) {
    profilDaftarEl.textContent = 'Gagal memuat profil: ' + e.message;
  }
}
document.getElementById('profilBuat').addEventListener('click', async () => {
  const nama = profilNamaEl.value.trim();
  if (!nama) { profilStatusEl.textContent = 'Isi nama profil dahulu.'; return; }
  profilStatusEl.textContent = 'Membuat profil...';
  try {
    const r = await fetch('/profil/buat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nama }),
    });
    const j = await r.json();
    if (!j.ok) { profilStatusEl.textContent = 'Gagal: ' + (j.error || 'tidak diketahui'); return; }
    profilNamaEl.value = '';
    profilStatusEl.textContent = 'Profil "' + j.profil.nama + '" dibuat. Klik "Pakai" untuk memakainya.';
    renderProfil(j.daftar);
  } catch (e) {
    profilStatusEl.textContent = 'Gagal menghubungi server: ' + e.message;
  }
});
profilDaftarEl.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-pakai]');
  if (!b || b.disabled) return;
  profilStatusEl.textContent = 'Memindah profil...';
  profilDaftarEl.querySelectorAll('button').forEach((x) => { x.disabled = true; });
  try {
    const r = await fetch('/profil/pakai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: b.dataset.pakai }),
    });
    const j = await r.json();
    if (!j.ok) {
      profilStatusEl.textContent = 'Gagal: ' + (j.error || 'tidak diketahui');
      muatProfil();
      return;
    }
    try { sessionStorage.removeItem('scanPesanTerakhir'); } catch (err) { /* mode privat */ }
    location.reload();
  } catch (err) {
    profilStatusEl.textContent = 'Gagal menghubungi server: ' + err.message;
  }
});
muatProfil();

const cnt = () => {
  const dilamar = document.querySelectorAll('table.main tbody tr.done').length;
  const total = document.querySelectorAll('table.main tbody tr').length;
  document.getElementById('n').textContent = dilamar;
  document.getElementById('belum').textContent = total - dilamar;
  document.getElementById('progres').style.width = (total ? Math.round(dilamar * 100 / total) : 0) + '%';
};
document.querySelectorAll('td.ck input').forEach((cb) => {
  cb.addEventListener('change', async () => {
    const tr = cb.closest('tr');
    try {
      const r = await fetch(cb.dataset.scanCb ? '/lamar-scan-tandai' : '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cb.dataset.scanCb ? { scanId: cb.dataset.scanCb, applied: cb.checked } : { num: tr.dataset.num, applied: cb.checked }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      if (!cb.checked) {
        liveDilamar.delete(String(cb.dataset.scanCb || tr.dataset.num));
        simpanLiveDilamar();
        const h = tr.querySelector('.hasil');
        if (h && h.textContent.trim() === '✓ Dilamar otomatis') h.textContent = '';
      }
      tr.classList.toggle('done', cb.checked);
      tr.querySelector('.st').textContent = cb.checked ? 'Applied' : (cb.dataset.scanCb ? 'Baru' : 'Evaluated');
      cnt();
      applyHide();
    } catch (e) { cb.checked = !cb.checked; alert('Gagal menyimpan: ' + e.message + '\\nPastikan halaman dibuka lewat http://127.0.0.1:${PORT}'); }
  });
});
document.querySelectorAll('button.lamar').forEach((b) => {
  b.addEventListener('click', async () => {
    const box = b.closest('td').querySelector('.hasil');
    b.disabled = true; b.textContent = 'Membuka...'; box.textContent = '';
    try {
      const r = await fetch('/lamar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ num: b.closest('tr').dataset.num }) });
      const j = await r.json();
      box.textContent = j.ok ? j.msg : 'Gagal: ' + (j.error || j.msg || 'tidak diketahui');
      if (j.ok && j.dilamar) tandaiOtomatis(b.closest('tr').dataset.num);
    } catch (e) { box.textContent = 'Gagal: ' + e.message; }
    b.disabled = false; b.textContent = 'Lamar';
  });
});
/* ---------- Lamar otomatis berurutan ---------- */
const batchBtn = document.getElementById('lamarSemua');
const batchStatus = document.getElementById('batchStatus');
const batchLog = document.getElementById('batchLog');
const suaraCb = document.getElementById('suaraNotifikasi');
const ujiBtn = document.getElementById('ujiSuara');
const batchAlert = document.getElementById('batchAlert');
let reloadTimer = null;
// Nomor yang sudah dicentang langsung di halaman ini (tanpa menunggu reload).
// Disimpan di sessionStorage supaya hasil yang selesai di latar belakang setelah
// halaman dimuat ulang tidak mencentang ulang baris yang sudah dibatalkan manual.
const liveDilamar = new Set();
try { JSON.parse(sessionStorage.getItem('dilamarDitandai') || '[]').forEach((n) => liveDilamar.add(String(n))); } catch (e) { /* mode privat */ }
const simpanLiveDilamar = () => {
  try { sessionStorage.setItem('dilamarDitandai', JSON.stringify([...liveDilamar])); } catch (e) { /* mode privat */ }
};

/* ---------- Suara notifikasi (Web Audio, tanpa berkas eksternal) ---------- */
let audioOn = true;
let actx = null;
let notifikasiTerakhir = '';
try { const v = localStorage.getItem('suaraNotifikasi'); if (v !== null) audioOn = v === '1'; } catch (e) { /* mode privat */ }
if (suaraCb) {
  suaraCb.checked = audioOn;
  suaraCb.addEventListener('change', () => {
    audioOn = suaraCb.checked;
    try { localStorage.setItem('suaraNotifikasi', audioOn ? '1' : '0'); } catch (e) { /* mode privat */ }
    if (audioOn) bunyi('uji');
  });
}
// Browser mengizinkan audio hanya setelah interaksi; siapkan context pada klik apa pun.
document.addEventListener('pointerdown', () => siapkanAudio(), true);

function siapkanAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  } catch (e) { return null; }
}
function nada(freq, mulai, durasi, jenis, keras) {
  const ac = siapkanAudio();
  if (!ac) return;
  try {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = jenis;
    o.frequency.value = freq;
    const t = ac.currentTime + mulai;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(keras, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durasi);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t);
    o.stop(t + durasi + 0.03);
  } catch (e) { /* audio tidak tersedia di browser ini */ }
}
function bunyi(jenis) {
  if (!audioOn) return;
  siapkanAudio();
  if (jenis === 'jawaban') {
    nada(659, 0, 0.18, 'sine', 0.22);
    nada(880, 0.20, 0.32, 'sine', 0.22);
  } else if (jenis === 'dokumen') {
    nada(880, 0, 0.16, 'triangle', 0.20);
    nada(659, 0.18, 0.16, 'triangle', 0.20);
    nada(440, 0.36, 0.38, 'triangle', 0.22);
  } else if (jenis === 'uji') {
    nada(720, 0, 0.12, 'sine', 0.14);
  } else {
    nada(523, 0, 0.18, 'sine', 0.18);
    nada(523, 0.24, 0.22, 'sine', 0.18);
  }
}

const PESAN_STOP = {
  'butuh-jawaban': 'Perlu jawabanmu. Jawab pertanyaan baru di jendela Chrome, lalu klik Lanjut SATU kali. Antrean lanjut setelah halaman berpindah; periksa status lamaran di Chrome.',
  'butuh-lanjut': 'Tombol Lanjut tidak bisa diklik otomatis. Klik Lanjut/Kirim SATU kali di jendela Chrome — antrean lanjut setelah halaman berpindah. Periksa status lamaran di Chrome.',
  'cv-tidak-cocok': 'CV tidak cocok untuk lowongan ini. Lamaran TIDAK dikirim. Periksa nama berkas di folder output, lalu ganti di jendela Chrome.',
  'surat-tidak-cocok': 'Surat lamaran tidak cocok untuk lowongan ini. Lamaran TIDAK dikirim. Periksa nama berkas di folder output, lalu ganti di jendela Chrome.',
  'butuh-konfirmasi': 'Otomatisasi berhenti dan menunggu konfirmasimu di jendela Chrome. Periksa halaman itu sebelum melanjutkan.'
};
const KODE_SUARA = {
  'butuh-jawaban': 'jawaban',
  'butuh-lanjut': 'jawaban',
  'cv-tidak-cocok': 'dokumen',
  'surat-tidak-cocok': 'dokumen',
  'dokumen-tidak-terpilih': 'dokumen',
  'butuh-konfirmasi': 'umum'
};

function notifikasiStop(st) {
  const hasil = Array.isArray(st.hasil) ? st.hasil : [];
  const berhenti = hasil.filter((h) => h.status === 'butuh-jawaban' || h.status === 'butuh-lanjut' || h.status === 'cv-tidak-cocok' || h.status === 'surat-tidak-cocok' || h.status === 'dokumen-tidak-terpilih' || h.status === 'butuh-konfirmasi' || h.jeda || h.berhenti);
  if (!berhenti.length) return;
  const h = berhenti[berhenti.length - 1];
  const kode = h.status || (h.jeda ? 'butuh-jawaban' : 'butuh-konfirmasi');
  if (kode === 'batas-harian' || kode === 'batas-batch') return;
  const kunci = [st.total, st.diproses, h.num, kode].join('|');
  if (kunci === notifikasiTerakhir) return;
  notifikasiTerakhir = kunci;
  bunyi(KODE_SUARA[kode] || 'umum');
  const pesan = '#' + h.num + ' - ' + (PESAN_STOP[kode] || PESAN_STOP['butuh-konfirmasi']);
  if (batchAlert) {
    batchAlert.className = 'batch-alert tampil' + (KODE_SUARA[kode] === 'dokumen' ? ' dokumen' : '');
    batchAlert.textContent = pesan;
  }
  batchStatus.textContent = pesan;
}

if (ujiBtn) {
  ujiBtn.addEventListener('click', () => {
    siapkanAudio();
    const lama = batchStatus.textContent;
    notifikasiTerakhir = '';
    notifikasiStop({ total: 1, diproses: 1, hasil: [{ num: '000', status: 'butuh-jawaban' }] });
    setTimeout(() => notifikasiStop({ total: 1, diproses: 2, hasil: [{ num: '000', status: 'cv-tidak-cocok' }] }), 950);
    setTimeout(() => {
      if (batchAlert) { batchAlert.className = 'batch-alert'; batchAlert.textContent = ''; }
      batchStatus.textContent = lama;
      notifikasiTerakhir = '';
    }, 2600);
  });
}

// Tandai baris SEKETIKA setelah lamaran terkirim ATAU setelah halaman mati
// dilewati. Tracker sudah ditulis skrip, jadi di sini hanya mengubah tampilan.
function tandaiOtomatis(num, status = 'Applied') {
  if (!num || liveDilamar.has(String(num))) return;
  const angka = String(num).split('').filter((c) => c >= '0' && c <= '9').join('');
  const tr = document.querySelector('table.main tbody tr[data-num="' + angka + '"]')
    || document.querySelector('table.main tbody tr[data-scan="' + String(num) + '"]');
  if (!tr) return;
  const cb = tr.querySelector('td.ck input');
  if (cb) {
    cb.checked = true;
    cb.disabled = status !== 'Applied';
    cb.title = status === 'Applied' ? 'Dilamar otomatis' : 'Dilewati: ' + status;
  }
  tr.classList.add('done');
  const st = tr.querySelector('.st');
  if (st) st.textContent = status;
  const h = tr.querySelector('.hasil');
  if (h && !h.textContent.trim()) h.textContent = status === 'Applied' ? '✓ Dilamar otomatis' : '✓ Dilewati: ' + status;
  liveDilamar.add(String(num));
  simpanLiveDilamar();
  cnt();
  applyHide();
}

// Alarm saat antrean sedang MENUNGGU jawaban (batch tidak berhenti, jadi
// notifikasiStop yang hanya membaca hasil tidak akan berbunyi).
function notifikasiTunggu(st) {
  const num = st.sedang && (st.sedang.num || st.sedang.scanId);
  if (!num) return;
  const kunci = 'tunggu|' + num + '|' + (st.diproses || 0);
  if (kunci === notifikasiTerakhir) return;
  notifikasiTerakhir = kunci;
  bunyi('jawaban');
  const pesan = '#' + num + ' - ' + (st.pesan || PESAN_STOP['butuh-jawaban']);
  if (batchAlert) {
    batchAlert.className = 'batch-alert tampil';
    batchAlert.textContent = pesan;
  }
  batchStatus.textContent = pesan;
}
function bersihkanNotifikasiTunggu(st) {
  if (!notifikasiTerakhir || !notifikasiTerakhir.startsWith('tunggu|')) return;
  if (st.tahap === 'menunggu-jawaban') return;
  notifikasiTerakhir = '';
  if (batchAlert && /Perlu jawabanmu/.test(batchAlert.textContent || '')) {
    batchAlert.className = 'batch-alert';
    batchAlert.textContent = '';
  }
}

function tulisBatch(st) {
  if (!st) return;
  bersihkanNotifikasiTunggu(st);
  const total = st.total || 0;
  const sudah = st.diproses || 0;
  if (st.berjalan) {
    batchBtn.disabled = true;
    batchBtn.textContent = 'Sedang melamar... (' + sudah + '/' + total + ')';
    if (st.sedang) {
      batchStatus.textContent = 'Memproses ' + (st.sedang.num ? '#' + st.sedang.num : (st.sedang.scanId || '')) + ' ' + (st.sedang.company || '') + ' - ' + (st.sedang.role || '');
    } else if (st.tahap === 'persiapan') {
      batchStatus.textContent = st.pesan || 'Menyiapkan antrean...';
    } else {
      batchStatus.textContent = 'Berjalan... (' + sudah + '/' + total + ')';
    }
  }
  if (st.pesan) batchStatus.textContent = st.pesan;
  if (Array.isArray(st.hasil) && st.hasil.length) {
    batchLog.hidden = false;
    batchLog.textContent = st.hasil.map((h) => {
      const nama = '#' + h.num + ' ' + (h.company || '');
      if (h.status === 'batas-harian' || h.status === 'batas-batch') return nama + ' - ' + h.msg;
      if (h.status === 'butuh-jawaban' || h.jeda) return nama + ' - BUTUH JAWABANMU (direkam untuk lowongan berikutnya): ' + (h.msg || '');
      if (h.status === 'butuh-lanjut') return nama + ' - BUTUH KLIK LANJUT/KIRIM DI CHROME: ' + (h.msg || '');
      if (h.status === 'cv-tidak-cocok') return nama + ' - CV TIDAK COCOK: ' + (h.msg || '');
      if (h.status === 'surat-tidak-cocok') return nama + ' - SURAT TIDAK COCOK: ' + (h.msg || '');
      if (h.status === 'lowongan-tutup') return nama + ' - DILEWATI: ' + (h.msg || 'lowongan tidak valid');
      if (h.status === 'sudah-dilamar') return nama + ' - DILEWATI: sudah dilamar / sudah naik tahap';
      if (h.berhenti) return nama + ' - BERHENTI: ' + (h.msg || 'perlu diperiksa di Chrome');
      if (h.selesai) return nama + ' - terkirim';
      return nama + ' - ' + (h.msg || h.error || 'selesai');
    }).join('\\n');
  }
  // Kotak centang langsung berubah begitu satu lamaran terkirim, tidak perlu
  // menunggu seluruh antrean selesai dan halaman dimuat ulang.
  if (Array.isArray(st.hasil)) st.hasil.forEach((h) => {
    if (!h) return;
    if (h.dilamar) tandaiOtomatis(h.num, 'Applied');
    else if (h.status === 'lowongan-tutup' && h.ditandai) tandaiOtomatis(h.num, 'Discarded');
  });
  // Bunyikan alarm sekali per kejadian (polling tiap 2 detik tidak boleh berbunyi terus).
  if (st.tahap === 'menunggu-jawaban') notifikasiTunggu(st);
  notifikasiStop(st);
  if (!st.berjalan && st.selesai && !reloadTimer) {
    try { sessionStorage.setItem('batchPesanTerakhir', batchStatus.textContent || ''); } catch (e) { /* mode privat */ }
    batchBtn.textContent = 'Memuat ulang halaman...';
    reloadTimer = setTimeout(() => location.reload(), 1800);
  }
}

async function pantauBatch() {
  try {
    const r = await fetch('/lamar-status', { cache: 'no-store' });
    const st = await r.json();
    tulisBatch(st);
    if (!st.berjalan && st.selesai) return;
  } catch (e) { /* coba lagi di putaran berikutnya */ }
  setTimeout(pantauBatch, 2000);
}

if (batchBtn) {
  batchBtn.addEventListener('click', async () => {
    const jumlah = batchBtn.textContent.match(/\((\d+)\)/);
    const n = jumlah ? jumlah[1] : 'semua';
    if (!confirm('Buka antrean ' + n + ' lowongan sekarang?\\n\\n__MODE_KIRIM_KONFIRMASI__')) return;
    siapkanAudio();
    notifikasiTerakhir = '';
    if (batchAlert) { batchAlert.className = 'batch-alert'; batchAlert.textContent = ''; }
    batchBtn.disabled = true;
    batchBtn.textContent = 'Menyiapkan...';
    batchStatus.textContent = 'Memulai antrean...';
    try {
      const r = await fetch('/lamar-semua', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const st = await r.json();
      if (st.error) throw new Error(st.error);
      tulisBatch(st);
      pantauBatch();
    } catch (e) {
      batchStatus.textContent = 'Gagal memulai: ' + e.message;
      batchBtn.disabled = false;
      batchBtn.textContent = 'Lamar otomatis semua yang siap';
    }
  });
  // Kalau halaman dibuka saat batch masih berjalan, langsung pantau.
  fetch('/lamar-status', { cache: 'no-store' }).then((r) => r.json()).then((st) => {
    if (st && st.berjalan) { tulisBatch(st); pantauBatch(); }
  }).catch(() => {});
  // Tampilkan lagi pesan terakhir setelah halaman dimuat ulang.
  try {
    const pesan = sessionStorage.getItem('batchPesanTerakhir');
    if (pesan) {
      batchStatus.textContent = pesan;
      sessionStorage.removeItem('batchPesanTerakhir');
    }
  } catch (e) { /* mode privat */ }
}

/* ===== Fase 2: filter + paginasi tabel =====
 * Filter skor HANYA untuk baris yang sudah punya laporan; hasil scan tetap tampil.
 * Filter gaji/umur tidak menebak: baris tanpa data ikut disembunyikan saat aktif. */
let halSekarang = 1;
const elF2 = (id) => document.getElementById(id);
const gantiFilter = () => { halSekarang = 1; applyHide(); };
const bukanAngka = (x) => Number.isNaN(x);

function applyHide() {
  const h = elF2('hide').checked;
  const q = (elF2('cari').value || '').trim().toLowerCase();
  const skorMin = parseFloat(elF2('skorMin').value) || 0;
  const skorMax = parseFloat(elF2('skorMax').value) || 5;
  const prov = (elF2('filterProvinsi').value || '').toLowerCase();
  const kota = (elF2('filterKota').value || '').toLowerCase();
  const gMin = parseFloat(elF2('f2GajiMin').value);
  const gMax = parseFloat(elF2('f2GajiMax').value);
  const uMaks = elF2('umurMaks').value;
  const status = (elF2('filterStatus').value || '').toLowerCase();
  const adaGaji = !bukanAngka(gMin) || !bukanAngka(gMax);

  const cocok = [];
  document.querySelectorAll('table.main tbody tr').forEach((tr) => {
    const d = tr.dataset;
    const skor = parseFloat(d.skor || '0');
    const lolosSkor = d.belum === '1' || (skor >= skorMin && skor <= skorMax);
    const lolosProv = !prov || (d.wilayah || '').includes(prov) || (d.cari || '').includes(prov);
    const lolosKota = !kota || (d.kota || '').includes(kota) || (d.cari || '').includes(kota);
    const gaji = d.gaji === '' ? null : Number(d.gaji);
    const lolosGaji = !adaGaji || (gaji !== null
      && (bukanAngka(gMin) || gaji >= gMin)
      && (bukanAngka(gMax) || gaji <= gMax));
    const umur = d.umur === '' ? null : Number(d.umur);
    const lolosUmur = uMaks === '' || (umur !== null && umur <= Number(uMaks));
    const lolosStatus = !status || (d.status || '').includes(status);
    const lolosCari = !q || (d.cari || '').includes(q);
    const lolosSelesai = !(h && tr.classList.contains('done'));
    if (lolosSkor && lolosProv && lolosKota && lolosGaji && lolosUmur && lolosStatus && lolosCari && lolosSelesai) {
      cocok.push(tr);
    } else {
      tr.classList.add('sembunyi');
    }
  });

  const per = parseInt(elF2('perHalaman').value, 10) || 0;
  const totalHal = per ? Math.max(1, Math.ceil(cocok.length / per)) : 1;
  if (halSekarang > totalHal) halSekarang = totalHal;
  const mulai = per ? (halSekarang - 1) * per : 0;
  const akhir = per ? mulai + per : cocok.length;
  cocok.forEach((tr, i) => tr.classList.toggle('sembunyi', !(i >= mulai && i < akhir)));

  elF2('kosong').hidden = cocok.length > 0;
  elF2('jumlahTampil').textContent = cocok.length;
  elF2('halInfo').textContent = 'Halaman ' + halSekarang + ' / ' + totalHal + ' · ' + cocok.length + ' baris cocok';
  elF2('halSebelum').disabled = halSekarang <= 1;
  elF2('halBerikut').disabled = halSekarang >= totalHal;
}

['hide', 'cari', 'skorMin', 'skorMax', 'filterProvinsi', 'filterKota', 'f2GajiMin', 'f2GajiMax', 'umurMaks', 'filterStatus', 'perHalaman']
  .forEach((id) => {
    const e = elF2(id);
    const acara = e.tagName === 'SELECT' || e.type === 'checkbox' ? 'change' : 'input';
    e.addEventListener(acara, gantiFilter);
  });
elF2('halSebelum').addEventListener('click', () => { if (halSekarang > 1) { halSekarang--; applyHide(); } });
elF2('halBerikut').addEventListener('click', () => { halSekarang++; applyHide(); });
elF2('resetFilter').addEventListener('click', () => {
  elF2('cari').value = '';
  elF2('filterProvinsi').value = '';
  isiKotaFilter('');
  elF2('f2GajiMin').value = '';
  elF2('f2GajiMax').value = '';
  elF2('umurMaks').value = '';
  elF2('filterStatus').value = '';
  elF2('skorMin').value = '0';
  elF2('skorMax').value = '5';
  elF2('hide').checked = false;
  elF2('perHalaman').value = '25';
  gantiFilter();
});

/* ===== Drawer ringkasan: hanya membaca data yang sudah di tabel ===== */
const drawer = elF2('drawer');
const tutupDrawer = () => { drawer.hidden = true; };
elF2('drawerTutup').addEventListener('click', tutupDrawer);
drawer.addEventListener('click', (e) => { if (e.target === drawer) tutupDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) tutupDrawer(); });
document.querySelectorAll('button.buka-detail').forEach((b) => {
  b.addEventListener('click', () => {
    const tr = b.closest('tr');
    const d = tr.dataset;
    const td = tr.querySelectorAll('td');
    const teks = (i) => (td[i] ? td[i].innerText.trim() : '');
    const baris = (label, nilai) => '<div class="dr"><span>' + label + '</span><strong>' + (nilai || '<span class="muted">tidak dicantumkan</span>') + '</strong></div>';
    const url = tr.querySelector('td.aksi a');
    elF2('drawerIsi').innerHTML = '<h3>' + teks(1) + '</h3>'
      + baris('Wilayah', teks(2))
      + baris('Gaji/bulan', teks(3))
      + baris('Diposting', teks(4))
      + baris('Ditemukan', teks(5))
      + baris('Umur', teks(6))
      + baris('Sumber', teks(7))
      + baris('Skor (' + (d.belum === '1' ? 'cepat' : 'laporan') + ')', teks(8))
      + baris('Status', teks(9))
      + baris('CV dipakai', d.cv || '')
      + baris('Berkas', teks(11))
      + baris('Legitimasi', teks(12))
      + (url ? '<p class="dr-link"><a href="' + url.href + '" target="_blank" rel="noopener">Buka lowongan ↗</a></p>' : '')
      + '<p class="dr-link"><a href="' + d.detail + '" id="drDetail">Lihat detail lengkap &amp; surat ↓</a></p>'
      + '<p class="dr-catatan">Ringkasan ini hanya menampilkan data yang sudah ada di tabel. Tidak ada penilaian baru dan tidak ada lamaran yang dikirim.</p>';
    const dl = elF2('drDetail');
    if (dl) dl.addEventListener('click', tutupDrawer);
    drawer.hidden = false;
  });
});

/* ===== Panel scan lowongan terbaru ===== */
const WILAYAH_UI = ${JSON.stringify(WILAYAH)};

/* Isi pilihan wilayah pada filter tabel Fase 2. Kota mengikuti provinsi. */
const escF = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function isiKotaFilter(namaProvinsi) {
  const sel = elF2('filterKota');
  const semua = '<option value="">' + (namaProvinsi ? 'Seluruh wilayah ' + namaProvinsi : 'Seluruh wilayah') + '</option>';
  if (!namaProvinsi) { sel.innerHTML = semua; return; }
  let kota = [];
  for (const w of WILAYAH_UI) {
    const p = w.provinsi.find((x) => x.nama === namaProvinsi);
    if (p) { kota = p.kota || []; break; }
  }
  sel.innerHTML = semua + kota.map((k) => '<option value="' + escF(k.toLowerCase()) + '">' + escF(k) + '</option>').join('');
}
(function siapkanFilterWilayah() {
  const prov = elF2('filterProvinsi');
  const nama = WILAYAH_UI.flatMap((w) => w.provinsi || []).map((p) => p.nama).filter(Boolean).sort();
  prov.innerHTML = '<option value="">Semua provinsi</option>'
    + nama.map((n) => '<option value="' + escF(n.toLowerCase()) + '">' + escF(n) + '</option>').join('');
  prov.addEventListener('change', () => { isiKotaFilter(prov.value ? prov.options[prov.selectedIndex].text : ''); gantiFilter(); });
  isiKotaFilter('');
  applyHide();
})();

const pulauEl = document.getElementById('pulau');
const provEl = document.getElementById('provinsi');
const ringkasanEl = document.getElementById('ringkasanPilihan');
let umurDipilih = '7';
const escA = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const umurTeks = () => (umurDipilih === 'today' ? 'hari ini' : umurDipilih + ' hari');
const provinsiDipilih = () => [...provEl.querySelectorAll('.prov input:checked')].map((i) => i.value);
const kotaEl = document.getElementById('kotaList');
const kotaLainEl = document.getElementById('kotaLain');
const dataProvinsi = (nama) => {
  for (const w of WILAYAH_UI) {
    const p = w.provinsi.find((x) => x.nama === nama);
    if (p) return p;
  }
  return null;
};
// Kota yang dicentang per provinsi. Provinsi tanpa centang = seluruh provinsi.
// Checkbox "Seluruh wilayah" tidak dihitung sebagai kota.
const kotaDipilih = () => {
  const keluar = {};
  kotaEl.querySelectorAll('.kota-grup').forEach((g) => {
    const pilih = [...g.querySelectorAll('.kota-chip input:checked')].map((i) => i.value);
    if (pilih.length) keluar[g.dataset.prov] = pilih;
  });
  return keluar;
};
const kotaLainDipilih = () => String(kotaLainEl.value || '').split(',')
  .map((s) => s.trim()).filter(Boolean);
function segarkanRingkasan() {
  const p = provinsiDipilih();
  const k = kotaDipilih();
  const lain = kotaLainDipilih();
  const gm = Number(document.getElementById('gajiMin').value || 0);
  const gx = Number(document.getElementById('gajiMax').value || 0);
  const gaji = (gm || gx)
    ? ' Gaji: Rp ' + gm.toLocaleString('id-ID') + '–' + gx.toLocaleString('id-ID') + '/bulan (yang tanpa gaji tetap tampil dan ditandai).'
    : '';
  const rincian = p.map((nama) => (k[nama] && k[nama].length
    ? nama + ' → ' + k[nama].join(', ')
    : nama + ' (seluruh wilayah)')).join('; ');
  const tambahan = lain.length ? ' Wilayah tambahan: ' + lain.join(', ') + '.' : '';
  ringkasanEl.textContent = p.length
    ? p.length + ' provinsi dipilih: ' + rincian + '.' + tambahan + ' Umur: ' + umurTeks() + '.' + gaji
    : 'Belum ada provinsi dipilih.' + tambahan + gaji;
}
// Bangun ulang daftar kota setiap provinsi berubah, sambil mempertahankan
// centang yang sudah ada.
function isiKota() {
  const p = provinsiDipilih();
  const sebelumnya = kotaDipilih();
  if (!p.length) {
    kotaEl.innerHTML = '<span class="muted" style="font-size:.85rem">Pilih provinsi dulu, lalu pilih seluruh wilayah atau kota/kabupaten tertentu. Contoh: Riau → Pekanbaru.</span>';
    segarkanRingkasan();
    return;
  }
  let html = '';
  p.forEach((nama) => {
    const d = dataProvinsi(nama);
    const pilih = new Set(sebelumnya[nama] || []);
    const semua = pilih.size === 0;
    html += '<div class="kota-grup" data-prov="' + escA(nama) + '"><div class="kota-judul">' + escA(nama) + '</div>';
    html += '<label class="sw sama"><input type="checkbox" data-semua="1"'
      + (semua ? ' checked' : '') + '> Seluruh wilayah ' + escA(nama) + '</label>';
    html += '<div class="kota-chip">';
    ((d && d.kota) || []).forEach((x) => {
      html += '<label class="sw"><input type="checkbox" value="' + escA(x) + '"'
        + (pilih.has(x) ? ' checked' : '') + '> ' + escA(x) + '</label>';
    });
    html += '</div></div>';
  });
  kotaEl.innerHTML = html;
  kotaEl.querySelectorAll('.kota-grup').forEach((g) => {
    const semuaCb = g.querySelector('input[data-semua]');
    const kotaCbs = [...g.querySelectorAll('.kota-chip input')];
    semuaCb.addEventListener('change', () => {
      if (semuaCb.checked) kotaCbs.forEach((i) => { i.checked = false; });
      segarkanRingkasan();
    });
    kotaCbs.forEach((i) => i.addEventListener('change', () => {
      if (i.checked) semuaCb.checked = false;
      // Tidak ada kota tersisa → kembali ke seluruh wilayah.
      if (!kotaCbs.some((x) => x.checked)) semuaCb.checked = true;
      segarkanRingkasan();
    }));
  });
  segarkanRingkasan();
}
function isiProvinsi() {
  const w = WILAYAH_UI.find((x) => x.pulau === pulauEl.value);
  if (!w) {
    provEl.innerHTML = '<span class="muted" style="font-size:.85rem">Pilih pulau dulu, lalu centang provinsi.</span>';
    isiKota();
    return;
  }
  let html = '<label class="sw sama"><input type="checkbox" id="pilihSemua"> Pilih semua di ' + escA(w.pulau) + '</label>';
  w.provinsi.forEach((x) => { html += '<label class="sw prov"><input type="checkbox" value="' + escA(x.nama) + '"> ' + escA(x.nama) + '</label>'; });
  provEl.innerHTML = html;
  document.getElementById('pilihSemua').addEventListener('change', (e) => {
    provEl.querySelectorAll('.prov input').forEach((i) => { i.checked = e.target.checked; });
    isiKota();
  });
  provEl.querySelectorAll('.prov input').forEach((i) => i.addEventListener('change', isiKota));
  isiKota();
}
pulauEl.addEventListener('change', isiProvinsi);
document.querySelectorAll('#umur button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#umur button').forEach((x) => x.classList.remove('aktif'));
  b.classList.add('aktif');
  umurDipilih = b.dataset.umur;
  segarkanRingkasan();
}));
kotaLainEl.addEventListener('input', segarkanRingkasan);
isiProvinsi();
['gajiMin', 'gajiMax'].forEach((id) => document.getElementById(id).addEventListener('input', segarkanRingkasan));

/* ===== Target dari CV: kata kunci & wilayah awal =====
   Sumbernya cv.md profil yang sedang aktif. Bila pengguna pernah menyimpan
   target sendiri, pilihan itu yang dipakai. Tidak ada tebakan: bila CV tidak
   menyebut jabatan/wilayah yang dikenal, kolom dibiarkan kosong. */
const kataKunciEl = document.getElementById('kataKunci');
const targetSumberEl = document.getElementById('targetSumber');
const targetSimpanEl = document.getElementById('targetSimpan');
const kataKunciDipilih = () => String(kataKunciEl.value || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
function terapkanTargetKeForm(t) {
  if (provinsiDipilih().length) return; // jangan menimpa pilihan pengguna
  const prov = (t.provinsi || []).filter((nama) => !!dataProvinsi(nama));
  if (!prov.length) return;
  // Panel ini menampilkan satu pulau pada satu waktu. Pakai pulau yang memuat
  // provinsi target terbanyak; provinsi lain di luar pulau itu tetap tercatat
  // pada target, tetapi tidak bisa dicentang bersamaan di panel ini.
  const hitung = {};
  for (const w of WILAYAH_UI) {
    const n = (w.provinsi || []).filter((x) => prov.includes(x.nama)).length;
    if (n) hitung[w.pulau] = n;
  }
  const pulau = Object.entries(hitung).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  if (!pulau) return;
  pulauEl.value = pulau;
  isiProvinsi();
  provEl.querySelectorAll('.prov input').forEach((i) => { i.checked = prov.includes(i.value); });
  const semuaProv = document.getElementById('pilihSemua');
  if (semuaProv) {
    const semuaCb = [...provEl.querySelectorAll('.prov input')];
    semuaProv.checked = semuaCb.length > 0 && semuaCb.every((i) => i.checked);
  }
  isiKota();
  const pilihKota = t.kota || {};
  kotaEl.querySelectorAll('.kota-grup').forEach((g) => {
    const dipilih = new Set(pilihKota[g.dataset.prov] || []);
    const semuaCb = g.querySelector('input[data-semua]');
    const kotaCbs = [...g.querySelectorAll('.kota-chip input')];
    kotaCbs.forEach((i) => { i.checked = dipilih.has(i.value); });
    semuaCb.checked = !kotaCbs.some((i) => i.checked);
  });
  const lain = (t.kotaLain || []).join(', ');
  if (lain && !kotaLainEl.value.trim()) kotaLainEl.value = lain;
  segarkanRingkasan();
}
async function muatTargeting() {
  try {
    const r = await fetch('/targeting-cv');
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'tidak diketahui');
    if (!kataKunciEl.value.trim()) kataKunciEl.value = (j.kataKunci || []).join(', ');
    const sumber = j.sumber === 'pengguna'
      ? 'pilihan yang Anda simpan'
      : (j.sumberKata === 'config/profile.yml' ? 'target di profil' : 'CV aktif');
    const kata = (j.kataKunci || []).slice(0, 4).join(', ');
    targetSumberEl.textContent = kata
      ? 'Diisi dari ' + sumber + ': ' + kata + (j.kataKunci.length > 4 ? ', …' : '')
        + '. Bisa Anda ubah. Kata kunci hanya untuk mencari lowongan; CV tidak diubah dan tidak ada lamaran yang dikirim.'
      : 'Belum ada kata kunci jabatan yang dikenal dari CV. Isi sendiri di kotak di atas, atau lengkapi CV/target profil.';
    if (Array.isArray(j.peringatan) && j.peringatan.length) {
      targetSumberEl.textContent += ' ' + j.peringatan.join(' ');
    }
    terapkanTargetKeForm(j);
  } catch (e) {
    targetSumberEl.textContent = 'Gagal membaca target dari CV: ' + e.message
      + '. Anda tetap bisa memilih wilayah dan mengisi kata kunci sendiri.';
  }
}
targetSimpanEl.addEventListener('click', async () => {
  const kata = kataKunciDipilih();
  const provinsi = provinsiDipilih();
  if (!kata.length) { targetSumberEl.textContent = 'Isi minimal satu kata kunci jabatan dahulu.'; return; }
  if (!provinsi.length) { targetSumberEl.textContent = 'Pilih minimal satu provinsi dahulu.'; return; }
  const semula = targetSimpanEl.textContent;
  targetSimpanEl.disabled = true;
  targetSimpanEl.textContent = 'Menyimpan…';
  try {
    const r = await fetch('/targeting-cv/simpan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kataKunci: kata, provinsi, kota: kotaDipilih(), kotaLain: kotaLainDipilih() }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'tidak diketahui');
    targetSumberEl.textContent = 'Target disimpan untuk profil ini. Scan berikutnya memakai pilihan ini sampai Anda mengubahnya lagi.';
  } catch (e) {
    targetSumberEl.textContent = 'Gagal menyimpan target: ' + e.message;
  } finally {
    targetSimpanEl.disabled = false;
    targetSimpanEl.textContent = semula;
  }
});
muatTargeting();

/* ===== Preset scan: disimpan di user layer, tidak menjalankan lamaran ===== */
const presetStatusEl = document.getElementById('presetStatus');
const presetDaftarEl = document.getElementById('presetDaftar');
const presetNamaEl = document.getElementById('namaPreset');
const presetTeks = (p) => {
  const prov = (p.provinsi || []).map((nama) => {
    const kota = (p.kota || {})[nama] || [];
    return kota.length ? nama + ' (' + kota.join(', ') + ')' : nama + ' (seluruh wilayah)';
  }).join('; ');
  const gaji = (p.gajiMin || p.gajiMax)
    ? ' · Rp ' + Number(p.gajiMin || 0).toLocaleString('id-ID') + '–' + Number(p.gajiMax || 0).toLocaleString('id-ID') + '/bulan'
    : '';
  const lain = (p.kotaLain || []).length ? ' · tambahan: ' + p.kotaLain.join(', ') : '';
  const kata = (p.kataKunci || []).length ? ' · kata: ' + p.kataKunci.slice(0, 4).join(', ') : '';
  return prov + ' · umur ' + (p.umur === 'today' ? 'hari ini' : (p.umur || '7') + ' hari') + gaji + lain + kata;
};
function renderPreset(daftar) {
  if (!daftar.length) {
    presetDaftarEl.innerHTML = '<span class="muted" style="font-size:.85rem">Belum ada preset tersimpan.</span>';
    return;
  }
  presetDaftarEl.innerHTML = daftar.map((p) => '<div class="preset-item" data-id="' + escA(p.id) + '">'
    + '<div class="preset-info"><strong>' + escA(p.nama) + '</strong><span class="muted">' + escA(presetTeks(p)) + '</span></div>'
    + '<div class="preset-aksi"><button type="button" data-aksi="muat">Muat</button>'
    + '<button type="button" data-aksi="scan">Scan</button>'
    + '<button type="button" data-aksi="hapus">Hapus</button></div></div>').join('');
}
async function muatDaftarPreset() {
  try {
    const r = await fetch('/scan-preset');
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'tidak diketahui');
    renderPreset(j.daftar || []);
  } catch (e) {
    presetStatusEl.textContent = 'Gagal memuat preset: ' + e.message;
  }
}
function presetKeForm(p) {
  const provinsi = (p.provinsi || []).filter((nama) => !!dataProvinsi(nama));
  if (!provinsi.length) { presetStatusEl.textContent = 'Preset tidak berisi provinsi yang dikenal.'; return false; }
  const wil = WILAYAH_UI.find((w) => (w.provinsi || []).some((x) => provinsi.includes(x.nama)));
  pulauEl.value = wil ? wil.pulau : '';
  provEl.querySelectorAll('input:checked').forEach((i) => { i.checked = false; });
  kotaEl.innerHTML = '';
  isiProvinsi();
  provEl.querySelectorAll('.prov input').forEach((i) => { i.checked = provinsi.includes(i.value); });
  const semuaProv = document.getElementById('pilihSemua');
  if (semuaProv) {
    const semuaCb = [...provEl.querySelectorAll('.prov input')];
    semuaProv.checked = semuaCb.length > 0 && semuaCb.every((i) => i.checked);
  }
  isiKota();
  const pilihKota = p.kota || {};
  kotaEl.querySelectorAll('.kota-grup').forEach((g) => {
    const dipilih = new Set(pilihKota[g.dataset.prov] || []);
    const semuaCb = g.querySelector('input[data-semua]');
    const kotaCbs = [...g.querySelectorAll('.kota-chip input')];
    kotaCbs.forEach((i) => { i.checked = dipilih.has(i.value); });
    semuaCb.checked = !kotaCbs.some((i) => i.checked);
  });
  umurDipilih = ['today', '3', '7', '14'].includes(p.umur) ? p.umur : '7';
  document.querySelectorAll('#umur button').forEach((b) => b.classList.toggle('aktif', b.dataset.umur === umurDipilih));
  document.getElementById('gajiMin').value = p.gajiMin == null ? '' : p.gajiMin;
  document.getElementById('gajiMax').value = p.gajiMax == null ? '' : p.gajiMax;
  kotaLainEl.value = (p.kotaLain || []).join(', ');
  if (Array.isArray(p.kataKunci) && p.kataKunci.length) {
    kataKunciEl.value = p.kataKunci.join(', ');
  }
  segarkanRingkasan();
  return true;
}
document.getElementById('presetSimpan').addEventListener('click', async () => {
  const status = presetStatusEl;
  if (!presetNamaEl.value.trim()) { status.textContent = 'Isi nama preset dahulu.'; return; }
  try {
    const r = await fetch('/scan-preset/simpan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nama: presetNamaEl.value,
        provinsi: provinsiDipilih(), kota: kotaDipilih(), kotaLain: kotaLainDipilih(),
        umur: umurDipilih,
        gajiMin: document.getElementById('gajiMin').value,
        gajiMax: document.getElementById('gajiMax').value,
        kataKunci: kataKunciDipilih(),
      }),
    });
    const j = await r.json();
    if (!j.ok) { status.textContent = 'Gagal: ' + (j.error || 'tidak diketahui'); return; }
    presetNamaEl.value = '';
    status.textContent = 'Preset "' + j.preset.nama + '" tersimpan.';
    muatDaftarPreset();
  } catch (e) {
    status.textContent = 'Gagal menghubungi server: ' + e.message;
  }
});
presetDaftarEl.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-aksi]');
  if (!b) return;
  const id = b.closest('.preset-item').dataset.id;
  const aksi = b.dataset.aksi;
  if (aksi === 'hapus') {
    try {
      const r = await fetch('/scan-preset/hapus', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const j = await r.json();
      if (!j.ok) { presetStatusEl.textContent = 'Gagal: ' + (j.error || 'tidak diketahui'); return; }
      presetStatusEl.textContent = 'Preset dihapus.';
      muatDaftarPreset();
    } catch (err) {
      presetStatusEl.textContent = 'Gagal menghubungi server: ' + err.message;
    }
    return;
  }
  try {
    const r = await fetch('/scan-preset?baca=' + encodeURIComponent(id));
    const j = await r.json();
    if (!j.ok) { presetStatusEl.textContent = 'Gagal: ' + (j.error || 'tidak diketahui'); return; }
    if (!presetKeForm(j.preset)) return;
    if (aksi === 'muat') {
      presetStatusEl.textContent = 'Preset "' + j.preset.nama + '" dimuat ke form. Klik "Scan lowongan terbaru" bila ingin mencari.';
    } else {
      presetStatusEl.textContent = 'Preset "' + j.preset.nama + '" dimuat. Menjalankan scan...';
      document.getElementById('scanBaru').click();
    }
  } catch (err) {
    presetStatusEl.textContent = 'Gagal menghubungi server: ' + err.message;
  }
});
muatDaftarPreset();

// Tampilkan lagi pesan scan setelah halaman dimuat ulang otomatis.
try {
  const simpan = sessionStorage.getItem('scanPesanTerakhir');
  if (simpan) {
    sessionStorage.removeItem('scanPesanTerakhir');
    const jPesan = JSON.parse(simpan);
    document.getElementById('scanStatus').textContent = jPesan.pesan || '';
    const wadah = document.getElementById('scanHasil');
    wadah.innerHTML = jPesan.html || '';
    wadah.hidden = !wadah.innerHTML;
  }
} catch (e) { /* abaikan */ }

/* ===== Panel CV saya =====
   Semua tulisan lewat /cv/pratinjau lalu /cv/simpan. Tidak ada jalur yang
   menimpa cv.md tanpa perbedaan yang ditampilkan dan konfirmasi dicentang. */
const cvEl = (id) => document.getElementById(id);
const cvState = { token: null, aksi: null, mode: null, payload: null };
const cvEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cvTanggal(x) {
  if (!x) return '—';
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function cvTampilStatus(st) {
  const nama = cvEl('cvAktifNama');
  const meta = cvEl('cvAktifMeta');
  const chips = cvEl('cvAktifRingkas');
  const badge = cvEl('cvStatus');
  const tandaiLangkahCv = (selesai) => {
    const langkah = document.getElementById('langkahCv');
    if (langkah) langkah.classList.toggle('selesai', !!selesai);
  };
  if (!st || st.ok === false) {
    badge.textContent = 'CV tidak terbaca';
    badge.className = 'badge badge-neutral';
    meta.textContent = (st && st.error) || 'Gagal membaca cv.md.';
    tandaiLangkahCv(false);
    return;
  }
  const a = st.aktif || {};
  nama.textContent = a.nama || 'CV aktif';
  const baris = [
    a.virtual ? 'Belum diarsipkan' : 'Versi ' + (a.id || ''),
    a.dibuat ? 'diperbarui ' + cvTanggal(a.dibuat) : '',
    (st.arsip || []).length + ' versi tersimpan',
  ].filter(Boolean).join(' · ');
  meta.textContent = baris + (st.berubahSejakArsip ? ' · cv.md berbeda dari versi tersimpan (akan diarsipkan saat diganti)' : '');
  const r = st.ringkas || {};
  chips.innerHTML = [
    r.pengalaman + ' pengalaman',
    r.skill + ' butir skill',
    r.baris + ' baris',
    r.pendidikan ? 'pendidikan ✓' : 'pendidikan ?',
    r.kontak ? 'kontak ✓' : 'kontak ?',
  ].map((t) => '<span class="chip">' + cvEsc(t) + '</span>').join('');
  if (st.placeholder) {
    badge.textContent = 'CV contoh — isi dulu';
    badge.className = 'badge badge-warning';
    meta.textContent = 'cv.md masih berisi contoh bertanda kurung. Isi dengan data Anda sendiri sebelum membuat PDF atau lamaran.';
    tandaiLangkahCv(false);
  } else {
    badge.textContent = st.adaCv ? 'CV aktif siap' : 'cv.md kosong';
    badge.className = 'badge ' + (st.adaCv ? 'badge-scan' : 'badge-neutral');
    tandaiLangkahCv(!!st.adaCv);
  }

  const sel = cvEl('cvPilihArsip');
  const daftar = st.arsip || [];
  if (!daftar.length) {
    sel.innerHTML = '<option value="">— belum ada versi tersimpan —</option>';
    cvEl('cvArsipMeta').textContent = 'Versi pertama dibuat otomatis saat CV diganti.';
  } else {
    sel.innerHTML = daftar.map((v) => '<option value="' + cvEsc(v.id) + '">'
      + cvEsc(v.nama) + ' · ' + cvEsc(cvTanggal(v.dibuat)) + (v.aktif ? ' (aktif)' : '')
      + '</option>').join('');
    cvEl('cvArsipMeta').textContent = daftar.length + ' versi tersimpan. Pilih satu, lalu pratinjau.';
  }
}

function cvPesan(teks, jenis) {
  const el = cvEl('cvPesan');
  el.textContent = teks || '';
  el.style.color = jenis === 'salah' ? 'var(--bad)' : jenis === 'ok' ? 'var(--ok)' : '';
}

function cvTampilDiff(j, judul, mode) {
  cvState.mode = mode || 'cv';
  cvEl('cvDiffBox').hidden = false;
  cvEl('cvDiffJudul').textContent = judul;
  const entri = cvState.mode === 'entri';
  cvEl('cvSetujuTeks').textContent = entri
    ? 'Saya sudah memeriksa entri di atas dan yakin semua kata serta angkanya benar. Entri akan ditambahkan ke cv.md dan CV sekarang diarsipkan.'
    : 'Saya sudah memeriksa perbedaan di atas dan setuju menjadikannya CV aktif. Versi sekarang akan diarsipkan otomatis.';
  cvEl('cvSimpan').textContent = entri ? 'Tambahkan entri ke CV' : 'Jadikan CV aktif';
  cvEl('cvDiffStat').textContent = '+' + j.stat.tambah + ' baris · −' + j.stat.hapus
    + ' baris' + (j.dipotong ? ' · ditampilkan ' + j.diff.length + ' dari ' + j.totalBaris : '');
  cvEl('cvDiff').innerHTML = j.diff.map((o) => {
    const kelas = o.t === '+' ? 'tambah' : o.t === '-' ? 'hapus' : 'sama';
    const no = o.t === '+' ? o.b : o.a;
    const tanda = o.t === '=' ? ' ' : o.t;
    return '<div class="baris ' + kelas + '"><span class="no">' + (no || '') + '</span>'
      + '<span class="tanda">' + cvEsc(tanda) + '</span><span>' + (o.teks === '' ? ' ' : cvEsc(o.teks)) + '</span></div>';
  }).join('');
  const p = cvEl('cvPeringatan');
  const daftar = j.peringatan || [];
  if (daftar.length) {
    p.hidden = false;
    p.innerHTML = '<strong>Perlu diperiksa:</strong><ul>' + daftar.map((x) => '<li>' + cvEsc(x) + '</li>').join('') + '</ul>';
  } else {
    p.hidden = true;
    p.innerHTML = '';
  }
  cvEl('cvSetuju').checked = false;
  cvEl('cvSimpan').disabled = true;
  cvPesan('');
  cvEl('cvDiffBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function cvPratinjau(payload, judul, mode) {
  cvPesan('Menyiapkan perbedaan…');
  try {
    const r = await fetch(mode === 'entri' ? '/cv/entri/pratinjau' : '/cv/pratinjau', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) {
      cvEl('cvDiffBox').hidden = false;
      cvPesan(j.error || 'Gagal membuat pratinjau.', 'salah');
      return;
    }
    cvState.token = j.token;
    cvState.aksi = mode === 'entri' ? null : (payload.id ? { id: payload.id } : { teks: payload.teks, nama: payload.nama });
    cvState.payload = mode === 'entri' ? j.payload : null;
    cvTampilDiff(j, judul + ' → ' + (j.nama || (j.payload && j.payload.perusahaan) || 'entri'), mode);
  } catch (e) {
    cvEl('cvDiffBox').hidden = false;
    cvPesan('Gagal menghubungi server: ' + e.message, 'salah');
  }
}

async function cvMuat() {
  try {
    const r = await fetch('/cv', { cache: 'no-store' });
    const st = await r.json();
    cvTampilStatus(st);
    const pilih = cvEl('entBagian');
    const daftar = (st.ringkas && st.ringkas.bagian) || [];
    const sebelumnya = pilih.value;
    pilih.innerHTML = daftar.length
      ? daftar.map((b) => '<option value="' + cvEsc(b) + '">' + cvEsc(b) + '</option>').join('')
      : '<option value="">— belum ada bagian —</option>';
    const utama = daftar.find((b) => /experience|pengalaman|work history|employment/i.test(b)) || daftar[0] || '';
    pilih.value = daftar.includes(sebelumnya) ? sebelumnya : utama;
  } catch (e) {
    cvTampilStatus({ ok: false, error: e.message });
  }
}

cvEl('cvLihat').addEventListener('click', async () => {
  const pre = cvEl('cvIsi');
  if (!pre.hidden) { pre.hidden = true; cvEl('cvTutupLihat').hidden = true; return; }
  const r = await fetch('/cv/isi', { cache: 'no-store' });
  const j = await r.json();
  if (!j.ok) { cvPesan(j.error || 'Gagal membaca CV.', 'salah'); return; }
  pre.textContent = j.teks || '(kosong)';
  pre.hidden = false;
  cvEl('cvTutupLihat').hidden = false;
});
cvEl('cvTutupLihat').addEventListener('click', () => {
  cvEl('cvIsi').hidden = true;
  cvEl('cvTutupLihat').hidden = true;
});

cvEl('cvPilihArsip').addEventListener('change', () => {
  const id = cvEl('cvPilihArsip').value;
  cvEl('cvDiffBox').hidden = true;
  cvState.token = null;
  cvState.aksi = null;
  cvState.payload = null;
  cvState.mode = null;
  if (id) cvEl('cvArsipMeta').textContent = 'Versi dipilih. Klik "Pratinjau perbedaan" untuk membandingkan dengan CV aktif.';
});

cvEl('cvPratinjauArsip').addEventListener('click', () => {
  const id = cvEl('cvPilihArsip').value;
  if (!id) { cvPesan('Belum ada versi tersimpan untuk dipilih.', 'salah'); return; }
  cvPratinjau({ id }, 'Versi tersimpan');
});

/* Dua contoh CV: hanya mengisi kotak, tidak pernah menyimpan langsung. */
const contohTeks = ${JSON.stringify(contohCvTeks)};
document.querySelectorAll('[data-contoh-lihat]').forEach((b) => b.addEventListener('click', () => {
  const pre = cvEl('contohCvIsi');
  pre.textContent = contohTeks[b.dataset.contohLihat] || 'Contoh tidak tersedia.';
  pre.hidden = false;
  cvEl('contohCvPesan').textContent = 'Ini contoh fiktif. Pakai kerangkanya, lalu ganti semua data sebelum melamar.';
}));
document.querySelectorAll('[data-contoh-pakai]').forEach((b) => b.addEventListener('click', () => {
  const isi = contohTeks[b.dataset.contohPakai] || '';
  if (!isi) { cvEl('contohCvPesan').textContent = 'Contoh tidak tersedia.'; return; }
  cvEl('cvTeksBaru').value = isi;
  if (!cvEl('cvNamaBaru').value.trim()) {
    cvEl('cvNamaBaru').value = 'Kerangka ' + (b.dataset.contohPakai === 'perkantoran' ? 'perkantoran' : 'teknik mesin');
  }
  cvEl('contohCvIsi').hidden = true;
  cvEl('contohCvPesan').textContent = 'Kerangka disalin ke kotak “Tempel CV baru”. Ganti semua data fiktif, lalu klik Pratinjau perbedaan dan konfirmasi.';
  cvEl('cvTeksBaru').scrollIntoView({ behavior: 'smooth', block: 'center' });
  cvEl('cvTeksBaru').focus();
}));

cvEl('cvPratinjauTempel').addEventListener('click', () => {
  const teks = cvEl('cvTeksBaru').value;
  const nama = cvEl('cvNamaBaru').value.trim();
  if (!teks.trim()) { cvPesan('Tempel isi CV terlebih dahulu.', 'salah'); return; }
  cvPratinjau({ teks, nama }, 'CV baru');
});

function cvKeBase64(bytes) {
  let biner = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    biner += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(biner);
}

cvEl('cvPdfProses').addEventListener('click', async () => {
  const berkas = cvEl('cvPdfFile').files[0];
  const pesan = cvEl('cvPdfPesan');
  if (!berkas) { pesan.textContent = 'Pilih berkas PDF dulu.'; return; }
  if (!/\.pdf$/i.test(berkas.name) && berkas.type !== 'application/pdf') {
    pesan.textContent = 'Hanya berkas .pdf yang diterima.';
    return;
  }
  if (berkas.size > 10 * 1024 * 1024) {
    pesan.textContent = 'PDF terlalu besar. Maksimal 10 MB.';
    return;
  }
  pesan.textContent = 'Membaca PDF…';
  try {
    const bytes = new Uint8Array(await berkas.arrayBuffer());
    const r = await fetch('/cv/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf: cvKeBase64(bytes),
        nama: cvEl('cvPdfNama').value.trim() || berkas.name,
      }),
    });
    const j = await r.json();
    if (!j.ok) { pesan.textContent = j.error || 'Gagal membaca PDF.'; return; }
    cvEl('cvTeksBaru').value = j.teks;
    cvEl('cvNamaBaru').value = j.nama;
    const perlu = (j.peringatan || []).join(' ');
    pesan.textContent = 'Teks siap di kotak “Tempel CV baru”. Klik Pratinjau perbedaan, lalu konfirmasi.'
      + (perlu ? ' Perlu diperiksa: ' + perlu : '');
    cvEl('cvTeksBaru').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    pesan.textContent = 'Gagal membaca PDF: ' + e.message;
  }
});

cvEl('cvSetuju').addEventListener('change', (e) => {
  cvEl('cvSimpan').disabled = !e.target.checked || !cvState.token;
});

cvEl('cvBatal').addEventListener('click', () => {
  cvEl('cvDiffBox').hidden = true;
  cvState.token = null;
  cvState.aksi = null;
  cvState.payload = null;
  cvState.mode = null;
  cvEl('cvSetuju').checked = false;
  cvEl('cvSimpan').disabled = true;
});

cvEl('cvSimpan').addEventListener('click', async () => {
  if (!cvState.token) return;
  const entri = cvState.mode === 'entri';
  if (!entri && !cvState.aksi) return;
  const tombol = cvEl('cvSimpan');
  const teksAsal = entri ? 'Tambahkan entri ke CV' : 'Jadikan CV aktif';
  tombol.disabled = true;
  tombol.textContent = 'Menyimpan…';
  try {
    const r = await fetch(entri ? '/cv/entri/simpan' : '/cv/simpan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entri
        ? { token: cvState.token, konfirmasi: true, payload: cvState.payload }
        : { token: cvState.token, konfirmasi: true, ...cvState.aksi }),
    });
    const j = await r.json();
    if (!j.ok) {
      cvPesan(j.error || 'Gagal menyimpan.', 'salah');
      return;
    }
    cvPesan(j.pesan || 'CV aktif diganti.', 'ok');
    cvState.token = null;
    cvState.aksi = null;
    cvState.payload = null;
    if (entri) {
      cvEl('entPoin').value = '';
      cvEl('entPerusahaan').value = '';
      cvEl('entLokasi').value = '';
      cvEl('entJabatan').value = '';
      cvEl('entTanggal').value = '';
    } else {
      cvEl('cvTeksBaru').value = '';
      cvEl('cvNamaBaru').value = '';
    }
    cvEl('cvIsi').hidden = true;
    cvEl('cvTutupLihat').hidden = true;
    if (j.status) cvTampilStatus(j.status);
    cvMuat();
    setTimeout(() => { cvEl('cvDiffBox').hidden = true; }, 2500);
  } catch (e) {
    cvPesan('Gagal menghubungi server: ' + e.message, 'salah');
  } finally {
    tombol.textContent = teksAsal;
    tombol.disabled = !cvEl('cvSetuju').checked;
  }
});

cvMuat();

/* ===== Fase 1: tambah entri, cek struktur, skill gap ===== */
const entPayload = () => ({
  bagian: cvEl('entBagian').value,
  perusahaan: cvEl('entPerusahaan').value,
  lokasi: cvEl('entLokasi').value,
  jabatan: cvEl('entJabatan').value,
  tanggal: cvEl('entTanggal').value,
  poin: cvEl('entPoin').value,
});

cvEl('entPratinjau').addEventListener('click', () => {
  cvPratinjau(entPayload(), 'Entri baru', 'entri');
});

cvEl('cekCvJalankan').addEventListener('click', async () => {
  const box = cvEl('cekCvHasil');
  box.hidden = false;
  box.textContent = 'Memeriksa…';
  try {
    const j = await fetch('/cv/cek', { cache: 'no-store' }).then((r) => r.json());
    if (!j.ok) { box.textContent = j.error || 'Gagal memeriksa CV.'; return; }
    const r = j.ringkas || {};
    const daftar = (j.entri || []).map((e) => '<div class="cek-entri"><b>' + cvEsc(e.perusahaan) + '</b> — '
      + cvEsc(e.jabatan) + ' · ' + cvEsc(e.tanggal) + '</div>').join('');
    const amaran = (j.peringatan || []).length
      ? '<div class="cv-peringatan"><strong>Perlu diperiksa:</strong><ul>'
        + j.peringatan.map((x) => '<li>' + cvEsc(x) + '</li>').join('') + '</ul></div>'
      : '';
    box.innerHTML = '<div class="cv-chips" style="margin:0 0 8px">'
      + '<span class="chip">' + cvEsc((j.entri || []).length) + ' entri terbaca</span>'
      + '<span class="chip">' + cvEsc(r.baris || 0) + ' baris</span>'
      + '<span class="chip">' + cvEsc(r.skill || 0) + ' butir skill</span>'
      + '<span class="chip">' + cvEsc(j.belumTerbaca) + ' belum terbaca</span></div>'
      + (daftar || '<div class="cv-catatan">Belum ada entri pengalaman yang terbaca.</div>')
      + amaran
      + '<p class="gap-catatan">' + cvEsc(j.keterangan || '') + '</p>';
  } catch (e) {
    box.textContent = 'Gagal menghubungi server: ' + e.message;
  }
});

cvEl('gapJalankan').addEventListener('click', async () => {
  const box = cvEl('gapHasil');
  const jd = cvEl('gapJd').value;
  if (!jd.trim()) { box.hidden = false; box.textContent = 'Tempel teks lowongan terlebih dahulu.'; return; }
  box.hidden = false;
  box.textContent = 'Menganalisis…';
  try {
    const j = await fetch('/cv/skill-gap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jd }),
    }).then((r) => r.json());
    if (!j.ok) { box.textContent = j.error || 'Gagal menganalisis.'; return; }
    const bucket = (kelas, judul, daftar) => '<div class="gap-bucket ' + kelas + '"><b>' + judul
      + ' (' + daftar.length + ')</b>' + (daftar.length ? cvEsc(daftar.join(', ')) : '—') + '</div>';
    const extra = [];
    if (j.lowConfidence) extra.push('🚨 ' + cvEsc(j.lowConfidence.message || 'keyakinan rendah'));
    if (j.partialCoverage) extra.push('ℹ️ Sebagian persyaratan tidak terbaca.');
    box.innerHTML = '<div class="cv-chips" style="margin:0 0 8px"><span class="chip">'
      + cvEsc(j.ditemukan) + ' kata ditemukan di JD</span></div>'
      + bucket('ada', 'Sudah ada di bagian Skills', j.existing || [])
      + bucket('prosa', 'Ada di narasi CV', j.supportedByResume || [])
      + bucket('kurang', 'Tidak ditemukan di cv.md (gap)', j.gap || [])
      + (extra.length ? '<p class="gap-catatan">' + extra.join('<br>') + '</p>' : '')
      + '<p class="gap-catatan">' + cvEsc(j.keterangan || '') + '</p>';
  } catch (e) {
    box.textContent = 'Gagal menghubungi server: ' + e.message;
  }
});

document.getElementById('scanBaru').addEventListener('click', async () => {
  const provinsi = provinsiDipilih();
  const status = document.getElementById('scanStatus');
  const hasil = document.getElementById('scanHasil');
  const tombol = document.getElementById('scanBaru');
  if (!provinsi.length) { status.textContent = 'Pilih minimal satu provinsi dahulu.'; hasil.hidden = true; return; }
  const kota = kotaDipilih();
  const kotaLain = kotaLainDipilih();
  const kotaNama = Object.keys(kota).reduce((a, k) => a.concat(kota[k]), []);
  tombol.disabled = true;
  tombol.textContent = 'Memindai...';
  const rincianScan = kotaNama.length
    ? '(' + kotaNama.slice(0, 4).join(', ') + (kotaNama.length > 4 ? ', …' : '') + ')'
    : '(seluruh wilayah)';
  status.textContent = 'Memindai ' + provinsi.length + ' provinsi ' + rincianScan
    + (kotaLain.length ? ' + ' + kotaLain.length + ' wilayah tambahan' : '')
    + ', lowongan ' + umurTeks() + '...';
  hasil.hidden = true;
  try {
    const r = await fetch('/scan-baru', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provinsi, kota, kotaLain, umur: umurDipilih,
        gajiMin: document.getElementById('gajiMin').value,
        gajiMax: document.getElementById('gajiMax').value,
        kataKunci: kataKunciDipilih(),
      }),
    });
    const j = await r.json();
    if (!j.ok) { status.textContent = 'Gagal: ' + (j.error || 'tidak diketahui'); return; }
    let pesan = 'Selesai: ' + j.ditambahkan + ' lowongan baru dari ' + Number(j.ditemukan || 0).toLocaleString('id-ID')
      + ' yang ditemukan (' + j.dipindai + ' board dipindai).';
    if (j.gajiMin || j.gajiMax) {
      const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
      pesan += ' Gaji ' + rupiah(j.gajiMin) + '–' + rupiah(j.gajiMax) + '/bulan (yang tanpa gaji tetap tampil dan ditandai).';
    }
    if (Array.isArray(j.kataKunci) && j.kataKunci.length) {
      pesan += ' Kata kunci: ' + j.kataKunci.slice(0, 5).join(', ')
        + (j.kataKunci.length > 5 ? ', …' : '') + '.';
    }
    if (j.berkas && j.berkas.total) {
      pesan += ' CV + surat otomatis: ' + j.berkas.dibuat + ' dibuat dari ' + j.berkas.total + ' lowongan hasil scan di tabel';
      if (j.berkas.gagal) pesan += ' (' + j.berkas.gagal + ' gagal, rincian di catatan halaman)';
      pesan += '.';
    }
    if (j.peringatan) pesan += ' ' + j.peringatan;
    if (j.lowongan && j.lowongan.length) {
      pesan += ' Skor cepat otomatis tampil di kolom Skor (bukan evaluasi resmi).';
      let html = '<strong>Masuk ke tabel di atas dengan skor cepat:</strong><ul>';
      j.lowongan.forEach((l) => {
        html += '<li><a href="' + escA(l.url) + '" target="_blank" rel="noopener">' + escA(l.title || l.company || l.url) + '</a>'
          + (l.company ? ' — ' + escA(l.company) : '')
          + (l.location ? ' — ' + escA(l.location) : '')
          + (l.gajiTeks ? ' — ' + escA(l.gajiTeks) : '')
          + (l.posted ? ' — ' + escA(l.posted) : '')
          + '<span class="belum">Belum dinilai</span></li>';
      });
      hasil.innerHTML = html + '</ul>';
    } else {
      hasil.textContent = 'Tidak ada lowongan baru yang memenuhi filter ini. Coba perluas wilayah, perpanjang umur lowongan, atau ubah kata kunci jabatan di kotak “Target dari CV” di atas. Semua lowongan yang sudah tersimpan tetap tampil di tabel.';
    }
    hasil.hidden = false;
    status.textContent = pesan;
    // Segarkan halaman supaya baris baru langsung muncul di tabel utama.
    // Pesan panel disimpan dulu agar tidak hilang setelah reload.
    try { sessionStorage.setItem('scanPesanTerakhir', JSON.stringify({ pesan, html: hasil.innerHTML })); } catch (e) { /* mode privat */ }
    setTimeout(() => { location.reload(); }, 1200);
  } catch (e) {
    status.textContent = 'Gagal menghubungi server: ' + e.message;
  } finally {
    tombol.disabled = false;
    tombol.textContent = 'Scan lowongan terbaru';
  }
});

// Lamaran yang selesai di latar belakang (misalnya setelah kamu menjawab
// pertanyaan baru) tetap langsung tercentang tanpa perlu refresh manual.
async function pantauCentang() {
  try {
    const r = await fetch('/lamar-dilamar', { cache: 'no-store' });
    const j = await r.json();
    if (Array.isArray(j.nums)) j.nums.forEach((n) => tandaiOtomatis(n));
    if (Array.isArray(j.scan)) j.scan.forEach((s) => tandaiOtomatis(s));
    if (Array.isArray(j.ditutup)) j.ditutup.forEach((s) => tandaiOtomatis(s, 'Discarded'));
  } catch (e) { /* server belum siap, coba lagi */ }
  setTimeout(pantauCentang, 4000);
}
pantauCentang();
</script>
</body>
</html>
`;

fs.writeFileSync(outFile(), html, 'utf8');
console.log(letterStatus);
console.log(`Ringkasan: ${rows.length} lowongan -> ${outFile()}`);
return html;
}

// Satu build per root. Kalau ini satu promise global, dua akun yang request
// bersamaan bisa saling menimpa signature dan HTML-nya.
const petaBuilding = new Map();
petaSignature.delete(ROOT());

// Sidik jari file sumber: kalau tidak berubah, refresh tidak perlu membangun
// ulang 14 detik; kalau tracker/report/PDF bertambah, halaman langsung ikut baru.
function sumberSignature() {
  const bagian = ['profil:' + ROOT()];
  for (const f of ['data/applications.md', 'data/pdf-index.tsv', 'data/pipeline.md']) {
    try { bagian.push(`${f}:${fs.statSync(path.join(ROOT(), f)).mtimeMs}`); }
    catch { bagian.push(`${f}:0`); }
  }
  try { bagian.push(`ringkasan.mjs:${fs.statSync(path.join(CODE_ROOT, 'ringkasan.mjs')).mtimeMs}`); }
  catch { bagian.push('ringkasan.mjs:0'); }
  try { bagian.push(`profil-lokal:${fs.statSync(path.join(rootPengguna(), 'data', 'profil-lokal.json')).mtimeMs}`); }
  catch { bagian.push('profil-lokal:0'); }
  for (const d of ['reports', 'output', 'jds', 'surat-khusus']) {
    try {
      const s = fs.statSync(path.join(ROOT(), d));
      bagian.push(`${d}:${s.mtimeMs}:${fs.readdirSync(path.join(ROOT(), d)).length}`);
    } catch { bagian.push(`${d}:0`); }
  }
  try { bagian.push(`surat-profil:${fs.statSync(profileFile()).mtimeMs}`); } catch { bagian.push('surat-profil:0'); }
  return bagian.join('|');
}

async function buildIfNeeded(paksa = false) {
  const sig = sumberSignature();
  if (process.env.RINGKASAN_LOG) console.log('[build]', paksa ? 'paksa' : 'cek', sig === signatureTerakhir() ? 'SAMA' : 'BEDA', '\n  lama:', signatureTerakhir(), '\n  baru:', sig);
  if (!paksa && sig === signatureTerakhir() && fs.existsSync(outFile())) return;
  const kunci = ROOT();
  if (!petaBuilding.get(kunci)) {
    petaBuilding.set(kunci, build()
      .then(() => { petaSignature.set(kunci, sumberSignature()); })
      .finally(() => { petaBuilding.delete(kunci); }));
  }
  await petaBuilding.get(kunci);
}

// Status antrean "Lamar otomatis" disimpan per root: akun lain tidak boleh
// melihat progres atau menghentikan antrean milik akun yang berbeda.
const petaBatch = new Map();
const batchBaru = () => ({ berjalan: false, selesai: false, tahap: 'idle', total: 0, diproses: 0, hasil: [], pesan: '' });
function batchState() {
  const kunci = ROOT();
  if (!petaBatch.has(kunci)) petaBatch.set(kunci, batchBaru());
  return petaBatch.get(kunci);
}
const setBatchState = (o) => petaBatch.set(ROOT(), o);

/* ---------- Server lokal (hanya bisa diakses dari PC ini) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
const allowedDirs = () => ['output', 'reports', 'interview-prep'].map((d) => path.join(ROOT(), d) + path.sep);
const url0 = `http://127.0.0.1:${PORT}/output/RINGKASAN-LAMARAN.html`;

async function tanganiRingkasan(req, res, u, mentah, paksa) {
  // AsyncLocalStorage tidak otomatis melekat pada listener EventEmitter yang
  // dipasang di dalam denganKonteks(). Tanpa ini, callback req.on('end', ...)
  // kehilangan root akun dan jatuh ke BASE_ROOT — sehingga POST akun lain
  // menulis CV/preset/tracker milik pemilik. Ikat setiap listener ke konteks
  // request ini. (Handler auth memakai await bacaBody(), tidak terkena.)
  const ctxReq = konteksAktif();
  if (ctxReq) {
    const onAsli = req.on.bind(req);
    req.on = (nama, fn) => {
      // Hanya listener pembaca body milik kita yang perlu diikat; listener
      // internal Node ('close', 'error', ...) dibiarkan apa adanya.
      if (nama !== 'data' && nama !== 'end') return onAsli(nama, fn);
      return onAsli(nama, function (...args) {
        return denganKonteks(ctxReq, () => fn.apply(this, args));
      });
    };
  }
  // Browser meminta /favicon.ico otomatis; jawab 204 supaya console tetap bersih.
  if (req.method === 'GET' && u === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'GET' && u === '/output/RINGKASAN-LAMARAN.html') {
    if (process.env.RINGKASAN_LOG) console.log(`[minta] ${new Date().toLocaleTimeString()} dari ${req.socket.remoteAddress}`);
    try { await buildIfNeeded(paksa); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Gagal membuat ringkasan: ' + e.message); }
    // Token CSRF, nama akun, dan sisa kredit berbeda tiap sesi, jadi disuntikkan
    // saat disajikan. Berkas HTML di disk sengaja tidak menyimpan ketiganya.
    try {
      const mk = bacaModeKirim(BASE_ROOT, penggunaAktif()?.id, rootPengguna());
      const batasTeks = Number.isFinite(mk.batasHarian) ? String(mk.batasHarian) : 'tanpa batas';
      const sisaTeks = Number.isFinite(mk.sisaHarian) ? String(mk.sisaHarian) : 'tanpa batas';
      const modePendek = mk.otomatis
        ? `SiapLamar mengirim otomatis, maks ${batasTeks} lamaran per hari (sisa ${sisaTeks}). Anda tetap memantau di Chrome.`
        : 'SiapLamar menyiapkan; Anda yang menekan kirim di Chrome.';
      const modeTooltip = mk.otomatis
        ? `Lowongan yang siap masuk antrean kirim otomatis, maks ${batasTeks} lamaran per hari.`
        : 'Lowongan yang siap dibuka antreannya. SiapLamar menyiapkan CV dan jawaban; Anda yang menekan kirim di Chrome.';
      const modePanjang = mk.otomatis
        ? `Berurutan: buka lowongan, isi jawaban, lalu kirim otomatis maks ${batasTeks} lamaran per hari (sisa hari ini ${sisaTeks}). Antrean berhenti bila ada halaman yang perlu jawaban atau dokumen tidak cocok. Jeda acak 50-70 detik dan istirahat 2-3 menit tiap 5 lamaran.`
        : 'Berurutan: buka lowongan, isi jawaban, lalu <strong>berhenti sebelum tombol kirim</strong>. Anda yang memeriksa dan menekan kirim di Chrome, lalu mencentang sudah dilamar. Tanpa kuota harian; jeda acak 50-70 detik dan istirahat 2-3 menit tiap 5 lamaran.';
      const modeKonfirmasi = mk.otomatis
        ? `Setiap lowongan dibuka berurutan. Untuk akun isi ulang, SiapLamar menekan tombol kirim otomatis, maksimal ${batasTeks} lamaran per hari (sisa hari ini ${sisaTeks}). Antrean berhenti bila ada halaman yang perlu jawaban. Anda tetap bisa memantau dan menghentikan proses.`
        : 'Setiap lowongan dibuka berurutan dan jawabannya disiapkan. SiapLamar TIDAK menekan tombol kirim: Anda yang memeriksa lalu menekan kirim sendiri di Chrome, kemudian mencentang sudah dilamar. Antara dua lamaran ada jeda acak 50-70 detik dan istirahat 2-3 menit tiap 5 lamaran. Kalau ada halaman yang perlu jawaban, antrean berhenti dan menunggu Anda.';
      const jsStr = (s) => JSON.stringify(s).slice(1, -1);
      const teks = fs.readFileSync(outFile(), 'utf8')
        .replaceAll('__CSRF_TOKEN__', csrfAktif())
        .replaceAll('__NAMA_PENGGUNA__', escHtml(penggunaAktif()?.nama || 'Pengguna'))
        .replaceAll('__SISA_KUOTA__', escHtml(kuotaSaatIni().label))
        .replaceAll('__MODE_KIRIM_PENDEK__', escHtml(modePendek))
        .replaceAll('__MODE_KIRIM_TOOLTIP__', escHtml(modeTooltip))
        .replaceAll('__MODE_KIRIM_PANJANG__', modePanjang)
        .replaceAll('__MODE_KIRIM_KONFIRMASI__', jsStr(modeKonfirmasi));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
      return res.end(teks);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Gagal menyajikan halaman: ' + e.message);
    }
  }
  if (req.method === 'GET' && u === '/') { res.writeHead(302, { Location: '/output/RINGKASAN-LAMARAN.html' }); return res.end(); }
  if (req.method === 'POST' && u === '/lamar') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', async () => {
      let out;
      try {
        const o = JSON.parse(b || '{}');
        const akunId = penggunaAktif()?.id;
        const mode = bacaModeKirim(BASE_ROOT, akunId, rootPengguna());
        if (!bisaPakai(BASE_ROOT, akunId, 1)) {
          throw new Error('Kredit habis. Buka /kuota untuk melihat sisa dan riwayat pemakaian.');
        }
        if (mode.otomatis && mode.sisaHarian < 1) {
          throw new Error(`Batas harian kirim otomatis (${mode.batasHarian}) sudah tercapai. Besok bisa lagi, atau kirim manual lewat Chrome sekarang.`);
        }
        out = await bukaLamaran(o.num, { kirimOtomatis: mode.otomatis });
        if (out && out.ok) {
          const catat = catatPemakaian(BASE_ROOT, akunId, {
            root: rootPengguna(),
            kunci: kunciLamar(o.num),
            keterangan: `Lamaran #${o.num ?? '-'}`,
          });
          if (!catat.ok) out.peringatanKuota = catat.error;
          out.sisaKredit = catat.sisa;
          out.modeKirim = mode.otomatis ? `Otomatis (${mode.batasHarian}/hari)` : 'Manual';
          out.sisaHarian = mode.sisaHarian;
          if (mode.otomatis && !catat.sudahAda && out.dilamar) {
            catatKirimOtomatis(rootPengguna(), 1);
            out.sisaHarian = Math.max(0, mode.sisaHarian - 1);
          }
        }
      } catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && u === '/profil') {
    let out;
    try { out = daftarProfil(rootPengguna()); }
    catch (e) { out = { ok: false, error: e.message }; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (req.method === 'POST' && u === '/profil/buat') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try {
        out = buatProfilLokal(rootPengguna(), { nama: o.nama });
        if (out.ok) out.daftar = daftarProfil(rootPengguna());
      } catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && u === '/profil/pakai') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', async () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try {
        if (batchState().berjalan) throw new Error('Selesaikan atau hentikan otomatisasi sebelum mengganti profil.');
        const hasil = pakaiProfilLokal(rootPengguna(), o.id);
        if (!hasil.ok) throw new Error(hasil.error);
        petaSignature.delete(ROOT());
        simpanScanBerkas({ total: 0, dibuat: 0, gagal: 0 });
        tetapkanRoot(hasil.profil.rootAktual);
        await buildIfNeeded(true);
        out = { ok: true, profil: hasil.profil, daftar: daftarProfil(rootPengguna()) };
      } catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && u === '/cv') {
    let out;
    try {
      out = { ok: true, ...bacaStatusCv(ROOT()) };
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (req.method === 'GET' && u === '/cv/isi') {
    const q = new URL(req.url, 'http://127.0.0.1');
    let out;
    try {
      out = bacaIsiCv(ROOT(), q.searchParams.get('id') || '');
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  // Unggah PDF: teks dibaca lokal, dirapikan, lalu dikembalikan untuk
  // dipratinjau. Tidak ada penulisan cv.md di sini dan PDF tidak disimpan.
  if (u === '/cv/pdf') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let out;
    try {
      const o = JSON.parse(await bacaBody(req, 12 * 1024 * 1024) || '{}');
      const basis = String(o.pdf || '').replace(/\s/g, '');
      if (!basis || !/^[A-Za-z0-9+/]+={0,2}$/.test(basis)) throw new Error('Berkas PDF tidak sah.');
      const pdf = Buffer.from(basis, 'base64');
      if (!pdf.length) throw new Error('PDF kosong.');
      if (pdf.length > 10 * 1024 * 1024) throw new Error('PDF terlalu besar. Maksimal 10 MB.');
      out = cvDariTeks(await ekstrakTeksPdf(pdf), o.nama || '');
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (req.method === 'POST' && u === '/cv/pratinjau') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try {
        out = pratinjauCv(ROOT(), { id: o.id, teks: o.teks, nama: o.nama });
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && u === '/cv/simpan') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try {
        out = simpanCv(ROOT(), {
          token: o.token,
          konfirmasi: o.konfirmasi === true,
          id: o.id,
          teks: o.teks,
          nama: o.nama,
          sumber: o.sumber || 'tempel',
        });
        if (out.ok) out.status = bacaStatusCv(ROOT());
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && u === '/cv/cek') {
    let out;
    try {
      out = cekCv(ROOT());
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (req.method === 'POST' && u === '/cv/entri/pratinjau') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try {
        out = pratinjauEntri(ROOT(), o);
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && u === '/cv/entri/simpan') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try {
        out = simpanEntri(ROOT(), {
          token: o.token,
          konfirmasi: o.konfirmasi === true,
          ...(o.payload || {}),
        });
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && u === '/cv/skill-gap') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try {
        out = skillGap(ROOT(), o.jd);
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && u === '/lamar-status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(batchState()));
  }
  if (req.method === 'GET' && u === '/lamar-dilamar') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ nums: daftarDilamarBaru(), scan: daftarScanDilamar(), ditutup: daftarScanDitutup() }));
  }
  if (req.method === 'POST' && u === '/lamar-scan-tandai') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      tandaiScanDilamar(o.scanId, o.applied !== false);
      if (o.applied === false) tandaiScanDitutup(o.scanId, false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, daftar: daftarScanDilamar(), ditutup: daftarScanDitutup() }));
    });
    return;
  }
  if (req.method === 'POST' && u === '/lamar-semua') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (batchState().berjalan) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(batchState()));
      }
      let opsi = {};
      try { opsi = b ? JSON.parse(b) : {}; } catch { opsi = {}; }
      const k = kuotaSaatIni();
      const akunId = penggunaAktif()?.id;
      const mode = bacaModeKirim(BASE_ROOT, akunId, rootPengguna());
      if (!k.takTerbatas && k.sisa < 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Kredit habis. Buka /kuota untuk melihat sisa dan riwayat pemakaian.', sisaKredit: 0 }));
      }
      if (mode.otomatis && mode.sisaHarian < 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: false, sisaKredit: k.sisa, sisaHarian: 0,
          error: `Batas harian kirim otomatis (${mode.batasHarian}) sudah tercapai. Besok bisa lagi; untuk sekarang kirim manual lewat tombol Lamar.`,
        }));
      }
      const opsiMaks = Number(opsi.maks);
      let pilihanMaks = Number.isFinite(opsiMaks) && opsiMaks > 0 ? { maks: Math.floor(opsiMaks) } : {};
      let dibatasiKuota = false;
      if (!k.takTerbatas && (!pilihanMaks.maks || pilihanMaks.maks > k.sisa)) {
        pilihanMaks = { maks: k.sisa };
        dibatasiKuota = true;
      }
      let dibatasiHarian = false;
      if (mode.otomatis && (!pilihanMaks.maks || pilihanMaks.maks > mode.sisaHarian)) {
        pilihanMaks = { maks: mode.sisaHarian };
        dibatasiHarian = true;
      }
      const modeLabel = mode.otomatis
        ? `Otomatis, maks ${Number.isFinite(mode.batasHarian) ? mode.batasHarian : '∞'} lamaran/hari (sisa ${Number.isFinite(mode.sisaHarian) ? mode.sisaHarian : '∞'})`
        : 'Manual — Anda yang menekan Kirim di Chrome';
      setBatchState({ berjalan: true, selesai: false, tahap: 'persiapan', total: 0, diproses: 0, hasil: [], pesan: `Menyiapkan antrean (${modeLabel})...`, modeKirim: modeLabel });
      lamarSemua({ minScore: MIN, ...pilihanMaks, kirimOtomatis: mode.otomatis, onProgres: (k) => { setBatchState({ ...batchState(), ...k, berjalan: k.tahap !== 'selesai' }); } })
        .then((out) => {
          const berhenti = out.hasil.filter((h) => h.jeda || h.berhenti || h.status === 'butuh-jawaban' || h.status === 'butuh-lanjut' || h.status === 'cv-tidak-cocok' || h.status === 'surat-tidak-cocok');
          let alasan = berhenti[0] && berhenti[0].jeda ? 'butuh jawabanmu di Chrome' : 'perlu diperiksa di Chrome';
          if (berhenti[0]) {
            if (berhenti[0].status === 'butuh-jawaban') alasan = 'butuh jawabanmu di Chrome (direkam untuk lowongan berikutnya)';
            else if (berhenti[0].status === 'butuh-lanjut') alasan = 'klik Lanjut/Kirim di Chrome, lalu periksa status lamaran';
            else if (berhenti[0].status === 'cv-tidak-cocok') alasan = 'CV tidak cocok, lamaran tidak dikirim';
            else if (berhenti[0].status === 'surat-tidak-cocok') alasan = 'surat lamaran tidak cocok, lamaran tidak dikirim';
          }
          let sisaKredit = kuotaSaatIni().sisa;
          let autoTercatat = 0;
          for (const h of (out.hasil || [])) {
            if (h.skip || h.ok !== true) continue;
            const target = h.num || h.scanId;
            const catat = catatPemakaian(BASE_ROOT, akunId, {
              root: rootPengguna(),
              kunci: kunciLamar(target),
              keterangan: `Lamaran #${target ?? '-'}${h.company ? ' — ' + h.company : ''}`,
            });
            if (catat.ok) {
              sisaKredit = catat.sisa;
              if (mode.otomatis && !catat.sudahAda && h.dilamar) {
                catatKirimOtomatis(rootPengguna(), 1);
                autoTercatat++;
              }
            }
          }
          out.sisaKredit = sisaKredit;
          out.modeKirim = modeLabel;
          out.sisaHarian = mode.otomatis ? Math.max(0, mode.sisaHarian - autoTercatat) : null;
          const catatanKuota = dibatasiKuota ? ` Dibatasi ${pilihanMaks.maks} kredit yang tersedia.` : '';
          const catatanHarian = dibatasiHarian ? ` Dibatasi ${pilihanMaks.maks} kirim otomatis hari ini.` : '';
          setBatchState({
            berjalan: false, selesai: true, tahap: 'selesai',
            total: out.total, diproses: out.diproses, hasil: out.hasil,
            modeKirim: modeLabel, sisaHarian: out.sisaHarian,
            pesan: (out.dry
              ? `Mode uji: ${out.total} lowongan siap dilamar, tidak ada yang dikirim.`
              : berhenti.length
              ? `Berhenti di #${berhenti[0].num}: ${alasan}. Setelah selesai, klik Lamar otomatis lagi.`
              : `Selesai: ${out.diproses} diproses dari ${out.total} lowongan yang siap.`) + catatanKuota + catatanHarian,
          });
        })
        .catch((e) => { setBatchState({ ...batchState(), berjalan: false, selesai: true, pesan: 'Gagal: ' + e.message }); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batchState()));
    });
    return;
  }
  if (req.method === 'POST' && u === '/scan-baru') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', async () => {
      let out;
      try {
        out = await jalankanScan(JSON.parse(b || '{}'));
        if (out.ok) {
          // Tunggu halaman selesai dibuat ulang sebelum membalas, supaya reload
          // di browser langsung menampilkan baris lowongan hasil scan.
          try { await buildIfNeeded(true); }
          catch (e) { out.peringatan = (out.peringatan || '') + ' Gagal menyegarkan halaman: ' + e.message; }
          out.berkas = { ...terakhirScanBerkas() };
        }
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && u === '/targeting-cv') {
    let out;
    try {
      const t = bacaTargeting(ROOT());
      out = { ...t, ok: t.ok !== false, ringkasan: ringkasanTargeting(t) };
    } catch (e) {
      out = { ok: false, error: e.message, kataKunci: [], provinsi: [], kota: {}, kotaLain: [], peringatan: [] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (req.method === 'POST' && u === '/targeting-cv/simpan') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try { out = simpanTargeting(ROOT(), o); }
      catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && u === '/scan-preset') {
    const q = new URL(req.url, 'http://127.0.0.1');
    let out;
    try {
      out = q.searchParams.get('baca')
        ? bacaPreset(ROOT(), q.searchParams.get('baca'))
        : daftarPreset(ROOT());
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (req.method === 'POST' && u === '/scan-preset/simpan') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try { out = simpanPreset(ROOT(), o); }
      catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && u === '/scan-preset/hapus') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let o = {};
      try { o = b ? JSON.parse(b) : {}; } catch { o = {}; }
      let out;
      try { out = hapusPreset(ROOT(), o.id); }
      catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && u === '/toggle') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let out;
      try { const { num, applied } = JSON.parse(b); out = toggleApplied(num, !!applied); }
      catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET') {
    const f = path.normalize(path.join(ROOT(), u));
    if (allowedDirs().some((a) => f.startsWith(a)) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const lamaran = path.extname(f).toLowerCase();
      const kepala = { 'Content-Type': MIME[lamaran] || 'application/octet-stream' };
      // Halaman ringkasan tidak boleh dilayani dari cache: F5 harus selalu
      // menampilkan data terbaru dari tracker.
      if (lamaran === '.html') kepala['Cache-Control'] = 'no-store, must-revalidate';
      res.writeHead(200, kepala);
      return res.end(fs.readFileSync(f));
    }
  }
  res.writeHead(404); res.end('Tidak ditemukan');
}

/* ---------- Fase 5: login, sesi, CSRF, isolasi per akun ---------- */
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function cookieToken(req) {
  const mentahCookie = req.headers.cookie || '';
  for (const bagian of mentahCookie.split(';')) {
    const potong = bagian.indexOf('=');
    if (potong < 0) continue;
    if (bagian.slice(0, potong).trim() === 'rk_sid') return decodeURIComponent(bagian.slice(potong + 1).trim());
  }
  return '';
}

function httpsAktif(req) {
  const depan = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http'));
  return depan.split(',')[0].trim().toLowerCase() === 'https';
}

const alamatIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-').split(',')[0].trim();

/* CSRF untuk halaman publik (belum punya sesi): cookie rk_pub + token di form.
   Penyerang lintas situs tidak bisa membaca cookie kita, jadi tidak bisa
   menempelkan token yang cocok di form buatannya. */
function cookiePublik(req) {
  for (const bagian of (req.headers.cookie || '').split(';')) {
    const potong = bagian.indexOf('=');
    if (potong < 0) continue;
    if (bagian.slice(0, potong).trim() === 'rk_pub') {
      return decodeURIComponent(bagian.slice(potong + 1).trim());
    }
  }
  return '';
}
const CSRF_PUBLIK_VALID = /^[a-f0-9]{64}$/;
function csrfPublik(req, res) {
  const ada = cookiePublik(req);
  if (CSRF_PUBLIK_VALID.test(ada)) return ada;
  const token = crypto.randomBytes(32).toString('hex');
  res.setHeader('Set-Cookie', `rk_pub=${token}; Path=/; HttpOnly; SameSite=Lax${httpsAktif(req) ? '; Secure' : ''}`);
  return token;
}
function csrfPublikSah(req, nilai) {
  const cookie = cookiePublik(req);
  const kiriman = String(nilai || '');
  if (!CSRF_PUBLIK_VALID.test(cookie) || !CSRF_PUBLIK_VALID.test(kiriman)) return false;
  return crypto.timingSafeEqual(Buffer.from(cookie, 'hex'), Buffer.from(kiriman, 'hex'));
}

function arahkan(res, tujuan, kepalaTambahan = {}) {
  res.writeHead(302, Object.assign({ Location: tujuan, 'Cache-Control': 'no-store' }, kepalaTambahan));
  return res.end();
}

function bacaBody(req, maks = 100000) {
  return new Promise((resolve, reject) => {
    let isi = '';
    req.on('data', (d) => {
      isi += d;
      if (isi.length > maks) reject(new Error('Permintaan terlalu besar.'));
    });
    req.on('end', () => resolve(isi));
    req.on('error', reject);
  });
}

const GAYA_AUTH = `
  :root { color-scheme: light; font-family: 'Segoe UI', system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f1f5f9; color: #0f172a; }
  .kartu { width: min(420px, calc(100% - 32px)); background: #fff; border: 1px solid #e2e8f0;
    border-radius: 16px; box-shadow: 0 12px 40px rgba(15,23,42,.08); padding: 28px; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p { color: #64748b; font-size: .88rem; margin: 0 0 20px; line-height: 1.5; }
  label { display: block; font-size: .82rem; font-weight: 600; margin: 14px 0 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 9px; font: inherit; font-size: .92rem; }
  button { margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 9px;
    background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .pesan { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; border-radius: 9px;
    padding: 10px 12px; font-size: .84rem; margin-bottom: 14px; }
  .sukses { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; border-radius: 9px;
    padding: 10px 12px; font-size: .84rem; margin-bottom: 14px; line-height: 1.5; }
  .petunjuk { color: #475569; font-size: .8rem; margin-top: 18px; line-height: 1.6; }
  .petunjuk a, .kembali { color: #2563eb; }
  .kode { font-size: 1.4rem; letter-spacing: .35em; text-align: center; font-weight: 700;
    background: #eff6ff; border: 1px dashed #93c5fd; color: #1e3a8a;
    padding: 14px; border-radius: 10px; margin: 14px 0; font-variant-numeric: tabular-nums; }
  .ringkas { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; margin-bottom: 16px; }
  .ringkas .besar { font-size: 2rem; font-weight: 700; color: #1d4ed8; line-height: 1; }
  .ringkas .kecil { color: #64748b; font-size: .82rem; }
  .riwayat { list-style: none; padding: 0; margin: 0; }
  .riwayat li { border-bottom: 1px solid #e2e8f0; padding: 9px 0; font-size: .84rem; }
  .riwayat li:last-child { border-bottom: 0; }
  .riwayat .t { color: #64748b; font-size: .76rem; display: block; margin-top: 2px; }
  .minus { color: #b91c1c; font-weight: 700; }
  .plus { color: #15803d; font-weight: 700; }
  .paket { display: flex; align-items: center; gap: 10px; border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 10px 12px; margin: 8px 0; cursor: pointer; }
  .paket.utama { border-color: #93c5fd; background: #eff6ff; }
  .paket input { width: auto; margin: 0; }
  .paket strong { display: block; font-size: .88rem; }
  .paket small { display: block; color: #64748b; font-size: .78rem; margin-top: 2px; }
  #bayarStatus { font-size: .82rem; margin-top: 10px; min-height: 1.2em; color: #334155; }
`;

// Draf Syarat/Privasi/Panduan Beta belum disetujui pemilik. Selama belum,
// halaman publik hanya menampilkan pemberitahuan — berkas aslinya tetap ada
// di output/ dan bisa dibaca langsung di komputer ini.
const DOKUMEN_DITAWANGKAN = process.env.CAREER_OPS_DOCS_PUBLISH === '1';
const dokumenTautan = DOKUMEN_DITAWANGKAN
  ? `Dokumen uji tertutup: <a href="/syarat">Syarat Penggunaan</a> · <a href="/privasi">Kebijakan Privasi</a> · <a href="/panduan-beta">Panduan Peserta Beta</a>`
  : 'Dokumen Syarat, Privasi, dan Panduan Beta sedang ditinjau pemilik dan belum ditayangkan.';

function halamanDokumenMenunggu() {
  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dokumen sedang ditinjau — SiapLamar</title><style>${GAYA_AUTH}</style></head>
<body><main class="kartu"><h1>Dokumen sedang ditinjau</h1>
<p>Syarat Penggunaan, Kebijakan Privasi, dan Panduan Beta belum disetujui pemilik, jadi belum ditayangkan di alamat publik.</p>
<p class="petunjuk"><a href="/login">Kembali ke masuk</a></p></main></body></html>`;
}

function halamanAuth({ judul, deskripsi, isi, pesan = '', sukses = '' }) {
  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${escHtml(csrfAktif())}">
<title>${escHtml(judul)} — SiapLamar</title><style>${GAYA_AUTH}</style></head>
<body><main class="kartu">
<h1>${escHtml(judul)}</h1><p>${escHtml(deskripsi)}</p>
${sukses ? `<div class="sukses" role="status">${escHtml(sukses)}</div>` : ''}
${pesan ? `<div class="pesan" role="alert">${escHtml(pesan)}</div>` : ''}
${isi}
<p class="petunjuk" style="margin-top:18px;border-top:1px solid #e2e8f0;padding-top:12px">
${dokumenTautan}
</p>
</main></body></html>`;
}

function halamanLogin(pesan = '', csrf = '', sukses = '') {
  return halamanAuth({
    judul: 'Masuk ke SiapLamar',
    deskripsi: 'Data lamaran, CV, dan hasil scan Anda hanya tersedia untuk akun ini.',
    pesan, sukses,
    isi: `<form method="post" action="/login">
<input type="hidden" name="_csrf" value="${escHtml(csrf)}">
<label for="pengguna">Nama akun</label>
<input id="pengguna" name="pengguna" autocomplete="username" required autofocus>
<label for="sandi">Kata sandi</label>
<input id="sandi" name="sandi" type="password" autocomplete="current-password" required>
<button type="submit">Masuk</button>
</form><p class="petunjuk">Belum punya akun? <a href="/daftar">Daftar gratis dengan email</a> — dapat 3 kredit trial setelah verifikasi.<br><a href="/lupa-sandi">Lupa kata sandi?</a></p>`,
  });
}

function halamanDaftar(pesan = '', csrf = '') {
  const emailSiap = statusEmail().aktif;
  return halamanAuth({
    judul: 'Coba gratis SiapLamar',
    deskripsi: 'Uji tertutup: pakai kode undangan, verifikasi email, langsung dapat 3 kredit lamaran.',
    pesan,
    isi: `<form method="post" action="/daftar">
<input type="hidden" name="_csrf" value="${escHtml(csrf)}">
<label for="undangan">Kode undangan</label>
<input id="undangan" name="undangan" type="text" placeholder="SL-XXXXXX-XXXX" autocomplete="off" spellcheck="false" pattern="[SLsl0-9-]{11,32}" required autofocus>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required>
<label for="sandi">Kata sandi</label>
<input id="sandi" name="sandi" type="password" autocomplete="new-password" minlength="10" required>
<button type="submit">Daftar &amp; kirim kode</button>
</form><p class="petunjuk">Pendaftaran hanya untuk pemegang kode undangan. Satu email mendapat satu trial. Tanpa kartu pembayaran. ${
    emailSiap
      ? 'Kode verifikasi dikirim ke email Anda. Periksa kotak masuk dan folder spam.'
      : 'Provider email belum dikonfigurasi, jadi kode verifikasi ditampilkan di halaman (mode uji).'
  }<br><a href="/login">Sudah punya akun? Masuk</a></p>`,
  });
}

function halamanVerifikasi(email, kode = '', pesan = '', csrf = '') {
  return halamanAuth({
    judul: 'Verifikasi email',
    deskripsi: `Masukkan kode 6 digit untuk ${email || 'email Anda'}.`,
    pesan,
    isi: `${kode ? `<div class="kode" aria-label="Kode verifikasi mode uji">${escHtml(kode)}</div>` : ''}
<form method="post" action="/verifikasi">
<input type="hidden" name="_csrf" value="${escHtml(csrf)}">
<input type="hidden" name="email" value="${escHtml(email)}">
<label for="kode">Kode verifikasi</label>
<input id="kode" name="kode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required autofocus>
<button type="submit">Verifikasi &amp; masuk</button>
</form>
<form method="post" action="/verifikasi/kirim-ulang">
<input type="hidden" name="_csrf" value="${escHtml(csrf)}">
<input type="hidden" name="email" value="${escHtml(email)}">
<button type="submit" style="background:#e2e8f0;color:#0f172a">Kirim kode baru</button>
</form>
<p class="petunjuk">Kode berlaku 10 menit. Setelah verifikasi, 3 kredit trial langsung tersedia.<br><a href="/daftar">Daftar ulang</a> · <a href="/login">Kembali ke masuk</a></p>`,
  });
}

function halamanLupaSandi(pesan = '', csrf = '', info = {}) {
  return halamanAuth({
    judul: 'Lupa kata sandi',
    deskripsi: 'Masukkan email akun SiapLamar Anda. Kami kirim tautan untuk membuat kata sandi baru.',
    pesan,
    sukses: info.sukses || '',
    isi: `<form method="post" action="/lupa-sandi">
<input type="hidden" name="_csrf" value="${escHtml(csrf)}">
<label for="email">Email akun</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus>
<button type="submit">Kirim tautan atur ulang</button>
</form>
${info.uji ? `<div class="petunjuk">Mode uji — tautan: <a href="${escHtml(info.uji)}">${escHtml(info.uji)}</a></div>` : ''}
<p class="petunjuk">Tautan berlaku 30 menit dan hanya bisa dipakai sekali. Bila email tidak sampai, periksa folder spam.<br><a href="/login">← Kembali ke masuk</a></p>`,
  });
}

function halamanResetSandi(token, pesan = '', csrf = '') {
  return halamanAuth({
    judul: 'Buat kata sandi baru',
    deskripsi: 'Pilih kata sandi baru untuk akun SiapLamar Anda.',
    pesan,
    isi: `<form method="post" action="/reset-sandi">
<input type="hidden" name="_csrf" value="${escHtml(csrf)}">
<input type="hidden" name="token" value="${escHtml(token)}">
<label for="baru">Kata sandi baru</label>
<input id="baru" name="baru" type="password" autocomplete="new-password" minlength="10" required autofocus>
<label for="ulang">Ulangi kata sandi baru</label>
<input id="ulang" name="ulang" type="password" autocomplete="new-password" minlength="10" required>
<button type="submit">Simpan kata sandi</button>
</form><p class="petunjuk">Minimal 10 karakter. Setelah disimpan, semua sesi lama otomatis keluar.<br><a href="/login">Kembali ke masuk</a></p>`,
  });
}

function halamanKuota(csrf, k, riwayat, akun, info = {}) {
  const bayar = info.pembayaran || statusPembayaran();
  const paket = info.paket || daftarPaket();
  const riwayatBayar = info.riwayatBayar || [];
  const mode = info.modeKirim || null;
  const modeTeks = !mode ? '' : mode.otomatis
    ? `Otomatis — maks ${Number.isFinite(mode.batasHarian) ? mode.batasHarian : '∞'} lamaran/hari, sisa hari ini ${Number.isFinite(mode.sisaHarian) ? mode.sisaHarian : '∞'}`
    : 'Manual (trial) — SiapLamar menyiapkan CV dan jawaban; Anda yang menekan Kirim di Chrome';
  const paketTeks = paket.map((p) =>
    `${p.kredit} kredit Rp ${p.harga.toLocaleString('id-ID')}${p.bulanan ? '/bln' : ''}`).join(' · ');
  const baris = (riwayat || []).map((r) => `<li>
<span class="${r.perubahan < 0 ? 'minus' : 'plus'}">${r.perubahan < 0 ? '−' : '+'}${Math.abs(r.perubahan)}</span>
${escHtml(r.keterangan || r.kunci || 'Pemakaian')}
<span class="t">${escHtml(r.waktu || 'tanpa tanggal')}${r.sisa ? ` · sisa ${escHtml(r.sisa)}` : ''}</span>
</li>`).join('') || '<li><span class="muted">Belum ada pemakaian.</span></li>';
  const pilihan = paket.map((p) => `<label class="paket${p.utama ? ' utama' : ''}">
<input type="radio" name="paket" value="${escHtml(p.id)}"${p.utama ? ' checked' : ''}>
<span><strong>${escHtml(p.nama)}</strong><small>Rp ${p.harga.toLocaleString('id-ID')}${p.bulanan ? ' / bulan' : ''} · ${p.kredit} kredit${p.bulanan ? ' / bulan' : ''}</small></span>
</label>`).join('');
  const bayarHtml = riwayatBayar.length ? riwayatBayar.map((r) => `<li>
<strong>${escHtml(r.paket || 'Paket')}</strong> — Rp ${Number(r.harga || 0).toLocaleString('id-ID')}
<span class="t">${escHtml(r.waktu || 'tanpa tanggal')} · ${escHtml(r.status || '—')} · order ${escHtml(r.orderId || '-')}</span>
</li>`).join('') : '<li><span class="muted">Belum ada transaksi.</span></li>';
  const skrip = bayar.aktif ? `<script src="${escHtml(bayar.snapJs)}" data-client-key="${escHtml(bayar.clientKey)}"></script>
<script>
(() => {
  const statusEl = document.getElementById('bayarStatus');
  const csrf = document.getElementById('bayarCsrf').value;
  document.getElementById('bayarJalankan').addEventListener('click', async () => {
    const dipilih = document.querySelector('input[name="paket"]:checked');
    if (!dipilih) { statusEl.textContent = 'Pilih paket dahulu.'; return; }
    statusEl.textContent = 'Menyiapkan pembayaran...';
    try {
      const r = await fetch('/pembayaran/buat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ paketId: dipilih.value }),
      });
      const j = await r.json();
      if (!j.ok) { statusEl.textContent = 'Gagal: ' + (j.error || 'tidak diketahui'); return; }
      if (!window.snap) { statusEl.textContent = 'Snap belum termuat. Segarkan halaman lalu coba lagi.'; return; }
      window.snap.pay(j.token, {
        onSuccess: () => {
          statusEl.textContent = 'Pembayaran berhasil. Kredit ditambahkan setelah konfirmasi Midtrans diterima.';
          setTimeout(() => location.reload(), 3000);
        },
        onPending: () => { statusEl.textContent = 'Menunggu pembayaran. Kuota berubah setelah konfirmasi.'; },
        onError: () => { statusEl.textContent = 'Pembayaran gagal.'; },
        onClose: () => { statusEl.textContent = 'Jendela pembayaran ditutup.'; },
      });
    } catch (e) { statusEl.textContent = 'Gagal menghubungi server: ' + e.message; }
  });
})();
</script>` : '';
  return halamanAuth({
    judul: 'Kuota lamaran',
    deskripsi: `Akun: ${akun?.nama || '-'}`,
    isi: `<input type="hidden" id="bayarCsrf" value="${escHtml(csrf)}">
<div class="ringkas">
<div class="besar">${k.takTerbatas ? '∞' : escHtml(String(k.sisa))}</div>
<div class="kecil">${k.takTerbatas ? 'Kredit tanpa batas (akun pemilik)' : 'kredit tersisa'} · paket ${escHtml(k.paket || '-')}</div>
${modeTeks ? `<div class="kecil" style="margin-top:4px">Mode kirim: ${escHtml(modeTeks)}</div>` : ''}
</div>
<p class="petunjuk" style="margin-top:0">
<strong>Aturan pemakaian:</strong><br>
1 kredit = 1 lowongan yang diproses lewat tombol Lamar / Lamar Semua Siap. Scan, filter, preset, detail lowongan, dan ganti profil tidak memotong kredit. Lowongan yang sama tidak dipotong dua kali. Gagal sebelum browser dibuka tidak dipotong.<br><br>
<strong>Harga:</strong> Trial 3 kredit gratis · ${escHtml(paketTeks)}. Kredit berlaku 90 hari. Paket bulanan saat ini menambah 40 kredit sekali bayar; perpanjangan otomatis belum diaktifkan.<br><br>
Tidak ada jaminan interview atau offer. Pengiriman otomatis hanya tersedia setelah isi ulang, dijalankan dari antrean dengan batas harian; dari halaman kuota ini tidak ada tombol kirim.
</p>
<h2 style="font-size:1rem;margin:18px 0 6px">Isi ulang kredit</h2>
${bayar.aktif ? `<p class="petunjuk" style="margin-top:0">Midtrans mode <strong>${escHtml(bayar.mode)}</strong>. Nomor kartu tidak disimpan di sini; Snap Midtrans yang memproses pembayaran.</p>` : `<p class="petunjuk" style="margin-top:0">Pembayaran belum tersedia (${escHtml(bayar.alasan)}). Pilihan di bawah masih ditampilkan sebagai rencana, belum bisa dibeli.</p>`}
<div>${pilihan}</div>
<button type="button" id="bayarJalankan"${bayar.aktif ? '' : ' disabled'}>Beli / isi ulang</button>
<div id="bayarStatus">${bayar.aktif ? '' : 'Menunggu konfigurasi Midtrans.'}</div>
<h2 style="font-size:1rem;margin:18px 0 6px">Riwayat pembayaran</h2>
<ul class="riwayat">${bayarHtml}</ul>
<h2 style="font-size:1rem;margin:18px 0 6px">Riwayat pemakaian kredit</h2>
<ul class="riwayat">${baris}</ul>
<p class="petunjuk"><a class="kembali" href="/output/RINGKASAN-LAMARAN.html">← Kembali ke ringkasan</a></p>
<form method="post" action="/logout">
<input type="hidden" name="_csrf" value="${escHtml(csrf)}">
<button type="submit">Keluar</button>
</form>${skrip}`,
  });
}

function halamanGantiSandi(csrf, pesan = '') {
  return halamanAuth({
    judul: 'Ganti kata sandi',
    deskripsi: 'Kata sandi awal bersifat sementara. Ganti sekarang sebelum membuka data.',
    pesan,
    isi: `<form method="post" action="/ganti-sandi">
<input type="hidden" name="_csrf" value="${escHtml(csrf)}">
<label for="lama">Kata sandi sementara</label>
<input id="lama" name="lama" type="password" autocomplete="current-password" required autofocus>
<label for="baru">Kata sandi baru</label>
<input id="baru" name="baru" type="password" autocomplete="new-password" minlength="10" required>
<label for="ulang">Ulangi kata sandi baru</label>
<input id="ulang" name="ulang" type="password" autocomplete="new-password" minlength="10" required>
<button type="submit">Simpan dan lanjut</button>
</form><p class="petunjuk">Minimal 10 karakter. Gunakan kata sandi yang tidak dipakai di situs lain.</p>`,
  });
}

function kirimHtml(res, status, isi) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(isi);
}

// Dokumen uji tertutup disajikan tanpa sesi hanya setelah pemilik menyetujui
// drafnya (CAREER_OPS_DOCS_PUBLISH=1). Hanya tiga berkas ini, bukan seluruh
// folder output.
const DOKUMEN_PUBLIK = {
  '/syarat': 'syarat.html',
  '/privasi': 'privasi.html',
  '/panduan-beta': 'panduan-beta.html',
};

function kirimDokumenPublik(res, nama) {
  const f = path.join(ROOT(), 'output', nama);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
    res.writeHead(404); return res.end('Tidak ditemukan');
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.end(fs.readFileSync(f));
}

async function tanganiLogin(req, res, u) {
  const q = new URL(req.url, 'http://127.0.0.1').searchParams;
  const sukses = q.get('reset') === '1'
    ? 'Kata sandi berhasil diganti. Silakan masuk dengan kata sandi baru.' : '';
  if (req.method === 'GET') return kirimHtml(res, 200, halamanLogin('', csrfPublik(req, res), sukses));
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = new URLSearchParams(await bacaBody(req));
  if (!csrfPublikSah(req, f.get('_csrf'))) { res.writeHead(403); return res.end('Token CSRF tidak sah.'); }
  if (!izinCoba(alamatIp(req))) {
    return kirimHtml(res, 429, halamanLogin('Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.', csrfPublik(req, res), sukses));
  }
  const akun = cariPenggunaNama(BASE_ROOT, f.get('pengguna'));
  const sandi = f.get('sandi') || '';
  if (!akun || !verifikasiKataSandi(akun, sandi)) {
    catatGagal(alamatIp(req));
    return kirimHtml(res, 401, halamanLogin('Nama akun atau kata sandi salah.', csrfPublik(req, res), sukses));
  }
  hapusGagal(alamatIp(req));
  const { token, csrf } = buatSesi(akun.id, !!akun.harusGanti);
  const tujuan = akun.harusGanti ? '/ganti-sandi' : '/';
  return arahkan(res, tujuan, { 'Set-Cookie': cookieSesi(token, httpsAktif(req)) });
}

async function tanganiDaftar(req, res) {
  if (req.method === 'GET') return kirimHtml(res, 200, halamanDaftar('', csrfPublik(req, res)));
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = new URLSearchParams(await bacaBody(req));
  if (!csrfPublikSah(req, f.get('_csrf'))) { res.writeHead(403); return res.end('Token CSRF tidak sah.'); }
  const kunciIp = 'daftar:' + alamatIp(req);
  if (!izinCoba(kunciIp)) return kirimHtml(res, 429, halamanDaftar('Terlalu banyak percobaan. Coba lagi dalam 15 menit.', csrfPublik(req, res)));
  const kodeUndangan = String(f.get('undangan') || '').trim().toUpperCase();
  const cekUndanganHasil = cekUndangan(BASE_ROOT, kodeUndangan, f.get('email'));
  if (!cekUndanganHasil.ok) {
    catatGagal(kunciIp);
    return kirimHtml(res, 400, halamanDaftar(cekUndanganHasil.error, csrfPublik(req, res)));
  }
  try {
    const hasil = daftarPenggunaEmail(BASE_ROOT, { email: f.get('email'), sandi: f.get('sandi') });
    if (!hasil.ok) {
      catatGagal(kunciIp);
      return kirimHtml(res, 400, halamanDaftar(hasil.error, csrfPublik(req, res)));
    }
    const dipakai = pakaiUndangan(BASE_ROOT, kodeUndangan, hasil.email);
    if (!dipakai.ok) {
      catatGagal(kunciIp);
      return kirimHtml(res, 400, halamanDaftar(dipakai.error, csrfPublik(req, res)));
    }
    hapusGagal(kunciIp);
    const csrf = csrfPublik(req, res);
    const kirim = await kirimKodeVerifikasi(hasil.email, hasil.kode);
    if (kirim.ok) {
      return kirimHtml(res, 200, halamanVerifikasi(hasil.email, '',
        'Kode verifikasi sudah dikirim ke email Anda. Periksa kotak masuk dan folder spam.', csrf));
    }
    if (kirim.modeUji) {
      catatKodeUji(hasil.email, hasil.kode);
      return kirimHtml(res, 200, halamanVerifikasi(hasil.email, hasil.kode,
        `Email belum dikonfigurasi (${kirim.alasan}). Mode uji: kode ditampilkan di bawah.`, csrf));
    }
    console.error('[email] gagal mengirim kode daftar:', kirim.error);
    catatKodeUji(hasil.email, hasil.kode);
    return kirimHtml(res, 200, halamanVerifikasi(hasil.email, hasil.kode,
      'Email gagal dikirim. Kode sengaja ditampilkan di bawah agar alur tetap bisa diuji.', csrf));
  } catch (e) {
    return kirimHtml(res, 400, halamanDaftar(e.message, csrfPublik(req, res)));
  }
}

async function tanganiKirimUlangKode(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = new URLSearchParams(await bacaBody(req));
  if (!csrfPublikSah(req, f.get('_csrf'))) { res.writeHead(403); return res.end('Token CSRF tidak sah.'); }
  const csrf = csrfPublik(req, res);
  const kunciIp = 'ulang:' + alamatIp(req);
  if (!izinCoba(kunciIp)) {
    return kirimHtml(res, 429, halamanVerifikasi('', '',
      'Terlalu banyak permintaan kode baru. Coba lagi dalam 15 menit.', csrf));
  }
  catatGagal(kunciIp);
  try {
    const email = f.get('email') || '';
    const hasil = kirimUlangKodeEmail(BASE_ROOT, email);
    if (!hasil.ok) return kirimHtml(res, 400, halamanVerifikasi(email, '', hasil.error, csrf));
    const kirim = await kirimKodeVerifikasi(hasil.email, hasil.kode);
    if (kirim.ok) {
      return kirimHtml(res, 200, halamanVerifikasi(hasil.email, '',
        'Kode baru sudah dikirim ke email Anda. Periksa kotak masuk dan folder spam.', csrf));
    }
    if (kirim.modeUji) {
      catatKodeUji(hasil.email, hasil.kode);
      return kirimHtml(res, 200, halamanVerifikasi(hasil.email, hasil.kode,
        `Email belum dikonfigurasi (${kirim.alasan}). Kode baru ditampilkan di bawah.`, csrf));
    }
    console.error('[email] gagal mengirim ulang kode:', kirim.error);
    catatKodeUji(hasil.email, hasil.kode);
    return kirimHtml(res, 200, halamanVerifikasi(hasil.email, hasil.kode,
      'Email gagal dikirim. Kode baru sengaja ditampilkan di bawah untuk uji.', csrf));
  } catch (e) {
    return kirimHtml(res, 400, halamanVerifikasi('', '', e.message, csrf));
  }
}

async function tanganiVerifikasi(req, res) {
  const q = new URL(req.url, 'http://127.0.0.1').searchParams;
  if (req.method === 'GET') {
    return kirimHtml(res, 200, halamanVerifikasi(q.get('email') || '', q.get('kode') || '', '', csrfPublik(req, res)));
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = new URLSearchParams(await bacaBody(req));
  if (!csrfPublikSah(req, f.get('_csrf'))) { res.writeHead(403); return res.end('Token CSRF tidak sah.'); }
  const csrf = csrfPublik(req, res);
  const kunciIp = 'verifikasi:' + alamatIp(req);
  if (!izinCoba(kunciIp)) return kirimHtml(res, 429, halamanVerifikasi('', '', 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.', csrf));
  try {
    const email = f.get('email') || '';
    const hasil = verifikasiEmail(BASE_ROOT, email, f.get('kode'));
    if (!hasil.ok) {
      catatGagal(kunciIp);
      return kirimHtml(res, 400, halamanVerifikasi(email, '', hasil.error, csrf));
    }
    hapusGagal(kunciIp);
    const { token } = buatSesi(hasil.pengguna.id, false);
    return arahkan(res, '/', { 'Set-Cookie': cookieSesi(token, httpsAktif(req)) });
  } catch (e) {
    return kirimHtml(res, 400, halamanVerifikasi('', '', e.message, csrf));
  }
}

async function tanganiLupaSandi(req, res) {
  if (req.method === 'GET') return kirimHtml(res, 200, halamanLupaSandi('', csrfPublik(req, res)));
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = new URLSearchParams(await bacaBody(req));
  if (!csrfPublikSah(req, f.get('_csrf'))) { res.writeHead(403); return res.end('Token CSRF tidak sah.'); }
  const csrf = csrfPublik(req, res);
  const kunciIp = 'lupa:' + alamatIp(req);
  if (!izinCoba(kunciIp)) {
    return kirimHtml(res, 429, halamanLupaSandi('Terlalu banyak permintaan. Coba lagi dalam 15 menit.', csrf));
  }
  catatGagal(kunciIp);
  try {
    const hasil = buatTokenLupaSandi(BASE_ROOT, f.get('email'));
    let info = {};
    if (!hasil.ok) {
      // Pesan yang sama untuk email tidak ditemukan, supaya tidak membocorkan akun.
      console.error('[lupa-sandi]', hasil.error);
    } else {
      const kirim = await kirimTautanReset(hasil.email, hasil.token);
      if (!kirim.ok) {
        console.error('[email] gagal mengirim tautan reset:', kirim.error);
        if (kirim.modeUji) info.uji = kirim.tautan;
      }
    }
    hapusGagal(kunciIp);
    return kirimHtml(res, 200, halamanLupaSandi('', csrf, {
      ...info,
      sukses: 'Bila email terdaftar, tautan atur ulang sudah dikirim. Periksa kotak masuk dan folder spam.',
    }));
  } catch (e) {
    return kirimHtml(res, 400, halamanLupaSandi(e.message, csrf));
  }
}

async function tanganiResetSandi(req, res) {
  const q = new URL(req.url, 'http://127.0.0.1').searchParams;
  const tokenDariUrl = q.get('token') || '';
  if (req.method === 'GET') {
    const cek = cariAkunDariTokenLupa(BASE_ROOT, tokenDariUrl);
    if (!cek.ok) {
      return kirimHtml(res, 400, halamanResetSandi('', cek.error, csrfPublik(req, res)));
    }
    return kirimHtml(res, 200, halamanResetSandi(tokenDariUrl, '', csrfPublik(req, res)));
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = new URLSearchParams(await bacaBody(req));
  if (!csrfPublikSah(req, f.get('_csrf'))) { res.writeHead(403); return res.end('Token CSRF tidak sah.'); }
  const csrf = csrfPublik(req, res);
  const token = f.get('token') || '';
  const baru = f.get('baru') || '';
  if (baru !== (f.get('ulang') || '')) {
    return kirimHtml(res, 400, halamanResetSandi(token, 'Kata sandi baru dan ulangannya berbeda.', csrf));
  }
  const kunciIp = 'reset:' + alamatIp(req);
  if (!izinCoba(kunciIp)) {
    return kirimHtml(res, 429, halamanResetSandi(token, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.', csrf));
  }
  try {
    const hasil = setSandiDariLupa(BASE_ROOT, token, baru);
    if (!hasil.ok) {
      catatGagal(kunciIp);
      return kirimHtml(res, 400, halamanResetSandi('', hasil.error, csrf));
    }
    hapusGagal(kunciIp);
    return arahkan(res, '/login?reset=1');
  } catch (e) {
    return kirimHtml(res, 400, halamanResetSandi('', e.message, csrf));
  }
}

async function tanganiGantiSandi(req, res, sesi, akun, token) {
  if (req.method === 'GET') return kirimHtml(res, 200, halamanGantiSandi(sesi.csrf));
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = new URLSearchParams(await bacaBody(req));
  if ((f.get('_csrf') || '') !== sesi.csrf) { res.writeHead(403); return res.end('Token CSRF tidak sah.'); }
  const baru = f.get('baru') || '';
  if (baru !== (f.get('ulang') || '')) return kirimHtml(res, 400, halamanGantiSandi(sesi.csrf, 'Kata sandi baru dan ulangannya berbeda.'));
  const hasil = gantiSandi(BASE_ROOT, akun.id, f.get('lama') || '', baru);
  if (!hasil.ok) return kirimHtml(res, 400, halamanGantiSandi(sesi.csrf, hasil.error));
  tandaiSandiDiubah(token);
  return arahkan(res, '/');
}

const server = http.createServer(async (req, res) => {
  try {
    const mentah = req.url || '/';
    const u = decodeURIComponent(mentah.split('?')[0]);
    const paksa = /(?:^|[?&])paksa=1(?:&|$)/.test(mentah);
    const token = cookieToken(req);

    if (u === '/daftar') return await tanganiDaftar(req, res);
    if (u === '/verifikasi/kirim-ulang') return await tanganiKirimUlangKode(req, res);
    if (u === '/verifikasi') return await tanganiVerifikasi(req, res);
    if (u === '/lupa-sandi') return await tanganiLupaSandi(req, res);
    if (u === '/reset-sandi') return await tanganiResetSandi(req, res);

    // Webhook Midtrans publik: tanpa sesi dan tanpa CSRF, tapi tanda tangan SHA512
    // diverifikasi di dalam terimaWebhook(). Jangan pernah mengubah ini jadi
    // rute terlindungi — Midtrans tidak punya cookie sesi kita.
    if (u === '/pembayaran/webhook') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      try {
        const data = JSON.parse(await bacaBody(req) || '{}');
        const out = terimaWebhook(BASE_ROOT, BASE_ROOT, data);
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'GET' && DOKUMEN_PUBLIK[u]) {
      if (!DOKUMEN_DITAWANGKAN) return kirimHtml(res, 200, halamanDokumenMenunggu());
      return kirimDokumenPublik(res, DOKUMEN_PUBLIK[u]);
    }

    if (u === '/login') {
      const sudah = bacaSesi(token);
      if (sudah && req.method === 'GET') return arahkan(res, sudah.harusGanti ? '/ganti-sandi' : '/');
      return await tanganiLogin(req, res, u);
    }

    const sesi = bacaSesi(token);
    if (!sesi) return arahkan(res, '/login');
    const akun = cariPenggunaId(BASE_ROOT, sesi.id);
    if (!akun || akun.aktif === false) {
      hapusSesi(token);
      return arahkan(res, '/login', { 'Set-Cookie': 'rk_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }
    if (sesi.harusGanti && u !== '/ganti-sandi' && u !== '/logout') return arahkan(res, '/ganti-sandi');

    if (u === '/kuota') {
      return kirimHtml(res, 200, halamanKuota(sesi.csrf, kuotaUntuk(akun.id),
        riwayatKuota(rootDariPengguna(BASE_ROOT, akun)), akun, {
          pembayaran: statusPembayaran(),
          paket: daftarPaket(),
          riwayatBayar: riwayatPembayaran(BASE_ROOT, akun.id),
          modeKirim: bacaModeKirim(BASE_ROOT, akun.id, rootDariPengguna(BASE_ROOT, akun)),
        }));
    }

    if (u === '/ganti-sandi') return await tanganiGantiSandi(req, res, sesi, akun, token);

    if (u === '/logout' && req.method === 'POST') {
      const f = new URLSearchParams(await bacaBody(req));
      if ((f.get('_csrf') || '') !== sesi.csrf) { res.writeHead(403); return res.end('Token CSRF tidak sah.'); }
      hapusSesi(token);
      return arahkan(res, '/login', { 'Set-Cookie': `rk_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${httpsAktif(req) ? '; Secure' : ''}` });
    }

    if (req.method === 'POST' && (req.headers['x-csrf-token'] || '') !== sesi.csrf) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Token CSRF tidak sah. Segarkan halaman dan coba lagi.' }));
    }

    if (u === '/pembayaran/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        pembayaran: statusPembayaran(),
        kuota: kuotaUntuk(akun.id),
        riwayat: riwayatPembayaran(BASE_ROOT, akun.id),
      }));
    }

    if (u === '/pembayaran/buat' && req.method === 'POST') {
      try {
        const o = JSON.parse(await bacaBody(req) || '{}');
        const out = await buatTransaksi({ base: BASE_ROOT, akun, paketId: o.paketId });
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    const rootAkun = rootDariPengguna(BASE_ROOT, akun);
    const profil = bacaProfilAktif(rootAkun);
    const root = profil.ok && profil.profil.rootAktual ? profil.profil.rootAktual : rootAkun;
    const ctx = { root, rootPengguna: rootAkun, pengguna: akun, csrf: sesi.csrf, token };
    return await denganKonteks(ctx, () => tanganiRingkasan(req, res, u, mentah, paksa));
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Terjadi kesalahan pada server: ' + e.message);
    }
    return res.end();
  }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? 'Server ringkasan sudah berjalan di port 3000. Tidak perlu menjalankan node lagi — cukup klik ikon "Ringkasan Lamaran" di Desktop atau buka http://127.0.0.1:3000/'
    : e.message);
  process.exit(1);
});
try { await buildIfNeeded(true); } catch (e) { console.error(e.message); process.exit(1); }
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nBuka: ${url0}\nTekan Ctrl+C untuk berhenti.`);
  // Saat dinyalakan otomatis (ikon/Startup) browser dibuka oleh launcher, bukan di sini.
  if (process.platform === 'win32' && !process.env.RINGKASAN_TANPA_BROWSER) exec(`start "" "${url0}"`);
});
