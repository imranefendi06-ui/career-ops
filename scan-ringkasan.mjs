// scan-ringkasan.mjs — mesin scan untuk panel "Scan lowongan terbaru" di
// halaman ringkasan. Memakai scan.mjs yang sudah ada, tanpa mengubah portals.yml
// pengguna: lokasi dipakai sebagai berkas sementara lewat CAREER_OPS_PORTALS.
//
// CATATAN JUJUR: scan tidak menghasilkan skor kecocokan 1-5. Skor di halaman
// ringkasan berasal dari laporan evaluasi. Filter skor dipakai untuk menyaring
// baris yang sudah punya laporan; lowongan hasil scan ditandai "Belum dinilai".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rootAktif } from './konteks-root.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORTAL_ASLI = path.join(ROOT, 'portals.yml');
const SKRIP_SCAN = process.env.SCAN_SCRIPT || path.join(ROOT, 'scan.mjs');
// Portals dan skrip scan adalah system layer dan tetap dibaca dari folder kode.
// Pipeline, riwayat, dan tracker mengikuti data root akun/profil yang aktif.
const rootData = () => rootAktif() || ROOT;
const PIPELINE = () => process.env.SCAN_PIPELINE || path.join(rootData(), 'data', 'pipeline.md');

/* ---------- Daftar wilayah (38 provinsi Indonesia) ---------- */
// alias = token lokasi yang dikenal di portals.yml / JobStreet. Ini bukan
// klaim fakta lowongan; hanya nama wilayah untuk menyaring teks lokasi.
// kota = pilihan tingkat kota/kabupaten bila pengguna ingin mempersempit satu
// provinsi. Daftar ini nama wilayah administratif, bukan data lowongan.
export const WILAYAH = [
  { pulau: 'Sumatera', alias: ['Sumatra', 'Sumatera'], provinsi: [
    { nama: 'Aceh', alias: ['Aceh', 'Banda Aceh', 'Lhokseumawe', 'Langsa'], kota: [
      'Banda Aceh', 'Lhokseumawe', 'Langsa', 'Sabang', 'Subulussalam',
      'Aceh Besar', 'Pidie', 'Pidie Jaya', 'Aceh Utara', 'Bireuen', 'Aceh Timur',
      'Aceh Tamiang', 'Aceh Barat', 'Nagan Raya', 'Aceh Jaya', 'Aceh Selatan',
      'Aceh Tenggara', 'Aceh Tengah', 'Bener Meriah', 'Gayo Lues', 'Aceh Singkil', 'Simeulue',
    ] },
    { nama: 'Sumatera Utara', alias: ['Sumatera Utara', 'Medan', 'Pematangsiantar', 'Binjai', 'Tebing Tinggi', 'Sibolga', 'Padang Sidempuan'], kota: [
      'Medan', 'Binjai', 'Pematangsiantar', 'Tebing Tinggi', 'Sibolga',
      'Padang Sidempuan', 'Tanjungbalai', 'Gunungsitoli',
      'Deli Serdang', 'Langkat', 'Karo', 'Simalungun', 'Asahan', 'Labuhanbatu',
      'Toba', 'Samosir', 'Dairi', 'Nias', 'Mandailing Natal', 'Tapanuli Utara',
      'Tapanuli Tengah', 'Tapanuli Selatan', 'Batu Bara', 'Serdang Bedagai',
      'Humbang Hasundutan', 'Pakpak Bharat', 'Padang Lawas', 'Padang Lawas Utara',
      'Labuhanbatu Utara', 'Labuhanbatu Selatan', 'Nias Selatan', 'Nias Utara', 'Nias Barat',
    ] },
    { nama: 'Sumatera Barat', alias: ['Sumatera Barat', 'Padang', 'Bukittinggi', 'Payakumbuh'], kota: [
      'Padang', 'Bukittinggi', 'Payakumbuh', 'Pariaman', 'Solok', 'Sawahlunto',
      'Padang Panjang', 'Agam', 'Tanah Datar', 'Pesisir Selatan', 'Lima Puluh Kota',
      'Pasaman', 'Pasaman Barat', 'Sijunjung', 'Dharmasraya', 'Solok Selatan',
      'Kepulauan Mentawai',
    ] },
    { nama: 'Riau', alias: ['Riau', 'Pekanbaru', 'Dumai'], kota: [
      'Pekanbaru', 'Dumai', 'Kampar', 'Siak', 'Bengkalis', 'Rokan Hilir',
      'Rokan Hulu', 'Pelalawan', 'Indragiri Hulu', 'Indragiri Hilir',
      'Kuantan Singingi', 'Kepulauan Meranti',
    ] },
    { nama: 'Jambi', alias: ['Jambi'], kota: [
      'Jambi', 'Sungai Penuh', 'Kerinci', 'Merangin', 'Sarolangun', 'Batanghari',
      'Muaro Jambi', 'Tanjung Jabung Timur', 'Tanjung Jabung Barat', 'Tebo', 'Bungo',
    ] },
    { nama: 'Sumatera Selatan', alias: ['Sumatera Selatan', 'Palembang', 'Lubuklinggau', 'Prabumulih'], kota: [
      'Palembang', 'Pagar Alam', 'Lubuklinggau', 'Prabumulih', 'Muara Enim', 'Lahat',
      'Musi Banyuasin', 'Musi Rawas', 'Musi Rawas Utara', 'Ogan Komering Ilir',
      'Ogan Komering Ulu', 'Ogan Ilir', 'Empat Lawang', 'Penukal Abab Lematang Ilir',
      'Banyuasin', 'Ogan Komering Ulu Timur', 'Ogan Komering Ulu Selatan',
    ] },
    { nama: 'Bengkulu', alias: ['Bengkulu'], kota: [
      'Bengkulu', 'Curup', 'Rejang Lebong', 'Seluma', 'Kaur', 'Mukomuko', 'Lebong',
      'Kepahiang', 'Bengkulu Utara', 'Bengkulu Tengah', 'Bengkulu Selatan',
    ] },
    { nama: 'Lampung', alias: ['Lampung', 'Bandar Lampung', 'Metro'], kota: [
      'Bandar Lampung', 'Metro', 'Lampung Selatan', 'Lampung Tengah', 'Lampung Utara',
      'Lampung Timur', 'Lampung Barat', 'Tanggamus', 'Pringsewu', 'Tulang Bawang',
      'Pesawaran', 'Way Kanan', 'Mesuji', 'Tulang Bawang Barat', 'Pesisir Barat',
    ] },
    { nama: 'Kepulauan Bangka Belitung', alias: ['Kepulauan Bangka Belitung', 'Bangka Belitung', 'Pangkal Pinang'], kota: [
      'Pangkal Pinang', 'Bangka', 'Belitung', 'Bangka Barat', 'Bangka Tengah',
      'Bangka Selatan', 'Belitung Timur',
    ] },
    { nama: 'Kepulauan Riau', alias: ['Kepulauan Riau', 'Batam', 'Tanjungpinang'], kota: [
      'Batam', 'Tanjungpinang', 'Bintan', 'Karimun', 'Natuna', 'Lingga', 'Kepulauan Anambas',
    ] },
  ] },
  { pulau: 'Jawa', alias: ['Jawa'], provinsi: [
    { nama: 'DKI Jakarta', alias: ['DKI Jakarta', 'Jakarta'], kota: [
      'Jakarta', 'Jakarta Pusat', 'Jakarta Selatan', 'Jakarta Barat', 'Jakarta Timur',
      'Jakarta Utara', 'Kepulauan Seribu',
    ] },
    { nama: 'Banten', alias: ['Banten', 'Tangerang', 'Serang'], kota: [
      'Tangerang', 'Tangerang Selatan', 'Serang', 'Cilegon', 'Pandeglang', 'Lebak',
    ] },
    { nama: 'Jawa Barat', alias: ['Jawa Barat', 'Bandung', 'Bekasi', 'Depok', 'Bogor'], kota: [
      'Bandung', 'Bekasi', 'Depok', 'Bogor', 'Cimahi', 'Sukabumi', 'Tasikmalaya',
      'Banjar', 'Cirebon', 'Garut', 'Karawang', 'Purwakarta', 'Subang', 'Sumedang',
      'Indramayu', 'Majalengka', 'Kuningan', 'Cianjur', 'Bandung Barat', 'Pangandaran',
    ] },
    { nama: 'Jawa Tengah', alias: ['Jawa Tengah', 'Semarang', 'Solo', 'Surakarta'], kota: [
      'Semarang', 'Surakarta', 'Magelang', 'Salatiga', 'Pekalongan', 'Tegal', 'Kudus',
      'Klaten', 'Sukoharjo', 'Karanganyar', 'Boyolali', 'Banyumas', 'Cilacap', 'Jepara',
      'Pati', 'Rembang', 'Blora', 'Grobogan', 'Sragen', 'Wonogiri', 'Temanggung',
      'Wonosobo', 'Kendal', 'Demak', 'Brebes', 'Pemalang', 'Batang', 'Banjarnegara',
      'Purbalingga', 'Kebumen', 'Purworejo',
    ] },
    { nama: 'DI Yogyakarta', alias: ['DI Yogyakarta', 'Yogyakarta'], kota: [
      'Yogyakarta', 'Sleman', 'Bantul', 'Gunungkidul', 'Kulon Progo',
    ] },
    { nama: 'Jawa Timur', alias: ['Jawa Timur', 'Surabaya', 'Malang'], kota: [
      'Surabaya', 'Malang', 'Kediri', 'Blitar', 'Madiun', 'Mojokerto', 'Pasuruan',
      'Probolinggo', 'Batu', 'Sidoarjo', 'Gresik', 'Jember', 'Banyuwangi', 'Tuban',
      'Lamongan', 'Bojonegoro', 'Jombang', 'Nganjuk', 'Tulungagung', 'Ngawi',
      'Ponorogo', 'Pacitan', 'Trenggalek', 'Magetan', 'Lumajang', 'Bondowoso',
      'Situbondo', 'Bangkalan', 'Sampang', 'Pamekasan', 'Sumenep',
    ] },
  ] },
  { pulau: 'Kalimantan', alias: ['Kalimantan'], provinsi: [
    { nama: 'Kalimantan Barat', alias: ['Kalimantan Barat', 'Pontianak'], kota: [
      'Pontianak', 'Singkawang', 'Kubu Raya', 'Mempawah', 'Sambas', 'Bengkayang',
      'Landak', 'Sanggau', 'Sekadau', 'Sintang', 'Melawi', 'Kapuas Hulu', 'Ketapang',
      'Kayong Utara',
    ] },
    { nama: 'Kalimantan Tengah', alias: ['Kalimantan Tengah', 'Palangka Raya'], kota: [
      'Palangka Raya', 'Kotawaringin Timur', 'Kotawaringin Barat', 'Kapuas',
      'Barito Selatan', 'Barito Utara', 'Barito Timur', 'Katingan', 'Seruyan',
      'Sukamara', 'Lamandau', 'Gunung Mas', 'Murung Raya', 'Pulang Pisau',
    ] },
    { nama: 'Kalimantan Selatan', alias: ['Kalimantan Selatan', 'Banjarmasin'], kota: [
      'Banjarmasin', 'Banjarbaru', 'Banjar', 'Tanah Laut', 'Tanah Bumbu', 'Kotabaru',
      'Barito Kuala', 'Tapin', 'Hulu Sungai Selatan', 'Hulu Sungai Tengah',
      'Hulu Sungai Utara', 'Balangan', 'Tabalong',
    ] },
    { nama: 'Kalimantan Timur', alias: ['Kalimantan Timur', 'Samarinda', 'Balikpapan'], kota: [
      'Samarinda', 'Balikpapan', 'Bontang', 'Kutai Kartanegara', 'Kutai Timur',
      'Kutai Barat', 'Berau', 'Paser', 'Penajam Paser Utara', 'Mahakam Ulu',
    ] },
    { nama: 'Kalimantan Utara', alias: ['Kalimantan Utara', 'Tarakan', 'Tanjung Selor'], kota: [
      'Tarakan', 'Tanjung Selor', 'Bulungan', 'Nunukan', 'Malinau', 'Tana Tidung',
    ] },
  ] },
  { pulau: 'Sulawesi', alias: ['Sulawesi'], provinsi: [
    { nama: 'Sulawesi Utara', alias: ['Sulawesi Utara', 'Manado'], kota: [
      'Manado', 'Bitung', 'Tomohon', 'Kotamobagu', 'Minahasa', 'Minahasa Utara',
      'Minahasa Selatan', 'Minahasa Tenggara', 'Bolaang Mongondow',
      'Bolaang Mongondow Utara', 'Bolaang Mongondow Selatan', 'Bolaang Mongondow Timur',
      'Kepulauan Sangihe', 'Kepulauan Talaud', 'Kepulauan Sitaro',
    ] },
    { nama: 'Sulawesi Tengah', alias: ['Sulawesi Tengah', 'Palu'], kota: [
      'Palu', 'Donggala', 'Poso', 'Banggai', 'Banggai Kepulauan', 'Banggai Laut',
      'Morowali', 'Morowali Utara', 'Parigi Moutong', 'Tojo Una-Una', 'Tolitoli',
      'Buol', 'Sigi',
    ] },
    { nama: 'Sulawesi Selatan', alias: ['Sulawesi Selatan', 'Makassar'], kota: [
      'Makassar', 'Parepare', 'Palopo', 'Gowa', 'Maros', 'Pangkep', 'Takalar',
      'Jeneponto', 'Bantaeng', 'Bulukumba', 'Sinjai', 'Bone', 'Soppeng', 'Wajo',
      'Sidenreng Rappang', 'Pinrang', 'Enrekang', 'Luwu', 'Luwu Utara', 'Luwu Timur',
      'Tana Toraja', 'Toraja Utara', 'Selayar', 'Barru',
    ] },
    { nama: 'Sulawesi Tenggara', alias: ['Sulawesi Tenggara', 'Kendari'], kota: [
      'Kendari', 'Baubau', 'Konawe', 'Konawe Selatan', 'Konawe Utara',
      'Konawe Kepulauan', 'Kolaka', 'Kolaka Utara', 'Kolaka Timur', 'Bombana',
      'Muna', 'Muna Barat', 'Buton', 'Buton Utara', 'Buton Selatan', 'Buton Tengah',
      'Wakatobi',
    ] },
    { nama: 'Gorontalo', alias: ['Gorontalo'], kota: [
      'Gorontalo', 'Gorontalo Utara', 'Bone Bolango', 'Boalemo', 'Pohuwato',
    ] },
    { nama: 'Sulawesi Barat', alias: ['Sulawesi Barat', 'Mamuju'], kota: [
      'Mamuju', 'Majene', 'Polewali Mandar', 'Mamasa', 'Pasangkayu', 'Mamuju Tengah',
    ] },
  ] },
  { pulau: 'Bali & Nusa Tenggara', alias: ['Bali', 'Nusa Tenggara'], provinsi: [
    { nama: 'Bali', alias: ['Bali', 'Denpasar'], kota: [
      'Denpasar', 'Badung', 'Gianyar', 'Tabanan', 'Buleleng', 'Jembrana', 'Klungkung',
      'Bangli', 'Karangasem',
    ] },
    { nama: 'Nusa Tenggara Barat', alias: ['Nusa Tenggara Barat', 'Mataram', 'Lombok'], kota: [
      'Mataram', 'Bima', 'Lombok Barat', 'Lombok Tengah', 'Lombok Timur',
      'Lombok Utara', 'Sumbawa', 'Sumbawa Barat', 'Dompu',
    ] },
    { nama: 'Nusa Tenggara Timur', alias: ['Nusa Tenggara Timur', 'Kupang'], kota: [
      'Kupang', 'Ende', 'Maumere', 'Larantuka', 'Soe', 'Atambua', 'Ruteng', 'Bajawa',
      'Waingapu', 'Kefamenanu', 'Kalabahi', 'Timor Tengah Selatan', 'Timor Tengah Utara',
      'Belu', 'Malaka', 'Alor', 'Flores Timur', 'Sikka', 'Ngada', 'Nagekeo',
      'Manggarai', 'Manggarai Timur', 'Manggarai Barat', 'Sumba Timur', 'Sumba Tengah',
      'Sumba Barat', 'Sumba Barat Daya', 'Lembata', 'Rote Ndao', 'Sabu Raijua',
    ] },
  ] },
  { pulau: 'Maluku', alias: ['Maluku'], provinsi: [
    { nama: 'Maluku', alias: ['Maluku', 'Ambon'], kota: [
      'Ambon', 'Tual', 'Maluku Tengah', 'Maluku Tenggara', 'Maluku Tenggara Barat',
      'Maluku Barat Daya', 'Buru', 'Buru Selatan', 'Seram Bagian Barat',
      'Seram Bagian Timur', 'Kepulauan Aru',
    ] },
    { nama: 'Maluku Utara', alias: ['Maluku Utara', 'Ternate', 'Sofifi'], kota: [
      'Ternate', 'Tidore Kepulauan', 'Sofifi', 'Halmahera Barat', 'Halmahera Tengah',
      'Halmahera Utara', 'Halmahera Selatan', 'Halmahera Timur', 'Kepulauan Sula',
      'Pulau Morotai', 'Pulau Taliabu',
    ] },
  ] },
  { pulau: 'Papua', alias: ['Papua'], provinsi: [
    { nama: 'Papua', alias: ['Papua', 'Jayapura'], kota: [
      'Jayapura', 'Biak', 'Supiori', 'Kepulauan Yapen', 'Waropen', 'Sarmi', 'Keerom',
      'Mamberamo Raya',
    ] },
    { nama: 'Papua Barat', alias: ['Papua Barat', 'Manokwari'], kota: [
      'Manokwari', 'Fakfak', 'Kaimana', 'Teluk Bintuni', 'Teluk Wondama',
      'Manokwari Selatan', 'Pegunungan Arfak',
    ] },
    { nama: 'Papua Selatan', alias: ['Papua Selatan', 'Merauke'], kota: [
      'Merauke', 'Boven Digoel', 'Mappi', 'Asmat',
    ] },
    { nama: 'Papua Tengah', alias: ['Papua Tengah', 'Nabire'], kota: [
      'Nabire', 'Timika', 'Mimika', 'Paniai', 'Deiyai', 'Dogiyai', 'Intan Jaya',
      'Puncak', 'Puncak Jaya',
    ] },
    { nama: 'Papua Pegunungan', alias: ['Papua Pegunungan', 'Wamena'], kota: [
      'Wamena', 'Jayawijaya', 'Lanny Jaya', 'Mamberamo Tengah', 'Nduga', 'Tolikara',
      'Yahukimo', 'Yalimo',
    ] },
    { nama: 'Papua Barat Daya', alias: ['Papua Barat Daya', 'Sorong'], kota: [
      'Sorong', 'Sorong Selatan', 'Raja Ampat', 'Tambrauw', 'Maybrat',
    ] },
  ] },
];

const SEMUA_PROVINSI = WILAYAH.flatMap((w) => w.provinsi.map((x) => x.nama));
const KOTA_PER_PROVINSI = new Map(WILAYAH.flatMap((w) => w.provinsi.map((p) => [p.nama, p.kota || []])));
const SEMUA_KOTA = [...new Set([...KOTA_PER_PROVINSI.values()].flat())];

/* ---------- Validasi input dari halaman (whitelist, tanpa injeksi) ---------- */
export function validateOps(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.provinsi) || !b.provinsi.length) {
    throw new Error('Pilih minimal satu provinsi.');
  }
  const nama = b.provinsi.map((s) => String(s).trim());
  const salah = nama.filter((s) => !SEMUA_PROVINSI.includes(s));
  if (salah.length) throw new Error('Provinsi tidak dikenal: ' + salah.join(', '));
  if (!['today', '3', '7', '14'].includes(String(b.umur))) {
    throw new Error('Umur lowongan harus: today, 3, 7, atau 14 hari.');
  }
  const angka = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 5 ? n : fallback;
  };
  const skorMin = angka(b.skorMin, 0);
  const skorMax = angka(b.skorMax, 5);
  if (skorMin > skorMax) throw new Error('Skor minimum tidak boleh lebih besar dari skor maksimum.');

  // Gaji per bulan dalam Rupiah. Kosong/0 = tidak menyaring gaji.
  const gajiAngka = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return 0;
    const n = Number(String(v).replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n >= 0 && n <= 100_000_000 ? n : null;
  };
  const gajiMin = gajiAngka(b.gajiMin);
  const gajiMax = gajiAngka(b.gajiMax);
  if (gajiMin === null || gajiMax === null) throw new Error('Rentang gaji tidak valid.');
  if (gajiMin && gajiMax && gajiMin > gajiMax) {
    throw new Error('Gaji minimum tidak boleh lebih besar dari gaji maksimum.');
  }
  const gajiWajib = b.gajiWajib === true || b.gajiWajib === 'true' || b.gajiWajib === 1;

  // Kata kunci jabatan dari targeting per CV. Opsional: bila tidak dikirim,
  // daftar positive bawaan portals.yml dipakai seperti sebelumnya.
  let kataKunci;
  if (b.kataKunci !== undefined && b.kataKunci !== null && b.kataKunci !== '') {
    if (!Array.isArray(b.kataKunci)) throw new Error('Kata kunci jabatan tidak valid.');
    kataKunci = b.kataKunci
      .map((s) => String(s || '').trim().replace(/\s+/g, ' '))
      .filter((s) => /^[\p{L}\p{N}][\p{L}\p{N} +.'&-]{1,59}$/u.test(s))
      .slice(0, 14);
    if (!kataKunci.length) throw new Error('Kata kunci jabatan tidak dikenal.');
  }

  // Kota/kabupaten opsional: hanya untuk provinsi yang dipilih. Nama dicocokkan
  // ke daftar resmi (tanpa beda huruf besar/kecil) supaya input bebas tidak
  // menjadi token lokasi sembarangan.
  const dipilih = new Set(nama);
  const kota = {};
  if (b.kota && typeof b.kota === 'object' && !Array.isArray(b.kota)) {
    for (const [prov, isi] of Object.entries(b.kota)) {
      if (!dipilih.has(String(prov).trim())) continue;
      const provinsiNama = String(prov).trim();
      const daftar = KOTA_PER_PROVINSI.get(provinsiNama) || [];
      const pakai = [];
      for (const x of (Array.isArray(isi) ? isi : [])) {
        const cari = String(x).trim();
        if (!cari) continue;
        const cocok = daftar.find((k) => k.toLowerCase() === cari.toLowerCase());
        if (!cocok) throw new Error('Kota/kabupaten tidak dikenal di ' + provinsiNama + ': ' + cari);
        if (!pakai.includes(cocok)) pakai.push(cocok);
      }
      if (pakai.length) kota[provinsiNama] = pakai;
    }
  }

  // Wilayah lain di luar daftar: teks pendek yang wajar, maksimal 10 entri.
  const kotaLain = (Array.isArray(b.kotaLain) ? b.kotaLain : [])
    .map((s) => String(s).trim().replace(/\s+/g, ' '))
    .filter((s) => /^[\p{L}][\p{L} .'-]{1,39}$/u.test(s))
    .slice(0, 10);

  return {
    provinsi: [...dipilih], umur: String(b.umur), skorMin, skorMax,
    gajiMin, gajiMax, gajiWajib, kota, kotaLain, kataKunci,
  };
}

/* ---------- Susun token lokasi ---------- */
// Provinsi tanpa kota terpilih memakai seluruh alias-nya (perilaku lama).
// Provinsi dengan kota terpilih HANYA memakai nama kota itu, supaya memilih
// "Pekanbaru" tidak ikut menarik seluruh Riau.
export function tokenLokasi(provinsi, kota = {}, kotaLain = []) {
  const dipilih = new Set(provinsi);
  const spesifik = (nama) => Array.isArray(kota[nama]) && kota[nama].length > 0;
  const token = [];
  const tambah = (t) => { if (t && !token.includes(t)) token.push(t); };
  for (const w of WILAYAH) {
    if (!w.provinsi.every((x) => dipilih.has(x.nama))) continue;
    if (w.provinsi.some((x) => spesifik(x.nama))) continue;
    w.alias.forEach(tambah);
  }
  for (const p of WILAYAH.flatMap((w) => w.provinsi)) {
    if (!dipilih.has(p.nama)) continue;
    if (spesifik(p.nama)) kota[p.nama].forEach(tambah);
    else p.alias.forEach(tambah);
  }
  for (const t of (Array.isArray(kotaLain) ? kotaLain : [])) tambah(t);
  return token;
}

/* ---------- Timpa dua daftar lokasi di salinan portals.yml ---------- */
export function gantiLokasi(teks, token) {
  const eol = teks.includes('\r\n') ? '\r\n' : '\n';
  const blok = teks.match(/^(location_filter:\r?\n[\s\S]*?)(?=^#|^[A-Za-z_])/m);
  if (!blok) throw new Error('Blok location_filter tidak ditemukan di portals.yml');
  const isiBlok = blok[1];
  // Baris kosong penutup blok ikut terseret regex di atas, tetapi splice() di
  // bawah membuangnya. Simpan dulu supaya komentar/bagian sesudahnya tidak
  // menempel pada elemen daftar terakhir (penyebab YAMLException 781:14).
  const penutup = (isiBlok.match(/(\r?\n)+$/) || [eol])[0];
  const daftar = token.map((t) => `    - ${JSON.stringify(t)}`);
  const gantiSatu = (isi, nama) => {
    const baris = isi.split(eol);
    const awal = baris.findIndex((l) => new RegExp(`^\\s{2}${nama}:\\s*$`).test(l));
    if (awal < 0) return isi;
    let akhir = awal + 1;
    while (akhir < baris.length && (/^\s{4,}-\s/.test(baris[akhir]) || /^\s{4,}#/.test(baris[akhir]) || baris[akhir] === '')) akhir++;
    baris.splice(awal, akhir - awal, `  ${nama}:`, ...daftar);
    return baris.join(eol);
  };
  let isi = isiBlok;
  isi = gantiSatu(isi, 'always_allow');
  isi = gantiSatu(isi, 'allow');
  isi = isi.replace(/(\r?\n)*$/, penutup);
  return teks.replace(isiBlok, isi);
}

/* ---------- Judul: timpa positive filter hanya di salinan sementara ----------
   Kata kunci berasal dari targeting per CV (bukan ditebak). Blok negative dan
   semua pengaturan lain dibiarkan utuh, supaya filter magang/staf junior yang
   sudah ada tetap berlaku. */
export function gantiJudul(teks, kataKunci) {
  if (!Array.isArray(kataKunci) || !kataKunci.length) return teks;
  const eol = teks.includes('\r\n') ? '\r\n' : '\n';
  const baris = teks.split(eol);
  const awalTitle = baris.findIndex((l) => /^title_filter:\s*$/.test(l));
  if (awalTitle < 0) throw new Error('Blok title_filter tidak ditemukan di portals.yml');
  let awal = -1;
  for (let i = awalTitle + 1; i < baris.length; i++) {
    if (/^[A-Za-z_]/.test(baris[i])) break;
    if (/^\s{2}positive:\s*$/.test(baris[i])) { awal = i; break; }
  }
  if (awal < 0) throw new Error('Daftar positive tidak ditemukan di title_filter');
  let akhir = awal + 1;
  while (akhir < baris.length) {
    const l = baris[akhir];
    if (/^[^\s#]/.test(l)) break;
    if (/^\s{0,2}[A-Za-z_][\w-]*:\s*$/.test(l)) break;
    akhir++;
  }
  const daftar = kataKunci.map((k) => `    - ${JSON.stringify(String(k).slice(0, 60))}`);
  baris.splice(awal, akhir - awal, '  positive:', ...daftar, '');
  return baris.join(eol);
}

/* ---------- Gaji: filter mesin + pembaca gaji Jobstreet ---------- */
// scan.mjs menerima salary_filter tahunan di portals.yml. Nilai dari panel
// adalah gaji per bulan, jadi dikalikan 12 di sini. Blok ini HANYA masuk ke
// portals.yml sementara; portals.yml pengguna tidak pernah disentuh.
export function gantiSalary(teks, min, max) {
  if (!(min > 0 || max > 0)) return teks;
  const eol = teks.includes('\r\n') ? '\r\n' : '\n';
  const blok = [
    'salary_filter:',
    `  min: ${Math.round(min * 12)}`,
    `  max: ${Math.round(max * 12)}`,
    '  currency: "IDR"',
    '',
    '',
  ].join(eol);
  const penanda = '# -- Salary filter (optional) --';
  if (teks.includes(penanda)) return teks.replace(penanda, () => blok + penanda);
  return teks.replace(/(\r?\n)*$/, eol + eol + blok);
}

// Alihkan entri Jobstreet ke pembungkus lokal yang membaca salaryLabel.
// `hanya_gaji` dipakai pembungkus itu untuk membuang lowongan tanpa gaji
// ketika pengguna mencentang "hanya yang mencantumkan gaji".
export function gantiProvider(teks, wajibGaji) {
  const eol = teks.includes('\r\n') ? '\r\n' : '\n';
  return teks.replace(/^(\s*)provider:\s*jobstreet\s*$/gm, (_, spasi) => wajibGaji
    ? `${spasi}provider: jobstreet-gaji${eol}${spasi}hanya_gaji: true`
    : `${spasi}provider: jobstreet-gaji`);
}

// Tampilkan gaji tahunan dari pipeline sebagai gaji per bulan yang dibulatkan.
export function formatGajiBulanan(teks) {
  const m = String(teks || '').match(/^(\d+)(?:-(\d+))?\s+([A-Z]{3})$/);
  if (!m) return '';
  const rupiah = (n) => 'Rp ' + Math.round(Number(n) / 12).toLocaleString('id-ID');
  return m[2] && m[2] !== m[1]
    ? `${rupiah(m[1])} – ${rupiah(m[2])}/bulan`
    : `${rupiah(m[1])}/bulan`;
}

/* ---------- Baca resi JSON dari stdout scan.mjs ---------- */
export function ambilResi(out) {
  const baris = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('{'));
  for (let i = baris.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(baris[i]);
      if (o && Array.isArray(o.added_urls)) return o;
    } catch { /* baris log biasa */ }
  }
  return null;
}

/* ---------- ID stabil untuk berkas hasil scan ----------
   Scan tidak punya nomor laporan, jadi berkas CV/suratnya tidak boleh memakai
   nomor 3 digit (generate-pdf.mjs akan mengiranya sebagai nomor laporan).
   Hash URL dipakai sebagai kunci: sama untuk URL yang sama, beda untuk
   lowongan lain, dan tetap benar setelah halaman dimuat ulang. */
export function idScan(url) {
  return 'scan-' + createHash('sha256').update(String(url || '').trim()).digest('hex').slice(0, 10);
}

/* ---------- Baca segmen note: dari baris pipeline ---------- */
// scan.mjs menulis note: di akhir baris. Provider jobstreet-gaji mengisi
// teks ringkas iklan di sana; tidak ada tanda '|' di dalam teks tersebut.
export function ambilNoteBaris(baris) {
  const m = String(baris || '').match(/\|\s*note:\s*(.+?)\s*$/);
  return m ? m[1] : '';
}

/* ---------- Ambil detail lowongan baru dari pipeline ---------- */
export function detailPipeline(urls) {
  const set = new Set(urls);
  if (!set.size || !fs.existsSync(PIPELINE())) return [];
  const keluar = [];
  for (const l of fs.readFileSync(PIPELINE(), 'utf8').split(/\r?\n/)) {
    if (!/^- \[ \] /.test(l)) continue;
    const c = l.replace(/^- \[ \] /, '').split(' | ');
    if (!set.has(c[0])) continue;
    const posted = (l.match(/posted:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    // Kolom ke-5 pipeline adalah kompensasi tahunan bila lowongan mencantumkan gaji.
    const gaji = /^\d+(?:-\d+)?\s+[A-Z]{3}$/.test(c[4] || '') ? c[4] : '';
    const location = c[3] || '';
    keluar.push({
      url: c[0], company: c[1] || '', title: c[2] || '', location, posted,
      gaji, gajiTeks: formatGajiBulanan(gaji),
      jdText: ambilNoteBaris(l), scanId: idScan(c[0]),
    });
  }
  return keluar;
}

/* ---------- Jalankan scan ---------- */
export async function jalankanScan(ops) {
  const opsi = validateOps(ops);
  if (!fs.existsSync(PORTAL_ASLI)) throw new Error('portals.yml tidak ditemukan.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'co-scan-ui-'));
  const portalsTmp = path.join(tmp, 'portals.yml');
  try {
    const asli = fs.readFileSync(PORTAL_ASLI, 'utf8').replace(/^\uFEFF/, '');
    let isi = gantiLokasi(asli, tokenLokasi(opsi.provinsi, opsi.kota, opsi.kotaLain));
    isi = gantiJudul(isi, opsi.kataKunci);
    isi = gantiSalary(isi, opsi.gajiMin, opsi.gajiMax);
    isi = gantiProvider(isi, opsi.gajiWajib);
    fs.writeFileSync(portalsTmp, isi, 'utf8');

    const args = [SKRIP_SCAN, '--quiet', '--json'];
    if (opsi.umur === 'today') {
      const hariIni = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD lokal
      args.push('--posted-after', hariIni);
    } else {
      args.push('--since', opsi.umur);
    }

    const jalan = await new Promise((resolve) => {
      const anak = spawn(process.execPath, args, {
        cwd: ROOT,
        env: { ...process.env, CAREER_OPS_ROOT: rootData(), CAREER_OPS_PORTALS: portalsTmp },
        windowsHide: true,
      });
      let out = '', err = '';
      anak.stdout.on('data', (d) => { out += d.toString(); });
      anak.stderr.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => { try { anak.kill('SIGTERM'); } catch {} }, 15 * 60 * 1000);
      anak.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
      anak.on('close', (kode) => { clearTimeout(timer); resolve({ kode, out, err }); });
    });

    if (jalan.error) throw new Error(jalan.error);
    const resi = ambilResi(jalan.out);
    if (!resi) {
      const potongan = String(jalan.err || jalan.out || '').trim().slice(-700);
      throw new Error('Scan tidak menghasilkan resi. ' + (potongan || `kode keluar ${jalan.kode}`));
    }
    const urls = resi.added_urls || [];
    return {
      ok: true,
      kode: jalan.kode,
      dipindai: resi.scanned ?? 0,
      ditemukan: resi.found ?? 0,
      ditambahkan: resi.added ?? urls.length,
      dilewati: resi.skipped ?? 0,
      duplikat: resi.duplicates ?? 0,
      galat: resi.errors || [],
      peringatan: jalan.kode === 2 ? 'Sebagian board gagal dibaca; hasil mungkin tidak lengkap.' : '',
      lowongan: detailPipeline(urls),
      wilayah: opsi.provinsi,
      kota: opsi.kota,
      kotaLain: opsi.kotaLain,
      umur: opsi.umur,
      gajiMin: opsi.gajiMin,
      gajiMax: opsi.gajiMax,
      gajiWajib: opsi.gajiWajib,
      kataKunci: opsi.kataKunci || [],
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* abai */ }
  }
}
