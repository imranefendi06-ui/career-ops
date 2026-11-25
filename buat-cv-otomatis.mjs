#!/usr/bin/env node
// Membuat CV PDF untuk satu lowongan (atau semua lowongan yang belum punya CV)
// langsung dari cv.md + laporan lowongan, tanpa menambah fakta apa pun.
//
//   node buat-cv-otomatis.mjs 378
//   node buat-cv-otomatis.mjs --semua [--min 3.0] [--maks 20]
//
// Isi CV diambil apa adanya dari cv.md (ringkasan, pengalaman, pendidikan,
// keterampilan). Yang disesuaikan hanya: judul posisi, urutan kategori
// keterampilan, dan daftar kompetensi inti (diambil dari butir keterampilan
// yang paling cocok dengan teks lowongan). Tidak ada kalimat baru.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rootAktif } from './konteks-root.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = () => rootAktif() || CODE_ROOT;
const REPORTS = () => path.join(ROOT(), 'reports');
const OUTPUT = () => path.join(ROOT(), 'output');
const CV_MD = () => path.join(ROOT(), 'cv.md');

// Skrip sistem tetap dibaca dari CODE_ROOT; anak proses diberi
// CAREER_OPS_ROOT supaya resolver career-ops menulis ke root akun aktif.

const STOP = new Set(['yang', 'dan', 'atau', 'untuk', 'dengan', 'pada', 'dari', 'dalam', 'akan', 'juga', 'tidak', 'adalah',
  'serta', 'oleh', 'sebagai', 'dapat', 'agar', 'kepada', 'ini', 'itu', 'para', 'anda', 'kami', 'kita', 'minimal', 'lebih',
  'serta', 'secara', 'serta', 'bagi', 'hal', 'lain', 'harus', 'mampu', 'memiliki', 'melakukan', 'kerja', 'perusahaan']);

const LOW = (s) => String(s || '').toLowerCase();
const bersih = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function kata(s) {
  return LOW(s).normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));
}

// ---------- Baca cv.md ----------
function bacaCv() {
  const teks = fs.readFileSync(CV_MD(), 'utf8').replace(/^\uFEFF/, '');
  const lines = teks.split(/\r?\n/);
  const nama = bersih((lines.find((l) => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').replace(/^CV\s*[-–—:]+\s*/i, ''));
  const ambil = (label) => bersih((teks.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i')) || [])[1] || '');

  const secs = [];
  let now = null;
  for (const l of lines) {
    const m = l.match(/^##\s+(.+?)\s*$/);
    if (m) { now = { title: bersih(m[1]), body: [] }; secs.push(now); continue; }
    if (now) now.body.push(l);
  }
  const sec = (re) => (secs.find((s) => re.test(s.title)) || { body: [] }).body.join('\n');

  const summary = bersih(sec(/summary|ringkasan/i).replace(/\n+/g, ' '));

  // Pengalaman: dua konvensi yang dibaca:
  //   ### Perusahaan -- Lokasi / **Jabatan** / tanggal / - butir
  //   ### Perusahaan -- Lokasi / ### Jabatan (Bulan Tahun — Bulan Tahun) / - butir
  // Konvensi kedua umum pada CV hasil unggah PDF. Tanpa pengenalan ini,
  // setiap baris ### Jabatan (tanggal) salah dibaca sebagai perusahaan baru
  // dan payload ditolak karena role kosong.
  const experience = [];
  const expBody = sec(/^(work experience|experience|pengalaman)/i);
  const headingEntri = (head) => {
    const bertanggal = head.match(/^(.*?)\s*\(([^)]*(?:19|20)\d{2}[^)]*)\)\s*$/);
    if (bertanggal) {
      const depan = bersih(bertanggal[1]);
      const potong = depan.split(/\s+(?:--|—|–)\s+/);
      const adaPerusahaan = potong.length > 1;
      return {
        company: adaPerusahaan ? bersih(potong[0]) : '',
        role: adaPerusahaan ? bersih(potong.slice(1).join(' — ')) : depan,
        dates: bersih(bertanggal[2]),
        jabatan: true,
      };
    }
    const lepasTanggal = head.replace(/\([^)]*\)/g, '');
    const pisah = lepasTanggal.split(/\s+(?:--|—|–|-)\s+/);
    return {
      company: bersih(pisah[0]),
      role: '',
      location: bersih(pisah.slice(1).join(' - ')),
      dates: '',
      jabatan: false,
    };
  };
  let entri = null;
  for (const blok of expBody.split(/^###\s+/m).slice(1)) {
    const baris = blok.split(/\r?\n/);
    const h = headingEntri(bersih(baris[0]));
    if (h.jabatan) {
      // Jabatan yang mengikuti kepala perusahaan mengisi entri itu, bukan
      // membuat entri baru dengan company kosong.
      const sebelumnya = [...experience].reverse().find((e) => !e.role && !(e.bullets || []).length);
      if (sebelumnya) {
        sebelumnya.role = h.role || 'tidak dicantumkan';
        sebelumnya.dates = h.dates || sebelumnya.dates;
        if (h.company) sebelumnya.company = h.company;
        entri = sebelumnya;
      } else {
        entri = {
          company: h.company || 'tidak dicantumkan',
          role: h.role || 'tidak dicantumkan',
          location: '', dates: h.dates, bullets: [],
        };
        experience.push(entri);
      }
    } else {
      entri = {
        company: h.company || 'tidak dicantumkan',
        role: '', location: h.location || '', dates: '', bullets: [],
      };
      experience.push(entri);
    }
    for (const raw of baris.slice(1)) {
      const l = bersih(raw).replace(/[\uF0B7\uF0A7]/g, '');
      if (!l) continue;
      const jabatan = l.match(/^\*\*(.+?)\*\*(?:\s*[·|,—–-]\s*(.+))?$/);
      if (!entri.role && jabatan) {
        entri.role = bersih(jabatan[1]);
        if (jabatan[2] && !entri.dates) entri.dates = bersih(jabatan[2]);
        continue;
      }
      if (!entri.dates && !/^[-*]\s+/.test(l) && /\d{4}/.test(l)) { entri.dates = l; continue; }
      if (/^[-*]\s+/.test(l)) entri.bullets.push(l.replace(/^[-*]\s+/, '').trim());
    }
  }

  // Pendidikan: butir **Judul**, Lembaga (tahun) [— keterangan]
  const education = [];
  const eduBody = sec(/^(education|pendidikan)/i);
  for (const raw of eduBody.split(/\r?\n/)) {
    const l = bersih(raw);
    if (!l) continue;
    const m = l.match(/^[-*]\s+\*\*(.+?)\*\*\s*(?:,|\s-\s|\s—\s)\s*(.+)$/);
    if (m) {
      const sisa = m[2];
      const tahun = (sisa.match(/\(([^)]*\d{4}[^)]*)\)/) || [])[1] || '';
      const org = bersih(sisa.replace(/\([^)]*\)/, '').replace(/\s*[—-]\s*.*$/, ''));
      const ket = bersih(sisa.replace(/^.*?\([^)]*\)\s*/, '').replace(/^[—–-]\s*/, '')).replace(/\*\*/g, '');
      education.push({ title: bersih(m[1]), org, year: tahun, description: ket });
      continue;
    }
    if (education.length && /^[-*]\s+/.test(l)) {
      const t = l.replace(/^[-*]\s+/, '').trim().replace(/\*\*/g, '');
      const prev = education[education.length - 1];
      prev.description = bersih([prev.description, t].filter(Boolean).join('. '));
    }
  }

  // Keterampilan
  const skills = [];
  const skillBody = sec(/^(skills|keterampilan)/i);
  for (const raw of skillBody.split(/\r?\n/)) {
    const l = bersih(raw);
    const m = l.match(/^[-*]\s+\*\*(.+?):\*\*\s*(.+)$/);
    if (m) skills.push({ category: bersih(m[1]), items: bersih(m[2]) });
  }

  // Bahasa
  const bahasa = [];
  const langBody = sec(/^(languages|bahasa)/i);
  for (const raw of langBody.split(/\r?\n/)) {
    const m = bersih(raw).match(/^[-*]\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/);
    if (m) bahasa.push(`${bersih(m[1])} (${bersih(m[2])})`);
  }
  if (bahasa.length) skills.push({ category: 'Bahasa', items: bahasa.join(', ') });

  return {
    candidate: { name: nama, phone: ambil('Phone'), email: ambil('Email'), location: ambil('Location') },
    summary,
    experience,
    education,
    skills,
  };
}

// ---------- Baca laporan ----------
function bacaLaporan(num) {
  const f = fs.readdirSync(REPORTS()).find((n) => new RegExp(`^0*${num}-`).test(n));
  if (!f) throw new Error(`Laporan nomor ${num} tidak ditemukan di reports/.`);
  const teks = fs.readFileSync(path.join(REPORTS(), f), 'utf8');
  const head = (teks.match(/^# Evaluation:\s*(.+)$/m) || [])[1] || '';
  const [companyRaw, roleRaw] = head.split(/\s+[—–-]\s+/);
  const slug = f.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
  const jd = ((teks.match(/## Job Description[^\n]*\n([\s\S]*?)(?=\n## |\s*$)/i) || [])[1] || '').slice(0, 8000);
  const score = parseFloat((teks.match(/^\*\*Score:\*\*\s*([\d.]+)\/5$/m) || [])[1] || '0');
  const decision = ((teks.match(/^\*\*Decision:\*\*\s*(.+)$/m) || [])[1] || '').trim();
  return {
    num: String(num).padStart(3, '0'),
    file: f,
    slug,
    company: bersih(companyRaw),
    role: judulRapi(bersih(roleRaw)),
    jd,
    score,
    decision,
  };
}

// "AREA ACCOUNT ADMINISTRATION STAFF" -> "Area Account Administration Staff"
function judulRapi(role) {
  const r = bersih(role).replace(/\s*\([^)]*\)\s*$/, '');
  if (r === r.toUpperCase()) return r.toLowerCase().replace(/(^|\s|\/)\S/g, (c) => c.toUpperCase());
  return r;
}

// ---------- Penyesuaian (tanpa fakta baru) ----------
function susunPayload(cv, rep) {
  const jdKata = new Set(kata(`${rep.jd} ${rep.role} ${rep.company}`));
  const skor = (t) => kata(t).filter((w) => jdKata.has(w)).length;

  // Kompetensi inti: butir keterampilan yang paling cocok dengan lowongan.
  const butir = [];
  for (const s of cv.skills) {
    if (/^bahasa$/i.test(s.category)) continue; // bahasa bukan kompetensi inti
    for (const it of s.items.split(',')) {
      const bersihIt = bersih(it);
      if (bersihIt) butir.push({ teks: bersihIt, skor: skor(bersihIt) + skor(s.category) * 0.5 });
    }
  }
  const kompetensi = butir
    .filter((b) => b.skor > 0)
    .sort((a, b) => b.skor - a.skor)
    .map((b) => b.teks)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 8);
  for (const b of butir.sort((a, b) => b.skor - a.skor)) {
    if (kompetensi.length >= 6) break;
    if (!kompetensi.includes(b.teks)) kompetensi.push(b.teks);
  }

  // Urutan kategori keterampilan mengikuti relevansi dengan lowongan.
  const skills = cv.skills
    .map((s) => ({ ...s, skor: skor(s.category) + s.items.split(',').reduce((n, it) => n + skor(it), 0) }))
    .sort((a, b) => b.skor - a.skor)
    .map(({ category, items }) => ({ category, items }));

  return {
    lang: 'id',
    page_format: 'a4',
    candidate: {
      name: cv.candidate.name,
      title: rep.role,
      phone: cv.candidate.phone,
      email: cv.candidate.email,
      location: cv.candidate.location,
      photo: '',
    },
    sections: {
      summary: 'Ringkasan Profesional',
      competencies: 'Kompetensi Inti',
      experience: 'Pengalaman Kerja',
      education: 'Pendidikan',
      skills: 'Keterampilan',
    },
    summary: cv.summary,
    competencies: kompetensi,
    experience: cv.experience,
    education: cv.education,
    skills,
  };
}

// ---------- Render ----------
function slugNama(nama) {
  return LOW(nama).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buatSatu(num) {
  const rep = bacaLaporan(num);
  const cv = bacaCv();
  if (!cv.summary || !cv.experience.length) throw new Error('cv.md tidak bisa dibaca (ringkasan/pengalaman kosong).');

  const tanggal = new Date().toISOString().slice(0, 10);
  const dasar = `cv-${slugNama(cv.candidate.name)}-${rep.num}-${rep.slug}-${tanggal}`;
  const jsonPath = path.join(OUTPUT(), `${dasar}.json`);
  const htmlPath = path.join(OUTPUT(), `${dasar}.html`);
  const pdfPath = path.join(OUTPUT(), `${dasar}.pdf`);

  fs.mkdirSync(OUTPUT(), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(susunPayload(cv, rep), null, 2), 'utf8');

  const envAnak = { ...process.env, CAREER_OPS_ROOT: ROOT() };
  execFileSync(process.execPath, [path.join(CODE_ROOT, 'build-cv-html.mjs'), jsonPath, htmlPath], { cwd: CODE_ROOT, env: envAnak, stdio: 'pipe' });
  execFileSync(process.execPath, [path.join(CODE_ROOT, 'generate-pdf.mjs'), htmlPath, pdfPath, '--format=a4', `--report=${rep.num}`, '--kind=cv', '--allow-nonchronological'], {
    cwd: CODE_ROOT,
    env: envAnak,
    stdio: 'pipe',
    timeout: 180000,
  });
  if (!fs.existsSync(pdfPath)) throw new Error('PDF tidak terbentuk.');
  return { num: rep.num, company: rep.company, role: rep.role, pdf: path.basename(pdfPath), json: path.basename(jsonPath) };
}

function daftarTanpaCv(minScore) {
  const out = [];
  const files = fs.readdirSync(OUTPUT()).map((f) => f.toLowerCase());
  for (const f of fs.readdirSync(REPORTS()).filter((n) => /^\d+.*\.md$/.test(n))) {
    const num = f.match(/^(\d+)/)[1].padStart(3, '0');
    const teks = fs.readFileSync(path.join(REPORTS(), f), 'utf8');
    const score = parseFloat((teks.match(/^\*\*Score:\*\*\s*([\d.]+)\/5$/m) || [])[1] || '0');
    const decision = ((teks.match(/^\*\*Decision:\*\*\s*(.+)$/m) || [])[1] || '').trim();
    if (!(score >= minScore) || /^skip$/i.test(decision)) continue;
    const slug = f.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
    const re = new RegExp(`(^|[^0-9])${num}([^0-9]|$)`);
    const punya = files.some((n) => /^cv-.*\.pdf$/.test(n) && !/cover|surat/.test(n) && (re.test(n) || n.includes(slug)));
    if (!punya) out.push(num);
  }
  return out.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
}

const args = process.argv.slice(2);
const minArg = Number((args.find((a) => a.startsWith('--min')) || '').split('=')[1] || 3.0);
const maksArg = Number((args.find((a) => a.startsWith('--maks')) || '').split('=')[1] || 20);

function utama() {
  let target = [];
  if (args.includes('--semua')) target = daftarTanpaCv(minArg).slice(0, maksArg);
  else target = args.filter((a) => /^\d+$/.test(a));

  if (!target.length) {
    console.log(JSON.stringify({ dibuat: [], pesan: 'Tidak ada lowongan yang perlu dibuatkan CV.' }, null, 2));
    process.exit(0);
  }

  const hasil = [];
  for (const num of target) {
    try {
      const r = buatSatu(num);
      hasil.push({ ...r, ok: true });
      console.log(`OK #${r.num} ${r.company} — ${r.role} -> ${r.pdf}`);
    } catch (e) {
      hasil.push({ num, ok: false, error: String(e.message || e).split('\n').slice(-3).join(' | ') });
      console.error(`GAGAL #${num}: ${String(e.message || e).split('\n')[0]}`);
    }
  }
  console.log(JSON.stringify({ jumlah: hasil.length, berhasil: hasil.filter((h) => h.ok).length, hasil }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) utama();

export { bacaCv, bacaLaporan, susunPayload, daftarTanpaCv, buatSatu };
