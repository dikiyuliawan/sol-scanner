#!/usr/bin/env node
/**
 * Diagnosa konektivitas ke penyedia data.
 *
 * Memisahkan tiga kondisi yang sering tertukar:
 * 1. penyedia memblokir alamat IP ini (reset koneksi / 429),
 * 2. proxy atau VPN yang menahan domain tersebut (reset koneksi),
 * 3. semua sehat.
 *
 * Tidak mengubah file apa pun dan tidak menyentuh database.
 */
import dns from 'node:dns/promises';
import { LIMITS } from '../config.mjs';

const TARGETS = [
  { name: 'Jupiter (token terbaru)', url: 'https://lite-api.jup.ag/tokens/v2/recent?limit=1', host: 'lite-api.jup.ag' },
  { name: 'Jupiter (top organic)', url: 'https://lite-api.jup.ag/tokens/v2/toporganicscore/1h?limit=1', host: 'lite-api.jup.ag' },
  { name: 'DEX Screener (batch pools)', url: 'https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112', host: 'api.dexscreener.com' },
  { name: 'GeckoTerminal (trending pools)', url: 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1', host: 'api.geckoterminal.com' },
  { name: 'GeckoTerminal (candle OHLCV)', url: 'https://api.geckoterminal.com/api/v2/networks/solana/pools/Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE/ohlcv/hour?aggregate=1&limit=1&currency=usd', host: 'api.geckoterminal.com' },
  { name: 'GoPlus (security token)', url: 'https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=So11111111111111111111111111111111111111112', host: 'api.gopluslabs.io' }
];

const probe = async target => {
  const row = { name: target.name, host: target.host, address: '-', real: '-', status: '-', detail: '' };
  try {
    const records = await dns.lookup(target.host, { all: true });
    row.address = records.map(record => record.address).join(', ');
  } catch (error) {
    row.detail = `DNS gagal: ${error.code ?? error.message}`;
    return row;
  }
  // Bandingkan jawaban DNS sistem dengan jawaban DoH (DNS publik). Kalau
  // berbeda, DNS sistem diteruskan ke proxy/inspection yang mengembalikan
  // alamat sendiri, bukan IP asli penyedia.
  try {
    const doh = await fetch(`https://cloudflare-dns.com/dns-query?name=${target.host}&type=A`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
    const answer = await doh.json();
    row.real = (answer.Answer ?? []).filter(item => item.type === 1).map(item => item.data).join(', ') || '-';
  } catch {
    row.real = '-';
  }
  const started = Date.now();
  try {
    const response = await fetch(target.url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    row.status = `HTTP ${response.status}`;
    row.detail = `${Date.now() - started} ms`;
  } catch (error) {
    const code = error?.cause?.code ?? error.name ?? 'error';
    row.status = 'GAGAL';
    row.detail = `${code}: ${error.message}`;
  }
  return row;
};

const sameAddresses = (a, b) => {
  if (a === '-' || b === '-') return false;
  const left = a.split(',').map(item => item.trim()).sort();
  const right = b.split(',').map(item => item.trim()).sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
};

const pad = (value, width) => String(value).padEnd(width);

console.log('Diagnosa konektivitas penyedia data\n');
const results = [];
for (const target of TARGETS) results.push(await probe(target));

for (const row of results) {
  const hijacked = !sameAddresses(row.address, row.real);
  console.log(`${pad(row.name, 30)} ${pad(row.address, 15)} ${pad(row.status, 9)} ${row.detail}`);
  if (hijacked) console.log(`${' '.repeat(30)} DNS sistem → ${row.address} · IP asli (DoH) → ${row.real}`);
}

const failed = results.filter(row => row.status === 'GAGAL');
const throttled = results.filter(row => row.status === 'HTTP 429');
const hijacked = results.filter(row => !sameAddresses(row.address, row.real));
console.log('');
if (!failed.length && !throttled.length) {
  console.log('Semua penyedia dapat dihubungi. Kalau Discover kosong, masalahnya bukan koneksi.');
} else {
  if (hijacked.length) {
    console.log('DNS sistem tidak mengembalikan IP asli untuk domain di atas: jawabannya berasal dari');
    console.log('proxy atau lapisan SSL-inspection/VPN, bukan dari DNS publik.');
  }
  if (failed.length) {
    console.log(`${failed.length} host gagal pada level koneksi (reset/DNS).`);
    console.log('Kemungkinan penyebab: proxy atau VPN memblokir domain tersebut berdasarkan nama');
    console.log('(SNI), atau penyedia memblokir alamat IP ini. Cara tercepat: coba dari jaringan lain');
    console.log('(hotspot, jaringan rumah, VPS) atau VPN mode TUN. Proxy HTTP biasa tidak membantu:');
    console.log('fetch di Node mengabaikan HTTPS_PROXY.');
  }
  if (throttled.length) {
    console.log(`${throttled.length} host membalas 429: kuota laju habis. Tunggu sebentar; batas app`);
    console.log(`sudah: Jupiter ${LIMITS.jupiter.perMinute}/mnt, DEX ${LIMITS.dexscreener.perMinute}/mnt, Gecko ${LIMITS.gecko.perMinute}/mnt + jarak ${LIMITS.gecko.minGapMs / 1000} detik.`);
  }
}
