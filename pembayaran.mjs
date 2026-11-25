// pembayaran.mjs — paket kredit, Midtrans Snap, dan webhook.
//
// Tidak ada nomor kartu yang disimpan di sini: Snap Midtrans yang menangani.
// Konfigurasi lewat environment (disarankan di .env root career-ops):
//
//   MIDTRANS_SERVER_KEY=...
//   MIDTRANS_CLIENT_KEY=...
//   MIDTRANS_PRODUCTION=false
//   APP_PUBLIC_URL=https://<tailnet>.ts.net
//
// Webhook: POST /pembayaran/webhook → verifikasi SHA512 lalu tambah kredit sekali.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HARGA, tambahKredit } from './kuota.mjs';

const serverKey = () => String(process.env.MIDTRANS_SERVER_KEY || '').trim();
const clientKey = () => String(process.env.MIDTRANS_CLIENT_KEY || '').trim();
const produksi = () => String(process.env.MIDTRANS_PRODUCTION || '').trim().toLowerCase() === 'true';
const apiSnap = () => produksi()
  ? 'https://app.midtrans.com/snap/v1/transactions'
  : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
const snapJs = () => produksi()
  ? 'https://app.midtrans.com/snap/snap.js'
  : 'https://app.sandbox.midtrans.com/snap/snap.js';

export function daftarPaket() {
  return [
    ...HARGA.paket.map((p) => ({
      id: `p${p.kredit}`, kredit: p.kredit, harga: p.harga,
      nama: `${p.kredit} kredit`, utama: !!p.utama,
    })),
    {
      id: 'bulanan', kredit: HARGA.bulanan.kredit, harga: HARGA.bulanan.harga,
      nama: 'Langganan bulanan', bulanan: true,
    },
  ];
}

export function statusPembayaran() {
  const aktif = !!serverKey() && !!clientKey();
  return {
    aktif,
    mode: produksi() ? 'produksi' : 'sandbox',
    clientKey: clientKey(),
    snapJs: snapJs(),
    alasan: aktif ? '' : !serverKey() ? 'MIDTRANS_SERVER_KEY belum diatur' : 'MIDTRANS_CLIENT_KEY belum diatur',
  };
}

const fileLog = (root) => path.join(path.resolve(root), 'data', 'pembayaran-log.tsv');
const HEADER = 'waktu\torder_id\takun\tpaket\tkredit\tharga\tstatus\troot';

function bacaLog(root) {
  const f = fileLog(root);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(1)
    .map((baris) => {
      const c = baris.split('\t');
      return {
        waktu: c[0] || '', orderId: c[1] || '', akun: c[2] || '', paket: c[3] || '',
        kredit: Number(c[4]) || 0, harga: Number(c[5]) || 0, status: c[6] || '', root: c[7] || '',
      };
    });
}

function tulisLog(root, baris, gantiOrderId = '') {
  const f = fileLog(root);
  const ada = fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim();
  let isi = ada ? fs.readFileSync(f, 'utf8') : HEADER + '\n';
  if (gantiOrderId) {
    isi = isi.split(/\r?\n/).map((l) => {
      const c = l.split('\t');
      return c[1] === gantiOrderId ? baris.join('\t') : l;
    }).filter(Boolean).join('\n') + '\n';
  } else {
    isi += baris.join('\t') + '\n';
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, isi, 'utf8');
  fs.renameSync(tmp, f);
}

const waktu = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** Buat transaksi Snap. Mengembalikan token untuk dipakai snap.pay() di browser. */
export async function buatTransaksi({ base, akun, paketId }) {
  const st = statusPembayaran();
  if (!st.aktif) return { ok: false, error: st.alasan };
  const paket = daftarPaket().find((p) => p.id === paketId);
  if (!paket) return { ok: false, error: 'Paket tidak dikenal.' };
  const orderId = `CO-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const publik = String(process.env.APP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const body = {
    transaction_details: { order_id: orderId, gross_amount: paket.harga },
    item_details: [{
      id: paket.id,
      name: `Kredit lamaran — ${paket.nama}`,
      price: paket.harga,
      quantity: 1,
    }],
    customer_details: {
      first_name: String(akun?.nama || akun?.email || 'Pengguna').slice(0, 60),
      email: akun?.email || '',
    },
  };
  if (publik) body.notification_url = `${publik}/pembayaran/webhook`;
  try {
    const r = await fetch(apiSnap(), {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(serverKey() + ':').toString('base64'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const teks = await r.text();
    if (!r.ok) throw new Error(`Midtrans ${r.status}: ${teks.slice(0, 200)}`);
    const j = JSON.parse(teks || '{}');
    if (!j.token) throw new Error('Midtrans tidak mengembalikan Snap token.');
    tulisLog(base, [waktu(), orderId, akun?.id || '', paket.id, paket.kredit, paket.harga, 'pending', path.resolve(base, akun?.root || '.')]);
    return {
      ok: true, token: j.token, orderId,
      clientKey: clientKey(), snapJs: snapJs(),
      harga: paket.harga, kredit: paket.kredit, nama: paket.nama,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

const amanSama = (a, b) => {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/** Webhook Midtrans. Idempoten per order_id. */
export function terimaWebhook(base, rootLog, data) {
  const d = data || {};
  const orderId = String(d.order_id || '');
  const statusCode = String(d.status_code || '');
  const gross = String(d.gross_amount || '');
  const tanda = String(d.signature_key || '');
  const hash = crypto.createHash('sha512')
    .update(orderId + statusCode + gross + serverKey())
    .digest('hex');
  if (!serverKey() || !amanSama(hash, tanda)) {
    return { ok: false, error: 'Tanda tangan webhook tidak sah.' };
  }
  const status = String(d.transaction_status || '').toLowerCase();
  const lunas = status === 'settlement'
    || (status === 'capture' && String(d.fraud_status || '').toLowerCase() === 'accept');
  const riwayat = bacaLog(rootLog);
  const baris = riwayat.find((x) => x.orderId === orderId);
  if (!baris) return { ok: false, error: 'Order tidak dikenal.' };
  if (!lunas) {
    tulisLog(rootLog, [waktu(), orderId, baris.akun, baris.paket, baris.kredit, baris.harga, status, baris.root], orderId);
    return { ok: true, status, ditambahkan: 0, sisa: 0 };
  }
  if (baris.status === 'settlement' || baris.status === 'capture') {
    return { ok: true, status, sudahDiproses: true, ditambahkan: 0 };
  }
  const hasil = tambahKredit(base, baris.akun, baris.kredit, baris.paket, baris.root);
  if (!hasil.ok) return { ok: false, error: hasil.error };
  tulisLog(rootLog, [waktu(), orderId, baris.akun, baris.paket, baris.kredit, baris.harga, 'settlement', baris.root], orderId);
  return { ok: true, status, sudahDiproses: false, ditambahkan: baris.kredit, sisa: hasil.sisa };
}

export function riwayatPembayaran(base, akunId) {
  return bacaLog(base).filter((x) => x.akun === akunId).slice().reverse().slice(0, 20);
}
