#!/usr/bin/env node
// pengguna.mjs — kelola akun ringkasan dari terminal, bukan dari halaman web.
//
// Contoh:
//   node pengguna.mjs tambah --id pemilik --nama "Pemilik" --pemilik
//   node pengguna.mjs tambah --id andi --nama "Andi"
//   node pengguna.mjs daftar
//   node pengguna.mjs reset --id andi
//   node pengguna.mjs nonaktifkan --id andi
//
// Kata sandi awal/kata sandi reset HANYA tampil sekali di sini. Jangan
// menempelkannya ke chat, tiket, atau berkas yang bisa dibaca orang lain.

import path from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  daftarPengguna, buatPengguna, resetSandi, setAktif,
} from './auth-pengguna.mjs';

const BASE = path.resolve(getCareerOpsRoot());
const args = process.argv.slice(2);
const cmd = (args[0] || 'daftar').toLowerCase();
const opsi = {};
for (let i = 1; i < args.length; i += 1) {
  if (args[i].startsWith('--')) opsi[args[i].slice(2)] = args[i + 1]?.startsWith('--') ? true : (args[++i] ?? true);
}

function keluar(obj, kode = 0) {
  console.log(JSON.stringify(obj, null, 2));
  process.exit(kode);
}

if (cmd === 'daftar') {
  keluar({ ok: true, daftar: daftarPengguna(BASE) });
} else if (cmd === 'tambah') {
  const r = buatPengguna(BASE, { id: opsi.id, nama: opsi.nama, pemilik: opsi.pemilik === true || opsi.pemilik === 'true' });
  keluar(r, r.ok ? 0 : 1);
} else if (cmd === 'reset') {
  const r = resetSandi(BASE, opsi.id);
  keluar(r, r.ok ? 0 : 1);
} else if (cmd === 'nonaktifkan') {
  const r = setAktif(BASE, opsi.id, false);
  keluar(r, r.ok ? 0 : 1);
} else if (cmd === 'aktifkan') {
  const r = setAktif(BASE, opsi.id, true);
  keluar(r, r.ok ? 0 : 1);
} else {
  keluar({ ok: false, error: 'Perintah tidak dikenal. Gunakan: daftar | tambah | reset | nonaktifkan | aktifkan' }, 1);
}
