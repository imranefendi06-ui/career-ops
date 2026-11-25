// konteks-root.mjs — root data yang mengikuti request, bukan variabel global.
//
// Fase 4 memakai satu root global karena hanya ada satu pengguna. Fase 5
// melayani banyak pengguna di satu proses: setiap request harus membawa root
// sendiri. AsyncLocalStorage menjaga root itu tetap melekat walau ada await,
// timer, atau fetch di dalam request yang sama.

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const alk = new AsyncLocalStorage();

export function denganKonteks(ctx, fn) {
  return alk.run(ctx, fn);
}

export function konteksAktif() {
  return alk.getStore() || null;
}

export function rootAktif() {
  return konteksAktif()?.root || null;
}

/** Root data milik akun, sebelum memilih profil lokal di dalamnya. */
export function rootPenggunaAktif() {
  return konteksAktif()?.rootPengguna || rootAktif();
}

export function penggunaAktif() {
  return konteksAktif()?.pengguna || null;
}

export function csrfAktif() {
  return konteksAktif()?.csrf || '';
}

/** Dipakai endpoint /profil/pakai setelah registry profil berubah. */
export function tetapkanRoot(root) {
  const ctx = konteksAktif();
  if (ctx) ctx.root = path.resolve(root);
}
