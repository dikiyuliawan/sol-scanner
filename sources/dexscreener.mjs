import { LIMITS } from '../config.mjs';
import { createCache } from '../lib/cache.mjs';
import { createLimiter, rateLimitError } from '../lib/limiter.mjs';
import { getJSON, errorReason, createBreaker, HttpError } from '../lib/http.mjs';
import { finiteOrNull } from '../lib/provenance.mjs';

export const DEX_DOCS = 'https://docs.dexscreener.com/api/reference';
const ORIGIN = 'https://api.dexscreener.com';

function txns(value) {
  if (!value || typeof value !== 'object') return null;
  return { buys: finiteOrNull(value.buys), sells: finiteOrNull(value.sells) };
}

export function normalizeBatchPair(pair, fetchedAt) {
  if (!pair || typeof pair !== 'object' || pair.chainId !== 'solana') return null;
  const address = typeof pair.pairAddress === 'string' ? pair.pairAddress : null;
  if (!address) return null;
  const created = finiteOrNull(pair.pairCreatedAt);
  return {
    poolAddress: address,
    dex: typeof pair.dexId === 'string' ? pair.dexId : 'unknown',
    baseMint: typeof pair.baseToken?.address === 'string' ? pair.baseToken.address : null,
    quoteMint: typeof pair.quoteToken?.address === 'string' ? pair.quoteToken.address : null,
    baseSymbol: typeof pair.baseToken?.symbol === 'string' ? pair.baseToken.symbol : null,
    quoteSymbol: typeof pair.quoteToken?.symbol === 'string' ? pair.quoteToken.symbol : null,
    priceUsd: finiteOrNull(pair.priceUsd),
    liquidityUsd: finiteOrNull(pair.liquidity?.usd),
    marketCap: finiteOrNull(pair.marketCap),
    fdv: finiteOrNull(pair.fdv),
    createdAt: created !== null && created > 0 ? created : null,
    change: {
      m5: finiteOrNull(pair.priceChange?.m5),
      h1: finiteOrNull(pair.priceChange?.h1),
      h6: finiteOrNull(pair.priceChange?.h6),
      h24: finiteOrNull(pair.priceChange?.h24)
    },
    volume: {
      m5: finiteOrNull(pair.volume?.m5),
      h1: finiteOrNull(pair.volume?.h1),
      h6: finiteOrNull(pair.volume?.h6),
      h24: finiteOrNull(pair.volume?.h24)
    },
    txns: {
      m5: txns(pair.txns?.m5),
      h1: txns(pair.txns?.h1),
      h6: txns(pair.txns?.h6),
      h24: txns(pair.txns?.h24)
    },
    source: 'DEX Screener',
    fetchedAt
  };
}

/**
 * DEX Screener selalu melaporkan harga, valuasi, dan perubahan harga untuk
 * token BASE sebuah pool. Kalau mint yang dicari justru menjadi token QUOTE,
 * angka itu milik token lain dan tidak boleh dipakai sebagai harga token
 * yang dicari: nilainya jadi unknown, bukan dihapus.
 */
export function resolveForMint(pair, mint) {
  const targetIsBase = pair.baseMint === mint;
  return {
    ...pair,
    targetIsBase,
    priceUsd: targetIsBase ? pair.priceUsd : null,
    marketCap: targetIsBase ? pair.marketCap : null,
    fdv: targetIsBase ? pair.fdv : null,
    change: targetIsBase ? pair.change : { m5: null, h1: null, h6: null, h24: null }
  };
}

/**
 * Pool utama untuk satu mint: pool dengan mint sebagai base token (harga
 * dan valuasi milik mint itu sendiri) dipilih lebih dulu, lalu likuiditas
 * tertinggi, lalu volume 24 jam tertinggi. Pool dengan mint sebagai quote
 * hanya dipakai bila tidak ada pool base sama sekali.
 */
export function betterPool(a, b) {
  const rank = pool => (pool.targetIsBase ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) > rank(b);
  if ((a.liquidityUsd ?? -1) !== (b.liquidityUsd ?? -1)) return (a.liquidityUsd ?? -1) > (b.liquidityUsd ?? -1);
  return (a.volume?.h24 ?? -1) > (b.volume?.h24 ?? -1);
}

export function pickMainPool(pairs, mint) {
  const base = pairs.filter(pair => pair.targetIsBase);
  const quote = pairs.filter(pair => !pair.targetIsBase);
  const sortBest = list => list.slice().sort(betterPool);
  return sortBest(base)[0] ?? sortBest(quote)[0] ?? null;
}

export function createDexScreenerSource({ fetcher = fetch, clock = Date.now } = {}) {
  const limiter = createLimiter({ clock });
  const cache = createCache({ ttlMs: LIMITS.dexscreener.ttlMs, max: LIMITS.dexscreener.max, clock });
  const breaker = createBreaker({ clock });
  const config = LIMITS.dexscreener;

  async function request(path) {
    const blocked = breaker.check();
    if (blocked.blocked) {
      throw new HttpError(`DEX Screener sedang tidak dapat dihubungi (gagal berulang); jeda ${Math.ceil(blocked.retryAfterMs / 1000)} detik sebelum mencoba lagi.`, { url: path });
    }
    const decision = limiter.tryTake('dexscreener', config.perMinute);
    if (!decision.ok) throw rateLimitError('DEX Screener', decision);
    try {
      const data = await getJSON(`${ORIGIN}${path}`, { fetcher });
      breaker.recordSuccess();
      return data;
    } catch (error) {
      limiter.refund('dexscreener');
      if (error.transient) breaker.recordFailure();
      if (error.status === 429) limiter.cooldown('dexscreener', error.retryAfterMs ?? 30_000);
      throw error;
    }
  }

  /** Batch: satu request per 30 mint, digabung; satu pool utama per token. */
  async function batch(mints, { refresh = false } = {}) {
    const unique = [...new Set(mints.filter(mint => typeof mint === 'string' && mint))];
    if (!unique.length) return { status: 'empty', source: 'DEX Screener', fetchedAt: new Date(clock()).toISOString(), pools: new Map(), requested: 0, batches: 0, reason: 'Tidak ada mint untuk diperiksa.' };
    const size = config.batchSize;
    const chunks = [];
    for (let index = 0; index < unique.length; index += size) chunks.push(unique.slice(index, index + size));
    const fetchedAt = new Date(clock()).toISOString();
    const key = `batch:${unique.slice().sort().join(',')}`;
    try {
      const { value, cached } = await cache.resolve(key, async () => {
        const rows = [];
        for (const chunk of chunks) {
          const part = await request(`/tokens/v1/solana/${chunk.join(',')}`);
          if (!Array.isArray(part)) throw new Error('Skema respons bukan daftar pool');
          rows.push(...part);
        }
        return rows;
      }, { bypass: refresh });
      if (!Array.isArray(value)) throw new Error('Skema respons bukan daftar pool');
      const byMint = new Map();
      for (const raw of value) {
        const pair = normalizeBatchPair(raw, fetchedAt);
        if (!pair) continue;
        for (const mint of [pair.baseMint, pair.quoteMint]) {
          if (!unique.includes(mint)) continue;
          const resolved = resolveForMint(pair, mint);
          const current = byMint.get(mint);
          if (!current) { byMint.set(mint, resolved); continue; }
          if (betterPool(resolved, current)) byMint.set(mint, resolved);
        }
      }
      return { status: 'available', source: 'DEX Screener', fetchedAt, cached, pools: byMint, requested: unique.length, batches: chunks.length, reason: null };
    } catch (error) {
      return { status: 'unknown', source: 'DEX Screener', fetchedAt, pools: new Map(), requested: unique.length, batches: chunks.length, reason: errorReason(error, 'DEX Screener batch: ') };
    }
  }

  /**
   * Semua pool untuk satu mint. Endpoint ini hanya menerima satu alamat,
   * jadi biayanya satu request per token; dipakai untuk jalur Inspect dan
   * untuk memeriksa ulang pool utama shortlist Discover.
   */
  async function tokenPairs(mint, { refresh = false } = {}) {
    const fetchedAt = new Date(clock()).toISOString();
    if (typeof mint !== 'string' || !mint) {
      return { status: 'unknown', source: 'DEX Screener', fetchedAt, rows: [], reason: 'Alamat mint tidak valid; pool tidak diminta.' };
    }
    const key = `pairs:${mint}`;
    try {
      const { value, cached } = await cache.resolve(key, () => request(`/token-pairs/v1/solana/${mint}`), { bypass: refresh });
      if (!Array.isArray(value)) throw new Error('Skema respons bukan daftar pool');
      return { status: 'available', source: 'DEX Screener', fetchedAt, cached, rows: value, reason: null };
    } catch (error) {
      return { status: 'unknown', source: 'DEX Screener', fetchedAt, rows: [], reason: errorReason(error, 'DEX Screener pools: ') };
    }
  }

  /** Pool utama yang benar-benar dilaporkan provider untuk satu mint. */
  async function mainPool(mint, { refresh = false } = {}) {
    const result = await tokenPairs(mint, { refresh });
    if (result.status !== 'available') {
      return { status: result.status, source: result.source, fetchedAt: result.fetchedAt, pool: null, reason: result.reason };
    }
    const pairs = result.rows
      .map(raw => normalizeBatchPair(raw, result.fetchedAt))
      .filter(Boolean)
      .map(pair => resolveForMint(pair, mint));
    const pool = pickMainPool(pairs, mint);
    return {
      status: pool ? 'available' : 'empty',
      source: result.source,
      fetchedAt: result.fetchedAt,
      pool,
      pairs: pairs.length,
      reason: pool ? null : 'DEX Screener tidak mengembalikan pool Solana untuk mint ini.'
    };
  }

  return { name: 'DEX Screener', docs: DEX_DOCS, batch, tokenPairs, mainPool };
}
