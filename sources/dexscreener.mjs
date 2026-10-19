import { LIMITS } from '../config.mjs';
import { createCache } from '../lib/cache.mjs';
import { createLimiter, rateLimitError } from '../lib/limiter.mjs';
import { getJSON, errorReason } from '../lib/http.mjs';
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

export function createDexScreenerSource({ fetcher = fetch, clock = Date.now } = {}) {
  const limiter = createLimiter({ clock });
  const cache = createCache({ ttlMs: LIMITS.dexscreener.ttlMs, max: LIMITS.dexscreener.max, clock });
  const config = LIMITS.dexscreener;

  async function request(path) {
    const decision = limiter.tryTake('dexscreener', config.perMinute);
    if (!decision.ok) throw rateLimitError('DEX Screener', decision);
    try {
      return await getJSON(`${ORIGIN}${path}`, { fetcher });
    } catch (error) {
      limiter.refund('dexscreener');
      if (error.status === 429) limiter.cooldown('dexscreener', error.retryAfterMs ?? 30_000);
      throw error;
    }
  }

  /** Batch: satu request per 30 mint, digabung; satu pool terbaik per token. */
  async function batch(mints) {
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
          if (!Array.isArray(part)) throw new Error('skema bukan daftar pair');
          rows.push(...part);
        }
        return rows;
      });
      if (!Array.isArray(value)) throw new Error('skema bukan daftar pair');
      const pools = new Map();
      for (const raw of value) {
        const pair = normalizeBatchPair(raw, fetchedAt);
        if (!pair) continue;
        for (const mint of [pair.baseMint, pair.quoteMint]) {
          if (!unique.includes(mint)) continue;
          const current = pools.get(mint);
          // Satu pool terbaik per mint: likuiditas tertinggi, lalu volume 24 jam.
          if (!current || (pair.liquidityUsd ?? -1) > (current.liquidityUsd ?? -1)
            || ((pair.liquidityUsd ?? -1) === (current.liquidityUsd ?? -1) && (pair.volume.h24 ?? -1) > (current.volume.h24 ?? -1))) {
            pools.set(mint, pair);
          }
        }
      }
      return { status: 'available', source: 'DEX Screener', fetchedAt, cached, pools, requested: unique.length, batches: chunks.length, reason: null };
    } catch (error) {
      return { status: 'unknown', source: 'DEX Screener', fetchedAt, pools: new Map(), requested: unique.length, batches: chunks.length, reason: errorReason(error, 'DEX Screener batch: ') };
    }
  }

  return { name: 'DEX Screener', docs: DEX_DOCS, batch };
}
