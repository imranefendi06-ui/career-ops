#!/usr/bin/env node
// cv-entri.mjs — Fase 1: tambah entri CV, pemeriksaan struktur, skill gap.
//
// Aturan yang dipegang ( career-ops AGENTS.md ):
//   - Semua kata dan angka berasal dari kolom yang diisi pengguna di ringkasan
//     atau dari cv.md. Modul ini TIDAK mengarang kalimat, metrik, atau jabatan.
//   - Menulis cv.md hanya lewat pratinjau + token + konfirmasi, seperti cv-versi.
//   - Pemeriksaan memakai parser yang SAMA dengan alat career-ops, bukan parser
//     paralel, supaya angka di layar tidak berbeda dengan alat aslinya.
//   - Skill gap hanya mengklasifikasi kata: existing / supportedByResume / gap.
//     `gap` tidak pernah otomatis ditambahkan ke cv.md.
//
// Semua fungsi menerima `root` (data root) agar bisa dipakai per pengguna nanti.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  bacaStatusCv, periksaCv, ringkasCv,
  arsipkanCvSekarang, daftarkanCvSekarang, _internal,
} from './cv-versi.mjs';
import { applyAdd, locateSection } from './add-entry.mjs';
import { parseCvMdExperience } from './verify-cv-structure.mjs';
import { parseCvExperience } from './cv-title-check.mjs';
import {
  extractJdSkills, classifySkillGaps, diagnoseExtraction, diagnoseCoverage,
} from './jd-skill-gap.mjs';

const fileCv = (root) => path.join(path.resolve(root), 'cv.md');

function bacaCv(root) {
  try {
    return fs.readFileSync(fileCv(root), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function tulisAtomik(file, isi) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, isi, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

/* ---------- Bersihkan input: hanya merapikan, tidak menambah ---------- */

function satuBaris(nilai, maks = 120) {
  return String(nilai ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maks);
}

function daftarPoin(nilai) {
  const baris = Array.isArray(nilai) ? nilai : String(nilai ?? '').split(/\r?\n/);
  return baris
    .map((x) => satuBaris(String(x).replace(/^\s*[-*•]\s*/, ''), 500))
    .filter(Boolean)
    .slice(0, 30);
}

function normNama(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function rapikanPayload(p) {
  return {
    bagian: satuBaris(p.bagian, 100),
    perusahaan: satuBaris(p.perusahaan, 120),
    lokasi: satuBaris(p.lokasi, 100),
    jabatan: satuBaris(p.jabatan, 140),
    tanggal: satuBaris(p.tanggal, 80),
    poin: daftarPoin(p.poin),
    catatan: satuBaris(p.catatan, 300),
  };
}

function validasi(p) {
  if (!p.perusahaan) return 'Nama perusahaan/instansi wajib diisi.';
  if (!p.jabatan) return 'Jabatan/peran wajib diisi.';
  if (!p.tanggal) return 'Rentang tanggal wajib diisi (contoh: 2024 – 2025). Alat CV membaca baris ini.';
  if (!p.poin.length) return 'Isi minimal satu poin pengalaman dengan kata-kata Anda sendiri.';
  if (!p.bagian) return 'Bagian CV tujuan belum dipilih.';
  return '';
}

function bangunEntri(p) {
  const judul = `### ${p.perusahaan}${p.lokasi ? ` -- ${p.lokasi}` : ''}`;
  return [judul, '', `**${p.jabatan}**`, p.tanggal, '', ...p.poin.map((x) => `- ${x}`)].join('\n');
}

function tokenUntuk(cvTeks, p) {
  return crypto.createHash('sha256')
    .update(String(cvTeks) + '\u0000' + JSON.stringify(p))
    .digest('hex')
    .slice(0, 32);
}

function sudahAda(cvTeks, p) {
  return parseCvMdExperience(cvTeks).some((e) => {
    const a = normNama(e.company);
    const b = normNama(p.perusahaan);
    return a && b && (a === b || a.includes(b) || b.includes(a));
  });
}

/* ---------- API publik ---------- */

export function pratinjauEntri(root, masukan = {}) {
  const p = rapikanPayload(masukan);
  const salah = validasi(p);
  if (salah) return { ok: false, error: salah };

  const cvTeks = bacaCv(root);
  if (!cvTeks.trim()) return { ok: false, error: 'cv.md belum ada atau kosong.' };
  if (!locateSection(cvTeks, p.bagian)) {
    return { ok: false, error: `Bagian "## ${p.bagian}" tidak ada di cv.md. Pilih bagian yang sudah ada.` };
  }
  if (sudahAda(cvTeks, p)) {
    return { ok: false, error: `Entri untuk "${p.perusahaan}" sudah ada di cv.md. Tidak ada yang ditambahkan.` };
  }

  const entri = bangunEntri(p);
  let hasil;
  try {
    hasil = applyAdd({ cv: { section: p.bagian, dedupKey: entri.split('\n')[0], entry: entri } }, { cvText: cvTeks });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (hasil.result.cv.status === 'duplicate') {
    return { ok: false, error: 'Entri yang sama sudah ada. Tidak ada yang ditambahkan.' };
  }

  const diff = _internal.diffRingkas(cvTeks, hasil.cv, 3, 400);
  return {
    ok: true,
    token: tokenUntuk(cvTeks, p),
    payload: p,
    entri,
    diff: diff.baris,
    stat: diff.stat,
    dipotong: diff.dipotong,
    totalBaris: diff.totalBaris,
    peringatan: [
      'Semua kata, jabatan, tanggal, dan angka di entri ini berasal dari kolom yang Anda isi — sistem tidak menambahnya.',
      `Entri disisipkan di bagian "## ${p.bagian}". CV aktif sekarang akan diarsipkan otomatis.`,
    ],
  };
}

export function simpanEntri(root, { token, konfirmasi, ...masukan } = {}) {
  if (konfirmasi !== true) {
    return { ok: false, error: 'Konfirmasi belum dicentang. Tidak ada yang ditulis.' };
  }
  const p = rapikanPayload(masukan);
  const cvTeks = bacaCv(root);
  if (token !== tokenUntuk(cvTeks, p)) {
    return { ok: false, error: 'CV berubah sejak pratinjau. Ulangi pratinjau sebelum menyimpan.' };
  }
  const pratinjau = pratinjauEntri(root, p);
  if (!pratinjau.ok) return pratinjau;

  const hasil = applyAdd(
    { cv: { section: p.bagian, dedupKey: pratinjau.entri.split('\n')[0], entry: pratinjau.entri } },
    { cvText: cvTeks },
  );
  const lama = arsipkanCvSekarang(root, {
    nama: 'CV sebelum tambah entri',
    sumber: 'arsip-otomatis',
    catatan: `Sebelum menambah entri ${p.perusahaan}.`,
  });
  tulisAtomik(fileCv(root), hasil.cv);
  const meta = daftarkanCvSekarang(root, {
    nama: `CV + entri ${p.perusahaan}`,
    sumber: 'tambah-entri-ringkasan',
    catatan: `Entri ditambahkan pada bagian ${p.bagian} dari isian pengguna.`,
  });

  return {
    ok: true,
    arsipLama: lama ? lama.id : null,
    versiBaru: meta ? meta.id : null,
    ringkas: ringkasCv(hasil.cv),
    status: bacaStatusCv(root),
    pesan: `Entri "${p.perusahaan}" ditambahkan. CV lama tersimpan sebagai arsip.`,
  };
}

export function cekCv(root) {
  const teks = bacaCv(root);
  if (!teks.trim()) return { ok: false, error: 'cv.md belum ada atau kosong.' };
  const ringkas = ringkasCv(teks);
  const terbaca = parseCvExperience(teks);
  const mentah = parseCvMdExperience(teks);
  const belumTerbaca = Math.max(0, mentah.length - terbaca.length);
  const peringatan = [...periksaCv(teks).peringatan];
  if (belumTerbaca) {
    peringatan.push(
      `${belumTerbaca} entri pengalaman belum terbaca oleh alat CV (judul tebal atau baris tanggal tidak sesuai pola). Perbaiki agar pemeriksaan jabatan bisa berjalan.`,
    );
  }
  if (ringkas.punyaRingkasan === false) {
    peringatan.push('Bagian ringkasan/profil belum ada. Ini bukan kesalahan, tetapi alat tidak punya ringkasan untuk dibandingkan.');
  }
  return {
    ok: true,
    ringkas,
    entri: terbaca.map((e) => ({ perusahaan: e.company, jabatan: e.title, tanggal: e.dates })),
    belumTerbaca,
    peringatan,
    keterangan: 'Pemeriksaan struktur memakai parser yang sama dengan alat career-ops. Ini BUKAN evaluasi A–H dan BUKAN penilaian chance diterima.',
  };
}

export function skillGap(root, jdTeks) {
  const teks = String(jdTeks ?? '');
  if (!teks.trim()) return { ok: false, error: 'Tempel teks lowongan terlebih dahulu.' };
  const cvTeks = bacaCv(root);
  if (!cvTeks.trim()) return { ok: false, error: 'cv.md belum ada atau kosong.' };
  const skills = extractJdSkills(teks);
  const hasil = classifySkillGaps(skills, cvTeks);
  return {
    ok: true,
    ditemukan: skills.length,
    existing: hasil.existing,
    supportedByResume: hasil.supportedByResume,
    gap: hasil.gap,
    lowConfidence: diagnoseExtraction(teks, skills),
    partialCoverage: diagnoseCoverage(teks),
    keterangan: 'Kata yang cocok dengan CV aktif. `gap` berarti katanya tidak ditemukan di cv.md — bukan bukti Anda tidak mampu. Tidak ada kata yang otomatis ditambahkan ke CV.',
  };
}
