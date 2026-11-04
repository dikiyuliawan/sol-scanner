/**
 * Basic auth di depan semua rute (UI + API). Scanner ini personal: satu
 * kredensial disimpan di env Vercel APP_PASSWORD; browser menampilkan satu
 * prompt login. Tanpa APP_PASSWORD, akses ditutup total (fail closed).
 *
 * Catatan: nilai APP_PASSWORD dikirim sebagai Basic auth yang hanya aman
 * lewat HTTPS — Vercel selalu menyajikan HTTPS. Jangan pakai password yang
 * Anda pakai di layanan lain.
 */
const REALM = 'solana-paper-scanner';

export const config = {
  matcher: ['/:path*']
};

export default function middleware(request) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return new Response('APP_PASSWORD belum diset di environment Vercel; akses ditolak.', { status: 503 });
  }
  const header = request.headers.get('authorization');
  if (header && header.startsWith('Basic ')) {
    const decoded = atob(header.slice(6));
    const wanted = `scanner:${password}`;
    const a = new TextEncoder().encode(decoded);
    const b = new TextEncoder().encode(wanted);
    if (a.length === b.length) {
      let diff = 0;
      for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
      if (diff === 0) return; // kredensial benar — lanjut ke aplikasi
    }
  }
  return new Response('Login diperlukan.', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`, 'Cache-Control': 'no-store' }
  });
}
