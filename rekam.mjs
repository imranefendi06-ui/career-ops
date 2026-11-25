// rekam.mjs - merekam struktur halaman lamaran JobStreet (tidak mengirim apa pun)
//
// Pemakaian (di folder career-ops):
//   node rekam.mjs "https://id.jobstreet.com/id/job/XXXXXXXX"
//
// Langkah:
//   1. Login jika diminta, lalu tekan Enter di terminal.
//   2. Klik tombol Lamar sendiri, sampai muncul langkah pertama formulir.
//   3. Tekan Enter di terminal -> halaman direkam ke rekam-1.txt
//   4. Klik "Lanjut" ke langkah berikutnya, tekan Enter lagi -> rekam-2.txt, dst.
//   5. Ketik q lalu Enter untuk selesai. JANGAN klik Kirim di akhir.
//
// Kirim isi semua file rekam-*.txt ke Claude (hapus nomor telepon/email jika ingin).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  console.error('Pemakaian: node rekam.mjs "<link lowongan JobStreet>"');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ctx = await chromium.launchPersistentContext(path.join(process.cwd(), '.browser-profile'), {
  channel: 'chrome',
  headless: false,
  viewport: null,
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(url);
await rl.question('Login jika perlu, lalu klik tombol Lamar sendiri. Tekan Enter untuk merekam langkah 1... ');

let n = 1;
while (true) {
  // Pakai halaman aktif terakhir (lamaran kadang terbuka di tab baru)
  const pages = ctx.pages();
  const p = pages[pages.length - 1];
  const info = await p.evaluate(() => {
    const short = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const attrs = (e) => ['id', 'name', 'type', 'accept', 'aria-label', 'data-testid', 'role', 'placeholder', 'value']
      .map((a) => (e.getAttribute(a) ? `${a}="${short(e.getAttribute(a))}"` : ''))
      .filter(Boolean)
      .join(' ');
    const list = (sel) => [...document.querySelectorAll(sel)].map((e) => `<${e.tagName.toLowerCase()} ${attrs(e)}> ${short(e.innerText)}`);
    return {
      url: location.href,
      title: document.title,
      headings: list('h1,h2,h3'),
      buttons: list('button,[role=button]'),
      links: list('a[href]').filter((x) => /lamar|apply|lanjut|continue|kirim|submit|resume|cover/i.test(x)),
      inputs: list('input,textarea,select'),
      labels: list('label,legend'),
    };
  });
  const out = [
    `URL: ${info.url}`,
    `TITLE: ${info.title}`,
    '\n== HEADINGS ==', ...info.headings,
    '\n== BUTTONS ==', ...info.buttons,
    '\n== LINKS (relevan) ==', ...info.links,
    '\n== INPUTS ==', ...info.inputs,
    '\n== LABELS ==', ...info.labels,
  ].join('\n');
  fs.writeFileSync(`rekam-${n}.txt`, out, 'utf8');
  console.log(`Tersimpan: rekam-${n}.txt`);
  n++;
  const a = (await rl.question('Klik Lanjut di browser ke langkah berikutnya, lalu Enter untuk merekam (q = selesai): ')).trim().toLowerCase();
  if (a === 'q') break;
}

await ctx.close();
rl.close();
