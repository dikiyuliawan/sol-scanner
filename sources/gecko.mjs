import { LIMITS } from '../config.mjs';
import { createCache } from '../lib/cache.mjs';
import { createLimiter, rateLimitError } from '../lib/limiter.mjs';
import { getJSON, errorReason } from '../lib/http.mjs';
import { finiteOrNull } from '../lib/provenance.mjs';

export const GECKO_DOCS = 'https://api.geckoterminal.com/docs/index.html';
const ORIGIN = 'https://api.geckoterminal.com/api/v2';
const ACCEPT = 'application/json;version=20230203';

export function normalizeTrendingPool(raw, fetchedAt) {
  const attributes = raw?.attributes;
  if (!attributes || typeof attributes.address !== 'string') return null;
  const base = raw.relationships?.base_token?.data?.id;
  const quote = raw.relationships?.quote_token?.data?.id;
  const mint = typeof base === 'string' ? base.replace(/^solana_/, '') : null;
  const createdAt = typeof attributes.pool_created_at === 'string' ? Date.parse(attributes.pool_created_at) : null;
  return {
    poolAddress: attributes.address,
    mint,
    quoteMint: typeof quote === 'string' ? quote.replace(/^solana_/, '') : null,
    name: typeof attributes.name === 'string' ? attributes.name : null,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
    liquidityUsd: finiteOrNull(attributes.reserve_in_usd),
    fdv: finiteOrNull(attributes.fdv_usd),
    marketCap: finiteOrNull(attributes.market_cap_usd),
    volume: {
      m5: finiteOrNull(attributes.volume_usd?.m5),
      h1: finiteOrNull(attributes.volume_usd?.h1),
      h6: finiteOrNull(attributes.volume_usd?.h6),
      h24: finiteOrNull(attributes.volume_usd?.h24)
    },
    change: {
      m5: finiteOrNull(attributes.price_change_percentage?.m5),
      h1: finiteOrNull(attributes.price_change_percentage?.h1),
      h6: finiteOrNull(attributes.price_change_percentage?.h6),
      h24: finiteOrNull(attributes.price_change_percentage?.h24)
    },
    txns: {
      h1: attributes.transactions?.h1 ? { buys: finiteOrNull(attributes.transactions.h1.buys), sells: finiteOrNull(attributes.transactions.h1.sells) } : null,
      h24: attributes.transactions?.h24 ? { buys: finiteOrNull(attributes.transactions.h24.buys), sells: finiteOrNull(attributes.transactions.h24.sells) } : null
    },
    source: 'GeckoTerminal',
    fetchedAt
  };
}

export function createGeckoSource({ fetcher = fetch, clock = Date.now } = {}) {
  const limiter = createLimiter({ clock });
  const cache = createCache({ ttlMs: LIMITS.gecko.ttlMs, max: LIMITS.gecko.max, clock });
  const config = LIMITS.gecko;

  async function request(path) {
    const decision = limiter.tryTake('gecko', config.perMinute);
    if (!decision.ok) throw rateLimitError('GeckoTerminal', decision);
    try {
      return await getJSON(`${ORIGIN}${path}`, { fetcher, accept: ACCEPT });
    } catch (error) {
      limiter.refund('gecko');
      if (error.status === 429) limiter.cooldown('gecko', error.retryAfterMs ?? 60_000);
      throw error;
    }
  }

  async function get(path) {
    const { value } = await cache.resolve(path, () => request(path));
    return value;
  }

  return {
    name: 'GeckoTerminal',
    docs: GECKO_DOCS,
    async trending(page = 1) {
      const fetchedAt = new Date(clock()).toISOString();
      try {
        const data = await get(`/networks/solana/trending_pools?page=${Math.max(1, page)}`);
        if (!Array.isArray(data?.data)) throw new Error('skema trending_pools tidak valid');
        return { status: 'available', source: 'GeckoTerminal', fetchedAt, pools: data.data.map(raw => normalizeTrendingPool(raw, fetchedAt)).filter(Boolean), reason: null };
      } catch (error) {
        return { status: 'unknown', source: 'GeckoTerminal', fetchedAt, pools: [], reason: errorReason(error, 'Gecko trending: ') };
      }
    },
    async newPools(page = 1) {
      const fetchedAt = new Date(clock()).toISOString();
      try {
        const data = await get(`/networks/solana/new_pools?page=${Math.max(1, page)}`);
        if (!Array.isArray(data?.data)) throw new Error('skema new_pools tidak valid');
        return { status: 'available', source: 'GeckoTerminal', fetchedAt, pools: data.data.map(raw => normalizeTrendingPool(raw, fetchedAt)).filter(Boolean), reason: null };
      } catch (error) {
        return { status: 'unknown', source: 'GeckoTerminal', fetchedAt, pools: [], reason: errorReason(error, 'Gecko new pools: ') };
      }
    },
    /**
     * Candle untuk pool yang sudah diketahui. `timeframe` adalah pasangan
     * granularity/aggregate agar tidak menebak endpoint.
     */
    async candles(pool, mint, { granularity = 'hour', aggregate = 1, limit = 200 } = {}) {
      const fetchedAt = new Date(clock()).toISOString();
      if (typeof pool !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)) {
        return { status: 'unknown', source: 'GeckoTerminal', fetchedAt, candles: [], meta: null, reason: 'Alamat pool tidak valid; candle tidak diminta.' };
      }
      const token = typeof mint === 'string' && mint ? `&token=${mint}` : '';
      const path = `/networks/solana/pools/${pool}/ohlcv/${granularity}?aggregate=${aggregate}&limit=${Math.min(1000, Math.max(1, limit))}&currency=usd${token}&include_empty_intervals=true`;
      try {
        const data = await get(path);
        const rows = data?.data?.attributes?.ohlcv_list;
        if (!Array.isArray(rows)) throw new Error('skema ohlcv_list tidak valid');
        return { status: 'available', source: 'GeckoTerminal', fetchedAt, candles: rows, meta: data?.meta ?? null, timeframe: `${aggregate}${granularity === 'hour' ? 'h' : 'm'}`, reason: null };
      } catch (error) {
        return { status: 'unknown', source: 'GeckoTerminal', fetchedAt, candles: [], meta: null, timeframe: `${aggregate}${granularity === 'hour' ? 'h' : 'm'}`, reason: errorReason(error, 'Gecko candle: ') };
      }
    }
  };
}
