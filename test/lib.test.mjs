import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, rateLimitError } from '../lib/limiter.mjs';
import { createCache } from '../lib/cache.mjs';
import { parseRetryAfter, getJSON, HttpError } from '../lib/http.mjs';
import { fact, factValue, evidenceRow } from '../lib/provenance.mjs';

test('limiter menolak setelah batas dan menghitung retryAfter dari window', () => {
  let now = 1_000_000;
  const limiter = createLimiter({ clock: () => now });
  for (let index = 0; index < 3; index += 1) assert.equal(limiter.tryTake('x', 3).ok, true);
  const denied = limiter.tryTake('x', 3);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'rate');
  assert.equal(denied.retryAfterMs, 60_000);
  now += 60_000;
  assert.equal(limiter.tryTake('x', 3).ok, true);
});

test('limiter mengembalikan slot yang gagal dan mendukung cooldown', () => {
  let now = 0;
  const limiter = createLimiter({ clock: () => now });
  limiter.tryTake('x', 1);
  assert.equal(limiter.tryTake('x', 1).ok, false);
  limiter.refund('x');
  assert.equal(limiter.tryTake('x', 1).ok, true);
  limiter.cooldown('x', 5_000);
  const denied = limiter.tryTake('x', 1);
  assert.equal(denied.reason, 'cooldown');
  assert.equal(denied.retryAfterMs, 5_000);
  now += 61_000;
  assert.equal(limiter.tryTake('x', 1).ok, true);
});

test('limiter memisahkan budget per key', () => {
  const limiter = createLimiter({ clock: () => 0 });
  assert.equal(limiter.tryTake('a', 1).ok, true);
  assert.equal(limiter.tryTake('a', 1).ok, false);
  assert.equal(limiter.tryTake('b', 1).ok, true);
});

test('rateLimitError membawa retryAfterSeconds', () => {
  const error = rateLimitError('Gecko', { reason: 'rate', retryAfterMs: 12_300 });
  assert.equal(error.name, 'RateLimitError');
  assert.equal(error.retryAfterSeconds, 13);
});

test('cache LRU menghormati TTL dan mengevaluasi ulang setelah kedaluwarsa', () => {
  let now = 0;
  const cache = createCache({ ttlMs: 100, max: 2, clock: () => now });
  cache.set('a', 1);
  now = 50;
  cache.set('b', 2);
  assert.equal(cache.get('a').value, 1);
  now = 120;
  assert.equal(cache.get('a'), null, 'TTL a habis');
  assert.equal(cache.get('b').value, 2, 'b masih valid karena di-set pada 50');
  cache.set('c', 3);
  cache.set('d', 4);
  assert.equal(cache.size(), 2);
});

test('cache single-flight hanya memanggil producer sekali untuk key sama', async () => {
  let calls = 0;
  const cache = createCache({ ttlMs: 1000 });
  const producer = async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 10)); return 'value'; };
  const [first, second] = await Promise.all([cache.resolve('k', producer), cache.resolve('k', producer)]);
  assert.equal(calls, 1);
  assert.equal(first.value, 'value');
  assert.equal(second.value, 'value');
});

test('parseRetryAfter memahami detik dan tanggal HTTP', () => {
  const now = Date.UTC(2024, 0, 1, 0, 0, 0);
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter('0', now), 0);
  assert.equal(parseRetryAfter(new Date(now + 45_000).toUTCString(), now), 45_000);
  assert.equal(parseRetryAfter('bukan angka', now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
});

test('getJSON merapikan timeout, status, dan JSON rusak menjadi HttpError', async () => {
  const cases = [
    [async () => { throw new DOMException('timeout', 'TimeoutError'); }, /batas waktu/],
    [async () => new Response('', { status: 429 }), /HTTP 429/],
    [async () => new Response('{'), /JSON tidak valid/]
  ];
  for (const [fetcher, pattern] of cases) {
    await assert.rejects(() => getJSON('https://example.test', { fetcher }), error => error instanceof HttpError && pattern.test(error.message));
  }
});

test('getJSON membaca header Retry-After pada 429', async () => {
  const fetcher = async () => new Response('', { status: 429, headers: { 'retry-after': '42' } });
  await assert.rejects(() => getJSON('https://example.test', { fetcher }), error => error.retryAfterMs === 42_000);
});

test('getJSON membatasi byte UTF-8 dan menolak body besar saat masih membaca stream', async () => {
  const unicode = async () => new Response('"€€"');
  await assert.rejects(() => getJSON('https://example.test', { fetcher: unicode, maxBytes: 6 }), error => error instanceof HttpError && /terlalu besar/.test(error.message));
  let cancelled = false;
  const oversized = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(100))); },
    cancel() { cancelled = true; }
  }));
  await assert.rejects(() => getJSON('https://example.test', { fetcher: oversized, maxBytes: 16 }), error => error instanceof HttpError && /terlalu besar/.test(error.message));
  assert.equal(cancelled, true, 'body stream must be cancelled as soon as byte limit is exceeded');
});

test('provenance membedakan nilai nol dari unknown', () => {
  assert.equal(factValue(fact(0, 'src')), 0);
  assert.equal(fact(0, 'src').status, 'available');
  assert.equal(fact(null, 'src').status, 'unknown');
  assert.equal(fact(Number.NaN, 'src').status, 'unknown');
  const row = evidenceRow('Likuiditas', fact(null, 'DEX Screener'));
  assert.equal(row.status, 'unknown');
  assert.equal(row.source, 'DEX Screener');
});
