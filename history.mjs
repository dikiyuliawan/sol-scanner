import { analyzeCandles } from './signals.mjs';

export const HISTORY_DOCS = 'https://api.geckoterminal.com/docs/index.html';
const ORIGIN = 'https://api.geckoterminal.com/api/v2';
const address = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export function unknownHistory(reason, extra = {}) {
  return { status: 'unknown', source: 'GeckoTerminal', docs: HISTORY_DOCS, timeframe: '15m', currency: 'USD', fetchedAt: null, endpoint: null, candles: [], metrics: {}, signals: [{ level: 'unknown', title: 'Konteks historis unknown', reason }], watch: { state: 'unknown', title: 'Belum cukup data untuk watch', reason, invalidation: 'Tidak ada kondisi watch aktif.' }, reason, ...extra };
}
export function normalizeHistory(data, mint, primary, now = Date.now()) {
  // token=mint makes the requested price orientation explicit, independently of provider base/quote ordering.
  const meta = data?.meta;
  if (!meta || ![meta.base?.address, meta.quote?.address].includes(mint)) throw new Error('Identitas mint pada metadata candle tidak cocok atau hilang');
  if (primary.baseMint && primary.quoteMint) {
    const actual = [meta.base?.address, meta.quote?.address].sort();
    const expected = [primary.baseMint, primary.quoteMint].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Pasangan token candle berbeda dari pool snapshot');
  }
  const rows = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw new Error('Skema ohlcv_list tidak valid');
  return analyzeCandles(rows, { now });
}
export function createHistoryProvider({ fetcher = fetch, clock = Date.now } = {}) {
  const cache = new Map(), inFlight = new Map();
  let starts = [], cooldownUntil = 0;
  return async function history(mint, primary) {
    if (!primary || !address(primary.address) || !address(mint)) return unknownHistory('Pool utama dengan alamat valid belum tersedia. Tidak berpindah ke pool lain secara diam-diam.');
    const key = `${mint}:${primary.address}`;
    // include_empty_intervals=true: GeckoTerminal mengisi interval tanpa
    // transaksi dengan candle volume nol. Tanpa ini, celah membuat analisis
    // 15 menit selalu unknown pada pool bervolume rendah.
    const endpoint = `${ORIGIN}/networks/solana/pools/${primary.address}/ohlcv/minute?aggregate=15&limit=100&currency=usd&token=${mint}&include_empty_intervals=true`;
    const base = { source: 'GeckoTerminal', docs: HISTORY_DOCS, endpoint, poolAddress: primary.address, tokenAddress: mint, timeframe: '15m', currency: 'USD', providerCacheSeconds: 60 };
    const now = clock(), hit = cache.get(key);
    const decorate = (raw, fetchedAt, historyCached) => ({ ...normalizeHistory(raw, mint, primary, clock()), ...base, fetchedAt, historyCached });
    if (hit && now - hit.at < 60000) {
      try { return decorate(hit.raw, hit.fetchedAt, true); }
      catch (e) { return unknownHistory(e.message, { ...base, fetchedAt: hit.fetchedAt, historyCached: true }); }
    }
    if (inFlight.has(key)) return inFlight.get(key);
    starts = starts.filter(t => now - t < 60000);
    if (now < cooldownUntil || starts.length >= 8) return unknownHistory('Batas lokal candle 8 permintaan/menit atau cooldown HTTP 429. Tunggu 60 detik lalu scan manual; snapshot pasar tetap terpisah.', { ...base, retryAfterSeconds: Math.max(1, Math.ceil(((now < cooldownUntil ? cooldownUntil : starts[0] + 60000) - now) / 1000)) });
    starts.push(now);
    const promise = (async () => {
      try {
        const response = await fetcher(endpoint, { headers: { Accept: 'application/json;version=20230203' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) { if (response.status === 429) cooldownUntil = clock() + 60000; throw new Error(`HTTP ${response.status}`); }
        const text = await response.text();
        if (text.length > 4_000_000) throw new Error('Respons candle terlalu besar');
        const raw = JSON.parse(text), fetchedAt = new Date(clock()).toISOString();
        const result = decorate(raw, fetchedAt, false);
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { raw, fetchedAt, at: clock() });
        return result;
      } catch (e) {
        return unknownHistory(`Candle unknown: ${e.name === 'TimeoutError' ? 'batas waktu 10 detik' : e.message}. Tidak ada sinyal breakout yang disimpulkan.`, { ...base, attemptedAt: new Date(clock()).toISOString() });
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}

export function entryContext(market, risk, history) {
  const cautions = [];
  if (risk?.status === 'unknown') cautions.push('Keamanan kontrak belum terverifikasi (GoPlus/Jupiter tidak tersedia): status unknown, bukan risiko rendah.');
  else if (risk?.status === 'partial') cautions.push('Sebagian data keamanan belum terverifikasi; nilai yang kosong bukan berarti aman.');
  else cautions.push('Temuan keamanan tetap perlu ditinjau; tersedianya data tidak menjamin aman.');
  for (const finding of risk?.findings ?? []) {
    if (finding.level === 'warning') cautions.push(`Temuan: ${finding.title} — ${finding.reason}`);
  }
  if (market?.primary?.liquidityUsd == null) cautions.push('Likuiditas unknown; kualitas eksekusi tidak dinilai.');
  else if (market.primary.liquidityUsd < 50000) cautions.push('Likuiditas pool di bawah USD 50.000; kondisi watch bukan izin masuk.');
  if (market?.primary?.ageHours != null && market.primary.ageHours < 24) cautions.push('Pool di bawah 24 jam; riwayat pendek dan risiko tambahan.');
  return { title: 'Konteks entry: watch, bukan keputusan buy', technical: history?.watch?.title ?? 'Konteks historis unknown', reason: 'Belum bisa disebut entry buy yang bagus hanya dari pola harga. Kondisi di bawah membantu memilih apa yang dipantau, bukan memprediksi profit.', cautions };
}
