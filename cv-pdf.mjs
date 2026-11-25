// cv-pdf.mjs — jalur unggah CV PDF untuk SiapLamar.
//
// Fungsinya sengaja sempit: baca teks PDF di komputer operator, rapikan ke
// format cv.md yang dipakai career-ops, lalu kembalikan teks untuk pratinjau.
// Modul ini TIDAK menulis cv.md, tidak menyimpan PDF, dan tidak memanggil AI.
// Penulisan tetap lewat /cv/pratinjau → /cv/simpan dengan konfirmasi eksplisit.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PDF_TEXT_MODUL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'web', 'src', 'lib', 'cv', 'pdf-text.mjs',
);

const BERSIH_KONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Baca teks dari PDF. Pdfjs dipakai ulang dari aplikasi web, bukan ditulis ulang. */
export async function ekstrakTeksPdf(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (data.length < 5 || data.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('Berkas bukan PDF yang valid. Pilih berkas .pdf.');
  }
  const { pdfText } = await import(pathToFileURL(PDF_TEXT_MODUL).href);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  try {
    return await pdfText(buffer);
  } catch (e) {
    const m = String(e?.message || '');
    if (/no readable text/i.test(m)) {
      throw new Error('PDF tidak memiliki teks yang bisa dibaca (mungkin hasil scan/foto). Tempel teks CV-nya atau pakai PDF yang teksnya bisa disalin.');
    }
    if (/password protected/i.test(m)) {
      throw new Error('PDF dilindungi kata sandi. Unggah salinan tanpa kata sandi.');
    }
    if (/more than 30 pages/i.test(m)) {
      throw new Error('PDF lebih dari 30 halaman. Unggah hanya halaman CV Anda.');
    }
    if (/too much text/i.test(m)) {
      throw new Error('Teks PDF terlalu panjang. Ringkas CV menjadi maksimal 60.000 karakter.');
    }
    if (/could not be read|invalid pdf/i.test(m)) {
      throw new Error('PDF tidak bisa dibaca. Pilih berkas .pdf yang valid.');
    }
    throw new Error('PDF gagal dibaca: ' + m);
  }
}

const HEADING = [
  [/^(ringkasan|profil|profile|summary|objective|tentang saya|about me)$/i, 'Ringkasan'],
  [/^(pengalaman|pengalaman kerja|riwayat kerja|experience|work experience|professional experience|employment history|work history)$/i, 'Pengalaman'],
  [/^(pendidikan|education|educational background)$/i, 'Pendidikan'],
  [/^(keterampilan|keahlian|kompetensi|skills|technical skills|core competencies)$/i, 'Keterampilan'],
  [/^(proyek|projects|project experience)$/i, 'Proyek'],
  [/^(sertifikat|sertifikasi|certifications?|licenses?)$/i, 'Sertifikat'],
  [/^(informasi tambahan|additional information|other information)$/i, 'Informasi Tambahan'],
  [/^(kontak|contact|contact information)$/i, 'Kontak'],
];

const TANGGAL = /(19|20)\d{2}|jan|feb|mar|apr|mei|may|jun|jul|agu|aug|sep|okt|oct|nov|des|dec|present|sekarang/i;

function bersihBaris(teks) {
  return String(teks ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(BERSIH_KONTROL, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cocokHeading(baris) {
  const calon = baris.trim().replace(/^#{1,6}\s*/, '').replace(/[:\s]+$/, '').trim();
  if (!calon || calon.length > 48) return '';
  for (const [pola, nama] of HEADING) if (pola.test(calon)) return nama;
  return '';
}

function namaVersi(nama, teks) {
  const dariNama = String(nama ?? '').trim().replace(/\.pdf$/i, '').slice(0, 80);
  if (dariNama) return dariNama;
  const pertama = String(teks ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return (`CV dari PDF${pertama ? ' — ' + pertama.slice(0, 50) : ''}`).slice(0, 80);
}

/**
 * Rapikan teks hasil ekstraksi ke konvensi cv.md.
 * Yang tidak jelas dibiarkan apa adanya dan diberi peringatan, bukan ditebak.
 */
export function cvDariTeks(teksMentah, nama = '') {
  const teks = bersihBaris(teksMentah);
  if (!teks) return { ok: false, error: 'PDF tidak mengandung teks yang bisa dipakai.' };

  const keluaran = [];
  const peringatan = [];
  const bagianDitemukan = new Set();
  let bagian = '';
  let adaPengalamanTerbentuk = false;
  let adaKontak = false;
  const tambah = (baris) => {
    if (keluaran.length && keluaran[keluaran.length - 1] !== '' || baris !== '') keluaran.push(baris);
  };
  const bukaBagian = (namaBagian) => {
    if (keluaran.length && keluaran[keluaran.length - 1] !== '') keluaran.push('');
    keluaran.push(`## ${namaBagian}`, '');
  };

  let kepala = [];
  for (const barisAsli of teks.split('\n')) {
    const baris = barisAsli.trim();
    if (!baris) continue;
    const heading = cocokHeading(baris);
    if (heading) {
      if (!bagian && kepala.length) {
        const pertama = kepala[0].replace(/^#+\s*/, '');
        if (pertama && !/@/.test(pertama) && pertama.length <= 80) {
          keluaran.push(`# ${pertama}`, '');
          kepala = kepala.slice(1);
        }
        for (const sisa of kepala) tambah(sisa);
        if (keluaran.length && keluaran[keluaran.length - 1] !== '') keluaran.push('');
        kepala = [];
      }
      bagian = heading;
      bagianDitemukan.add(heading);
      bukaBagian(heading);
      continue;
    }
    if (!bagian) {
      kepala.push(baris);
      if (/@/.test(baris)) adaKontak = true;
      continue;
    }
    if (/@/.test(baris)) adaKontak = true;

    if (bagian === 'Pengalaman') {
      const poin = baris.replace(/^[-•*·]\s*/, '');
      if (/^[-•*·]/.test(baris)) {
        tambah(`- ${poin}`);
        continue;
      }
      // Pola "Perusahaan — Kota" dipakai sebagai judul entri.
      const entri = baris.match(/^(.+?)\s+[—–]\s+(.+)$/);
      if (entri && !/[|·]/.test(baris)) {
        if (keluaran.length && keluaran[keluaran.length - 1] !== '') keluaran.push('');
        tambah(`### ${entri[1].trim()} — ${entri[2].trim()}`);
        adaPengalamanTerbentuk = true;
        continue;
      }
      // Pola "Jabatan | Jan 2022 – Des 2024" atau "Jabatan · 2024".
      const jabatan = baris.match(/^(.+?)\s*[|·]\s*(.+)$/);
      if (jabatan && TANGGAL.test(jabatan[2])) {
        tambah(`**${jabatan[1].trim()}** · ${jabatan[2].trim()}`);
        adaPengalamanTerbentuk = true;
        continue;
      }
      // Baris tersisa dalam pengalaman adalah poin tanggung jawab/capaian.
      // Tanggal tanpa jabatan dibiarkan apa adanya, bukan diubah jadi poin.
      if (TANGGAL.test(baris) && baris.length <= 40) tambah(baris);
      else tambah(`- ${baris}`);
      continue;
    }

    if (bagian === 'Keterampilan' && !/^[-•*·]/.test(baris) && (baris.match(/[,;|]/g) || []).length >= 2) {
      for (const skill of baris.split(/[,;|]/).map((s) => s.trim()).filter(Boolean)) tambah(`- ${skill}`);
      continue;
    }
    tambah(baris);
  }

  // Kalau tidak ada heading sama sekali, simpan seluruh teks sebagai badan CV.
  if (!bagianDitemukan.size) {
    keluaran.length = 0;
    for (const baris of teks.split('\n').map((l) => l.trim()).filter(Boolean)) tambah(baris);
  } else if (keluaran.length && keluaran[keluaran.length - 1] !== '') {
    keluaran.push('');
  }

  const hasil = bersihBaris(keluaran.join('\n'));
  if (!/^#{1,3}\s+\S/m.test(hasil)) {
    peringatan.push('Tidak ada judul bagian yang dikenali. Periksa hasil unggahan sebelum menjadikannya CV aktif.');
  }
  if (!bagianDitemukan.has('Pengalaman')) {
    peringatan.push('Bagian pengalaman tidak ditemukan di PDF. Tambahkan ## Pengalaman sebelum konfirmasi agar alat CV bisa membaca riwayat kerja.');
  } else if (adaPengalamanTerbentuk) {
    peringatan.push('Format pengalaman dirapikan otomatis. Periksa lagi nama perusahaan, jabatan, dan tanggal di perbedaan sebelum menyetujui.');
  }
  if (!adaKontak) {
    peringatan.push('Email atau nomor telepon tidak terlihat. Pastikan kontak Anda tercantum sebelum melamar.');
  }

  return { ok: true, teks: hasil, nama: namaVersi(nama, teks), peringatan };
}
