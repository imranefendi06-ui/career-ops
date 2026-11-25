// lamar.mjs - pembuka lamaran semi-otomatis (kamu tetap klik "Kirim" sendiri)
//
// Persiapan (sekali saja, di folder career-ops):
//   npm install playwright
//   npx playwright install chromium
//
// Pemakaian:
//   node lamar.mjs            -> skor minimal 3.0, maksimal 15 lowongan
//   node lamar.mjs 3.5 20     -> skor minimal 3.5, maksimal 20 lowongan
//
// Pertama kali jalan: login JobStreet di jendela yang terbuka, lalu tekan Enter di terminal.
// Login tersimpan di folder .browser-profile, jadi berikutnya tidak perlu login lagi.
//
// Di terminal, setelah tiap lowongan:
//   s = sudah kamu kirim (tracker diubah jadi Applied)
//   l = lewati
//   q = berhenti

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const MIN = parseFloat(process.argv[2] ?? '3.0');
const MAX = parseInt(process.argv[3] ?? '15', 10);
const reportsDir = path.join(ROOT, 'reports');
const outputDir = path.join(ROOT, 'output');
const APP = path.join(ROOT, 'data', 'applications.md');
const DELAY_MS = 4000; // jeda antar lowongan agar tidak terlihat seperti bot

const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const isTrackerRow = (l) => /^\|\s*\d/.test(l);

function trackerStatus() {
  const map = {};
  for (const l of readText(APP).split(/\r?\n/)) {
    if (!isTrackerRow(l)) continue;
    const c = l.split('|');
    map[parseInt(c[1], 10)] = c[6].trim().toLowerCase();
  }
  return map;
}

function markApplied(num) {
  const t = fs.readFileSync(APP, 'utf8');
  const eol = t.includes('\r\n') ? '\r\n' : '\n';
  const lines = t.split(/\r?\n/);
  const n = parseInt(num, 10);
  const idx = lines.findIndex((l) => isTrackerRow(l) && parseInt(l.split('|')[1], 10) === n);
  if (idx < 0) return false;
  const c = lines[idx].split('|');
  let notes = (c[9] || '').replace(/\.?\s*Dilamar \d{4}-\d{2}-\d{2}/g, '').trim();
  c[6] = ' Applied ';
  c[9] = ' ' + (notes ? notes + '. ' : '') + 'Dilamar ' + new Date().toLocaleDateString('sv-SE') + ' ';
  lines[idx] = c.join('|');
  fs.writeFileSync(APP, lines.join(eol));
  return true;
}

// Kumpulkan lowongan: skor >= MIN, belum Applied, nomor terbesar dulu
const status = trackerStatus();
const jobs = [];
for (const name of fs.readdirSync(reportsDir).filter((n) => /^\d+.*\.md$/.test(n))) {
  const text = readText(path.join(reportsDir, name));
  const num = name.match(/^(\d+)/)[1].padStart(3, '0');
  const score = parseFloat((text.match(/\*\*Score:\*\*\s*([\d.]+)/) || [])[1]);
  if (Number.isNaN(score) || score < MIN) continue;
  const urlLine = (text.match(/\*\*URL:\*\*.*/) || [''])[0];
  const url = (urlLine.match(/https?:\/\/[^\s)>\]]+/) || [''])[0];
  if (!url || !/jobstreet/i.test(url)) continue; // hanya JobStreet
  const st = status[parseInt(num, 10)];
  if (st === undefined || st !== 'evaluated') continue; // lewati yang sudah dilamar / tidak ada di tracker
  const title = (text.match(/^#\s+(.*)$/m) || [])[1] || name;
  const files = fs.readdirSync(outputDir);
  const re = new RegExp(`(^|[-_])${num}([-_.]|$)`);
  const cv = files.find((f) => /^cv-.*\.pdf$/i.test(f) && re.test(f) && !/cover|surat/i.test(f));
  const cover = files.find((f) => /^surat-lamaran-.*\.pdf$/i.test(f) && re.test(f));
  jobs.push({ num, score, url, title, cv, cover });
}
jobs.sort((a, b) => parseInt(b.num, 10) - parseInt(a.num, 10));
const queue = jobs.slice(0, MAX);
console.log(`${jobs.length} lowongan JobStreet siap dilamar, diproses ${queue.length} dulu.\n`);
if (!queue.length) process.exit(0);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.browser-profile'), {
  channel: 'chrome', // pakai Google Chrome yang sudah terpasang
  headless: false,
  viewport: null,
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto('https://id.jobstreet.com/');
await rl.question('Pastikan sudah LOGIN di JobStreet, lalu tekan Enter di sini... ');

for (const [i, j] of queue.entries()) {
  console.log(`\n[${i + 1}/${queue.length}] #${j.num} (skor ${j.score}) ${j.title}`);
  console.log(`  CV      : ${j.cv ? path.join('output', j.cv) : '(tidak ada)'}`);
  console.log(`  Surat   : ${j.cover ? path.join('output', j.cover) : '(tidak ada)'}`);
  try {
    await page.goto(j.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Coba klik tombol lamar; kalau gagal, kamu klik sendiri
    const btn = page.getByRole('link', { name: /lamar|apply/i }).first();
    const btn2 = page.getByRole('button', { name: /lamar|apply/i }).first();
    if (await btn.isVisible({ timeout: 6000 }).catch(() => false)) await btn.click();
    else if (await btn2.isVisible({ timeout: 2000 }).catch(() => false)) await btn2.click();
    else console.log('  (tombol Lamar tidak ditemukan - mungkin lowongan sudah ditutup / sudah dilamar)');
  } catch (e) {
    console.log('  Gagal membuka halaman: ' + String(e.message).split('\n')[0]);
  }

  const ans = (await rl.question('  Isi pertanyaan, unggah surat, klik Kirim. Lalu ketik [s]udah / [l]ewati / [q]uit: ')).trim().toLowerCase();
  if (ans === 'q') break;
  if (ans === 's') console.log(markApplied(j.num) ? '  -> tracker: Applied' : '  -> nomor tidak ditemukan di tracker');
  await page.waitForTimeout(DELAY_MS);
}

await ctx.close();
rl.close();
console.log('\nSelesai. Jalankan ulang node ringkasan.mjs untuk melihat tabel terbaru.');
