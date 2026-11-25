// email-kirim.mjs — pengirim kode verifikasi lewat provider HTTP.
//
// Tanpa dependency baru: memakai fetch global Node 22.
// Konfigurasi lewat environment (disarankan di .env root career-ops):
//
//   EMAIL_PROVIDER=resend          # atau: brevo, mailjet
//   EMAIL_API_KEY=...
//   EMAIL_SECRET_KEY=...           # khusus Mailjet
//   EMAIL_DARI=SiapLamar <no-reply@domain-anda.com>
//   EMAIL_NAMA=SiapLamar           # untuk Brevo
//   APP_PUBLIC_URL=http://127.0.0.1:3000   # dipakai tautan atur ulang sandi
//
// Mailjet dipilih bila tidak ada nomor HP: daftar + verifikasi email cukup
// memakai link di inbox, lalu verifikasi satu alamat pengirim lewat link juga.
// Bila belum dikonfigurasi, ringkasan.mjs tetap menampilkan kode di halaman
// (mode uji). Jangan pakai mode uji untuk pengguna sungguhan.

const provider = () => String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
const apiKey = () => String(process.env.EMAIL_API_KEY || '').trim();
const secretKey = () => String(process.env.EMAIL_SECRET_KEY || '').trim();
const dari = () => String(process.env.EMAIL_DARI || '').trim();
const nama = () => String(process.env.EMAIL_NAMA || 'SiapLamar').trim();

export function statusEmail() {
  const p = provider();
  const didukung = p === 'resend' || p === 'brevo' || p === 'mailjet';
  const aktif = !!apiKey() && !!dari() && didukung && (p !== 'mailjet' || !!secretKey());
  return {
    aktif,
    provider: p || 'tidak-diatur',
    dari: dari() || 'tidak-diatur',
    alasan: aktif ? '' : !p ? 'EMAIL_PROVIDER belum diatur'
      : !apiKey() ? 'EMAIL_API_KEY belum diatur'
      : p === 'mailjet' && !secretKey() ? 'EMAIL_SECRET_KEY belum diatur'
      : !dari() ? 'EMAIL_DARI belum diatur'
      : `Provider ${p} belum didukung`,
  };
}

function pecahDari() {
  const d = dari();
  if (!d.includes('<')) return { email: d, nama: nama() };
  const email = (d.match(/<([^>]+)>/) || [])[1] || d;
  return { email, nama: d.split('<')[0].trim() || nama() };
}

function isiEmail(kode) {
  const subjek = 'Kode verifikasi SiapLamar';
  const teks = `Kode verifikasi SiapLamar Anda: ${kode}\n\nKode berlaku 10 menit. Setelah verifikasi, 3 kredit trial langsung tersedia.\nBila Anda tidak mendaftar, abaikan email ini.`;
  const html = `<div style="font-family:Segoe UI,system-ui,sans-serif;max-width:520px;margin:auto;color:#0f172a">
<h2 style="font-size:1.15rem">Verifikasi email SiapLamar</h2>
<p style="color:#475569;font-size:.9rem">Masukkan kode ini di halaman verifikasi:</p>
<div style="font-size:1.7rem;letter-spacing:.35em;font-weight:700;background:#eff6ff;border:1px dashed #93c5fd;border-radius:10px;padding:16px;text-align:center;color:#1e3a8a">${kode}</div>
<p style="color:#475569;font-size:.85rem">Kode berlaku 10 menit. Setelah verifikasi, 3 kredit trial langsung tersedia.<br>Bila Anda tidak mendaftar, abaikan email ini.</p>
</div>`;
  return { subjek, teks, html };
}

async function kirimResend(ke, { subjek, teks, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: dari(), to: [ke], subject: subjek, text: teks, html }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`);
  return { id: JSON.parse(body || '{}').id || '' };
}

async function kirimBrevo(ke, { subjek, teks, html }) {
  const { email: dariEmail, nama: dariNama } = pecahDari();
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: dariNama || 'SiapLamar', email: dariEmail },
      to: [{ email: ke }],
      subject: subjek,
      textContent: teks,
      htmlContent: html,
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${body.slice(0, 200)}`);
  return { id: JSON.parse(body || '{}').messageId || '' };
}

async function kirimMailjet(ke, { subjek, teks, html }) {
  const { email, nama: namaPengirim } = pecahDari();
  const auth = Buffer.from(`${apiKey()}:${secretKey()}`).toString('base64');
  const r = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Messages: [{
        From: { Email: email, Name: namaPengirim || 'SiapLamar' },
        To: [{ Email: ke }],
        Subject: subjek,
        TextPart: teks,
        HTMLPart: html,
      }],
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Mailjet ${r.status}: ${body.slice(0, 200)}`);
  const pesan = JSON.parse(body || '{}').Messages?.[0];
  if (pesan && pesan.Status !== 'success') {
    const rincian = (pesan.Errors || [])
      .map((e) => e.ErrorMessage || e.ErrorCode).filter(Boolean).join(', ');
    throw new Error(`Mailjet menolak: ${rincian || 'status ' + pesan.Status}`);
  }
  return { id: pesan?.MessageID ? String(pesan.MessageID) : '' };
}

async function kirimPesan(ke, isi) {
  const p = provider();
  return p === 'resend'
    ? await kirimResend(ke, isi)
    : p === 'mailjet'
      ? await kirimMailjet(ke, isi)
      : await kirimBrevo(ke, isi);
}

/** Kirim kode. Mode uji dikembalikan bila provider belum aktif. */
export async function kirimKodeVerifikasi(email, kode) {
  const st = statusEmail();
  if (!st.aktif) return { ok: false, modeUji: true, alasan: st.alasan };
  try {
    const hasil = await kirimPesan(email, isiEmail(String(kode)));
    return { ok: true, modeUji: false, id: hasil.id };
  } catch (e) {
    return { ok: false, modeUji: false, error: e.message };
  }
}

export function tautanReset(token) {
  const dasar = String(process.env.APP_PUBLIC_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  return `${dasar}/reset-sandi?token=${encodeURIComponent(String(token))}`;
}

function isiReset(tautan) {
  const subjek = 'Atur ulang kata sandi SiapLamar';
  const teks = `Permintaan atur ulang kata sandi SiapLamar diterima.\n\nBuka tautan ini dalam 30 menit: ${tautan}\n\nBila Anda tidak meminta ini, abaikan email ini. Kata sandi Anda belum berubah.`;
  const html = `<div style="font-family:Segoe UI,system-ui,sans-serif;max-width:520px;margin:auto;color:#0f172a">
 <h2 style="font-size:1.15rem">Atur ulang kata sandi SiapLamar</h2>
 <p style="color:#475569;font-size:.9rem">Klik tombol ini untuk membuat kata sandi baru. Tautan berlaku 30 menit dan hanya bisa dipakai sekali.</p>
 <p style="margin:18px 0"><a href="${escAtribut(tautan)}" style="background:#2563eb;color:#fff;padding:11px 18px;border-radius:9px;text-decoration:none;font-weight:600;display:inline-block">Buat kata sandi baru</a></p>
 <p style="color:#475569;font-size:.82rem">Bila tombol tidak berfungsi, salin tautan ini ke bilah alamat:<br>${escAtribut(tautan)}</p>
 <p style="color:#475569;font-size:.82rem">Bila Anda tidak meminta ini, abaikan email ini. Kata sandi Anda belum berubah.</p>
 </div>`;
  return { subjek, teks, html };
}

const escAtribut = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Kirim tautan reset. Mode uji mengembalikan tautan untuk ditampilkan di halaman. */
export async function kirimTautanReset(email, token) {
  const st = statusEmail();
  const tautan = tautanReset(token);
  if (!st.aktif) return { ok: false, modeUji: true, alasan: st.alasan, tautan };
  try {
    const hasil = await kirimPesan(email, isiReset(tautan));
    return { ok: true, modeUji: false, id: hasil.id, tautan };
  } catch (e) {
    return { ok: false, modeUji: false, error: e.message, tautan };
  }
}
