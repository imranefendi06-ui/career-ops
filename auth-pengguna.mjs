// auth-pengguna.mjs — akun, kata sandi, sesi, dan batas percobaan login.
//
// Prinsip:
//   - Registry akun ada di user layer: {BASE_ROOT}/data/pengguna.json.
//   - Kata sandi TIDAK pernah disimpan apa-adanya. Pakai scrypt + salt acak.
//   - Sesi disimpan di memori proses: restart server = semua orang logout.
//   - Akun pertama ("pemilik") memetakan root data yang sudah ada; akun lain
//     mendapat root kosong di {BASE_ROOT}/pengguna/{id}/.
//   - Fase 6: pendaftaran mandiri lewat email + kode verifikasi 6 digit.
//     Modul ini hanya membuat/menyimpan kode. Pengiriman ada di email-kirim.mjs;
//     bila provider belum dikonfigurasi, ringkasan.mjs menampilkan kode di halaman.
//   - Kredit trial dan pembayaran dikelola modul kuota.mjs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { siapkanRootKosong } from './profil-lokal.mjs';

const NAMA_FILE = 'pengguna.json';
const ID_VALID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SESI_VALID_MS = 12 * 60 * 60 * 1000;
const BATAS_GAGAL = 5;
const JENDELA_GAGAL_MS = 15 * 60 * 1000;
const KODE_VERIFIKASI_MS = 10 * 60 * 1000;
const LUPA_SANDI_MS = 30 * 60 * 1000;
const KREDIT_TRIAL = 3;
const EMAIL_VALID = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOMAIN_SEKALI_PAKAI = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com',
  'throwaway.email', 'yopmail.com', 'trashmail.com', 'dispostable.com',
]);

const fileDaftar = (base) => path.join(path.resolve(base), 'data', NAMA_FILE);
const dua = (n) => String(n).padStart(2, '0');
const waktu = () => {
  const d = new Date();
  return `${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())} ${dua(d.getHours())}:${dua(d.getMinutes())}`;
};
const tulisAtomik = (file, isi) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, isi, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
};

function muat(base) {
  const file = fileDaftar(base);
  if (!fs.existsSync(file)) return { versi: 1, daftar: [] };
  const o = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') || '{}');
  if (!o || !Array.isArray(o.daftar)) throw new Error('Daftar akun rusak.');
  return { versi: 1, daftar: o.daftar.filter((u) => u && ID_VALID.test(u.id) && u.garam && u.hash) };
}

function simpan(base, isi) {
  tulisAtomik(fileDaftar(base), JSON.stringify(isi, null, 2) + '\n');
}

const hashSandi = (sandi, garam) => crypto.scryptSync(String(sandi), garam, 64).toString('hex');
const sandiAcak = () => crypto.randomBytes(12).toString('base64url');

/** Versi daftar akun yang aman dikirim ke browser. */
const tampil = (u) => ({
  id: u.id,
  nama: u.nama,
  email: u.email || '',
  emailTerverifikasi: !!u.emailTerverifikasi,
  pemilik: !!u.pemilik,
  aktif: u.aktif !== false,
  harusGanti: !!u.harusGanti,
  dibuat: u.dibuat || '',
});

export function daftarPengguna(base) {
  return muat(base).daftar.map(tampil);
}

export function cariPenggunaId(base, id) {
  return muat(base).daftar.find((u) => u.id === id) || null;
}

export function cariPenggunaNama(base, nama) {
  const kunci = String(nama || '').trim().toLowerCase();
  if (!kunci) return null;
  return muat(base).daftar.find((u) => u.id === kunci
    || String(u.nama).trim().toLowerCase() === kunci
    || String(u.email || '').trim().toLowerCase() === kunci) || null;
}

export function cariPenggunaEmail(base, email) {
  const kunci = String(email || '').trim().toLowerCase();
  if (!kunci) return null;
  return muat(base).daftar.find((u) => String(u.email || '').trim().toLowerCase() === kunci) || null;
}

export function rootDariPengguna(base, pengguna) {
  return pengguna?.root ? path.resolve(base, pengguna.root) : path.resolve(base);
}

export function verifikasiKataSandi(pengguna, sandi) {
  if (!pengguna || pengguna.aktif === false) return false;
  try {
    const a = Buffer.from(hashSandi(sandi, pengguna.garam), 'hex');
    const b = Buffer.from(pengguna.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function siapkanRegistryProfil(root) {
  const file = path.join(root, 'data', 'profil-lokal.json');
  if (fs.existsSync(file)) return;
  tulisAtomik(file, JSON.stringify({
    versi: 1,
    aktif: 'utama',
    daftar: [{ id: 'utama', nama: 'Profil Utama', root: null, dibuat: waktu() }],
  }, null, 2) + '\n');
}

export function buatPengguna(base, o) {
  try {
    const id = String(o?.id || '').trim().toLowerCase();
    const nama = String(o?.nama || '').trim().slice(0, 60);
    if (!ID_VALID.test(id)) return { ok: false, error: 'id harus huruf kecil, angka, atau tanda hubung (maks. 32 karakter).' };
    if (!nama) return { ok: false, error: 'Nama akun wajib diisi.' };
    const isi = muat(base);
    if (isi.daftar.some((u) => u.id === id || String(u.nama).trim().toLowerCase() === nama.toLowerCase())) {
      return { ok: false, error: 'Akun dengan id atau nama itu sudah ada.' };
    }
    const pemilik = !!o.pemilik;
    if (pemilik && isi.daftar.some((u) => u.pemilik)) {
      return { ok: false, error: 'Akun pemilik sudah ada. Hanya boleh satu.' };
    }
    if (!pemilik) {
      const root = path.resolve(base, 'pengguna', id);
      if (!root.startsWith(path.resolve(base) + path.sep)) return { ok: false, error: 'Lokasi akun tidak sah.' };
      siapkanRootKosong(root);
      siapkanRegistryProfil(root);
    }
    const garam = crypto.randomBytes(16).toString('hex');
    const sandiSementara = sandiAcak();
    const pengguna = {
      id, nama, pemilik,
      root: pemilik ? null : path.join('pengguna', id).split(path.sep).join('/'),
      aktif: true,
      harusGanti: true,
      garam,
      hash: hashSandi(sandiSementara, garam),
      email: String(o.email || '').trim().toLowerCase(),
      emailTerverifikasi: !!o.email,
      sisaKredit: pemilik ? 0 : KREDIT_TRIAL,
      trialDiberikan: !pemilik,
      dibuat: waktu(),
    };
    isi.daftar.push(pengguna);
    simpan(base, isi);
    return { ok: true, pengguna: tampil(pengguna), sandiSementara };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Pendaftaran mandiri. Mengembalikan kode verifikasi untuk ditampilkan (mode uji). */
export function daftarPenggunaEmail(base, o) {
  try {
    const email = String(o?.email || '').trim().toLowerCase();
    if (!EMAIL_VALID.test(email)) return { ok: false, error: 'Alamat email tidak sah.' };
    const domain = email.split('@')[1];
    if (DOMAIN_SEKALI_PAKAI.has(domain)) {
      return { ok: false, error: 'Domain email sementara tidak dipakai untuk trial.' };
    }
    const sandi = String(o?.sandi || '');
    if (sandi.length < 10) return { ok: false, error: 'Kata sandi minimal 10 karakter.' };
    const isi = muat(base);
    if (isi.daftar.some((u) => String(u.email || '').toLowerCase() === email
      || String(u.nama || '').toLowerCase() === email)) {
      return { ok: false, error: 'Email ini sudah terdaftar. Silakan masuk.' };
    }
    const id = 'u' + crypto.randomBytes(6).toString('hex');
    const root = path.resolve(base, 'pengguna', id);
    if (!root.startsWith(path.resolve(base) + path.sep)) return { ok: false, error: 'Lokasi akun tidak sah.' };
    siapkanRootKosong(root);
    siapkanRegistryProfil(root);

    const kode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const kodeGaram = crypto.randomBytes(8).toString('hex');
    const kodeHash = crypto.createHash('sha256').update(kodeGaram + kode).digest('hex');
    const garam = crypto.randomBytes(16).toString('hex');
    const pengguna = {
      id,
      nama: email,
      email,
      emailTerverifikasi: false,
      kodeGaram,
      kodeHash,
      kodeHabis: Date.now() + KODE_VERIFIKASI_MS,
      sisaKredit: 0,
      trialDiberikan: false,
      root: path.join('pengguna', id).split(path.sep).join('/'),
      aktif: true,
      harusGanti: false,
      garam,
      hash: hashSandi(sandi, garam),
      dibuat: waktu(),
    };
    isi.daftar.push(pengguna);
    simpan(base, isi);

    return { ok: true, pengguna: tampil(pengguna), email, kode };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Buat kode baru untuk akun yang belum terverifikasi. */
export function kirimUlangKodeEmail(base, email) {
  try {
    const isi = muat(base);
    const e = String(email || '').trim().toLowerCase();
    const u = isi.daftar.find((x) => String(x.email || '').toLowerCase() === e);
    if (!u) return { ok: false, error: 'Akun tidak ditemukan.' };
    if (u.emailTerverifikasi) return { ok: false, error: 'Email ini sudah terverifikasi. Silakan masuk.' };
    const kode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    u.kodeGaram = crypto.randomBytes(8).toString('hex');
    u.kodeHash = crypto.createHash('sha256').update(u.kodeGaram + kode).digest('hex');
    u.kodeHabis = Date.now() + KODE_VERIFIKASI_MS;
    simpan(base, isi);
    return { ok: true, email: e, kode };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Verifikasi kode 6 digit. Trial 3 kredit diberikan tepat sekali. */
export function verifikasiEmail(base, email, kode) {
  try {
    const isi = muat(base);
    const u = isi.daftar.find((x) => String(x.email || '').toLowerCase() === String(email || '').trim().toLowerCase());
    if (!u) return { ok: false, error: 'Akun tidak ditemukan.' };
    if (u.emailTerverifikasi) return { ok: true, sudah: true, pengguna: tampil(u) };
    if (!u.kodeHash || !u.kodeHabis || u.kodeHabis < Date.now()) {
      return { ok: false, error: 'Kode kedaluwarsa. Daftar lagi untuk mendapat kode baru.' };
    }
    const masukan = crypto.createHash('sha256').update(u.kodeGaram + String(kode || '').trim()).digest('hex');
    const a = Buffer.from(masukan, 'hex');
    const b = Buffer.from(u.kodeHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: 'Kode verifikasi salah.' };
    }
    delete u.kodeGaram;
    delete u.kodeHash;
    delete u.kodeHabis;
    u.emailTerverifikasi = true;
    if (!u.trialDiberikan) {
      u.sisaKredit = KREDIT_TRIAL;
      u.trialDiberikan = true;
    }
    simpan(base, isi);
    return { ok: true, pengguna: tampil(u) };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function gantiSandi(base, id, sandiLama, sandiBaru) {
  try {
    const isi = muat(base);
    const u = isi.daftar.find((x) => x.id === id);
    if (!u) return { ok: false, error: 'Akun tidak ditemukan.' };
    if (!verifikasiKataSandi(u, sandiLama)) return { ok: false, error: 'Kata sandi lama salah.' };
    const baru = String(sandiBaru || '');
    if (baru.length < 10) return { ok: false, error: 'Kata sandi baru minimal 10 karakter.' };
    u.garam = crypto.randomBytes(16).toString('hex');
    u.hash = hashSandi(baru, u.garam);
    u.harusGanti = false;
    simpan(base, isi);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

const hashTokenLupa = (garam, token) =>
  crypto.createHash('sha256').update(garam + token).digest('hex');
const TOKEN_LUPA_VALID = /^[A-Za-z0-9_-]{43}$/;

/** Buat token sekali pakai untuk atur ulang sandi. Token tidak disimpan apa-adanya. */
export function buatTokenLupaSandi(base, email) {
  try {
    const isi = muat(base);
    const e = String(email || '').trim().toLowerCase();
    const u = isi.daftar.find((x) => String(x.email || '').toLowerCase() === e);
    if (!u) return { ok: false, error: 'Akun tidak ditemukan.' };
    if (u.aktif === false) return { ok: false, error: 'Akun tidak aktif.' };
    const token = crypto.randomBytes(32).toString('base64url');
    u.lupaGaram = crypto.randomBytes(8).toString('hex');
    u.lupaHash = hashTokenLupa(u.lupaGaram, token);
    u.lupaHabis = Date.now() + LUPA_SANDI_MS;
    simpan(base, isi);
    return { ok: true, email: e, token };
  } catch (e) { return { ok: false, error: e.message }; }
}

function akunDariTokenLupa(isi, token) {
  return isi.daftar.find((x) => {
    if (!x.lupaHash || !x.lupaHabis || x.lupaHabis < Date.now()) return false;
    try {
      const a = Buffer.from(hashTokenLupa(x.lupaGaram, token), 'hex');
      const b = Buffer.from(x.lupaHash, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }) || null;
}

export function cariAkunDariTokenLupa(base, token) {
  try {
    const t = String(token || '');
    if (!TOKEN_LUPA_VALID.test(t)) return { ok: false, error: 'Tautan tidak sah.' };
    const u = akunDariTokenLupa(muat(base), t);
    if (!u) return { ok: false, error: 'Tautan tidak sah atau kedaluwarsa.' };
    return { ok: true, pengguna: tampil(u) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Pakai token sekali, ganti sandi, dan logout semua sesi akun ini. */
export function setSandiDariLupa(base, token, sandiBaru) {
  try {
    const t = String(token || '');
    if (!TOKEN_LUPA_VALID.test(t)) return { ok: false, error: 'Tautan tidak sah.' };
    const baru = String(sandiBaru || '');
    if (baru.length < 10) return { ok: false, error: 'Kata sandi minimal 10 karakter.' };
    const isi = muat(base);
    const u = akunDariTokenLupa(isi, t);
    if (!u) return { ok: false, error: 'Tautan tidak sah atau kedaluwarsa.' };
    u.garam = crypto.randomBytes(16).toString('hex');
    u.hash = hashSandi(baru, u.garam);
    u.harusGanti = false;
    delete u.lupaGaram;
    delete u.lupaHash;
    delete u.lupaHabis;
    simpan(base, isi);
    for (const [tok, s] of sesi) if (s.id === u.id) sesi.delete(tok);
    return { ok: true, pengguna: tampil(u) };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function resetSandi(base, id) {
  try {
    const isi = muat(base);
    const u = isi.daftar.find((x) => x.id === id);
    if (!u) return { ok: false, error: 'Akun tidak ditemukan.' };
    u.garam = crypto.randomBytes(16).toString('hex');
    const sandiSementara = sandiAcak();
    u.hash = hashSandi(sandiSementara, u.garam);
    u.harusGanti = true;
    simpan(base, isi);
    // Sesi lama tidak boleh tetap masuk setelah sandi di-reset.
    for (const [token, s] of sesi) if (s.id === id) sesi.delete(token);
    return { ok: true, sandiSementara };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function setAktif(base, id, aktif) {
  try {
    const isi = muat(base);
    const u = isi.daftar.find((x) => x.id === id);
    if (!u) return { ok: false, error: 'Akun tidak ditemukan.' };
    u.aktif = !!aktif;
    simpan(base, isi);
    for (const [token, s] of sesi) if (s.id === id) sesi.delete(token);
    return { ok: true, pengguna: tampil(u) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* ---------- Sesi ---------- */
const sesi = new Map();

export function buatSesi(id, harusGanti) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  sesi.set(token, { id, csrf, harusGanti: !!harusGanti, dibuat: Date.now(), habis: Date.now() + SESI_VALID_MS });
  return { token, csrf };
}

export function bacaSesi(token) {
  if (!token) return null;
  const s = sesi.get(token);
  if (!s) return null;
  if (s.habis < Date.now()) { sesi.delete(token); return null; }
  return s;
}

export function hapusSesi(token) { if (token) sesi.delete(token); }
export function tandaiSandiDiubah(token) {
  const s = token ? sesi.get(token) : null;
  if (s) s.harusGanti = false;
}

export function cookieSesi(token, secure) {
  return `rk_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESI_VALID_MS / 1000)}${secure ? '; Secure' : ''}`;
}

/* ---------- Pembatas percobaan login ---------- */
const gagal = new Map();

export function izinCoba(ip) {
  const kunci = String(ip || '-');
  const g = gagal.get(kunci);
  if (!g || g.habis < Date.now()) return true;
  return g.n < BATAS_GAGAL;
}

export function catatGagal(ip) {
  const kunci = String(ip || '-');
  const g = gagal.get(kunci);
  if (!g || g.habis < Date.now()) gagal.set(kunci, { n: 1, habis: Date.now() + JENDELA_GAGAL_MS });
  else g.n += 1;
}

export function hapusGagal(ip) { gagal.delete(String(ip || '-')); }
