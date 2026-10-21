import { LIMITS } from '../config.mjs';
import { createCache } from '../lib/cache.mjs';
import { createLimiter, rateLimitError } from '../lib/limiter.mjs';
import { getJSON, errorReason, createBreaker, HttpError } from '../lib/http.mjs';
import { finiteOrNull } from '../lib/provenance.mjs';

export const JUPITER_DOCS = 'https://dev.jup.ag/docs/api/';
const ORIGIN = 'https://lite-api.jup.ag';
const INTERVALS = ['5m', '1h', '6h', '24h'];

function labelRank(label) {
  return { low: 0, medium: 1, high: 2 }[label] ?? -1;
}
export { labelRank };

export function normalizeJupiterToken(raw, fetchedAt) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const audit = raw.audit && typeof raw.audit === 'object' ? raw.audit : {};
  const stats = {};
  for (const interval of INTERVALS) {
    const value = raw[`stats${interval}`];
    stats[interval] = value && typeof value === 'object' ? {
      priceChange: finiteOrNull(value.priceChange),
      buyVolume: finiteOrNull(value.buyVolume),
      sellVolume: finiteOrNull(value.sellVolume),
      buyOrganicVolume: finiteOrNull(value.buyOrganicVolume),
      sellOrganicVolume: finiteOrNull(value.sellOrganicVolume),
      numBuys: finiteOrNull(value.numBuys),
      numSells: finiteOrNull(value.numSells),
      numTraders: finiteOrNull(value.numTraders),
      numOrganicBuyers: finiteOrNull(value.numOrganicBuyers),
      numNetBuyers: finiteOrNull(value.numNetBuyers)
    } : null;
  }
  return {
    mint: raw.id,
    symbol: typeof raw.symbol === 'string' ? raw.symbol : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    decimals: finiteOrNull(raw.decimals),
    icon: typeof raw.icon === 'string' ? raw.icon : null,
    tokenProgram: typeof raw.tokenProgram === 'string' ? raw.tokenProgram : null,
    isVerified: raw.isVerified === true,
    tags: Array.isArray(raw.tags) ? raw.tags.filter(tag => typeof tag === 'string') : [],
    organicScore: finiteOrNull(raw.organicScore),
    organicLabel: typeof raw.organicScoreLabel === 'string' ? raw.organicScoreLabel : null,
    holderCount: finiteOrNull(raw.holderCount),
    liquidityUsd: finiteOrNull(raw.liquidity),
    usdPrice: finiteOrNull(raw.usdPrice),
    marketCap: finiteOrNull(raw.mcap),
    fdv: finiteOrNull(raw.fdv),
    launchpad: typeof raw.launchpad === 'string' ? raw.launchpad : null,
    firstPoolAt: typeof raw.firstPool?.createdAt === 'string' ? raw.firstPool.createdAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    audit: {
      mintAuthorityDisabled: audit.mintAuthorityDisabled === true,
      freezeAuthorityDisabled: audit.freezeAuthorityDisabled === true,
      topHoldersPercentage: finiteOrNull(audit.topHoldersPercentage),
      devMints: finiteOrNull(audit.devMints),
      devMigrations: finiteOrNull(audit.devMigrations)
    },
    stats,
    source: 'Jupiter',
    fetchedAt
  };
}

export function createJupiterSource({ fetcher = fetch, clock = Date.now } = {}) {
  const limiter = createLimiter({ clock });
  const cache = createCache({ ttlMs: LIMITS.jupiter.ttlMs, max: LIMITS.jupiter.max, clock });
  const breaker = createBreaker({ clock });
  const config = LIMITS.jupiter;

  async function request(path) {
    const blocked = breaker.check();
    if (blocked.blocked) {
      throw new HttpError(`Jupiter sedang tidak dapat dihubungi (gagal berulang); jeda ${Math.ceil(blocked.retryAfterMs / 1000)} detik sebelum mencoba lagi.`, { url: path });
    }
    const decision = limiter.tryTake('jupiter', config.perMinute);
    if (!decision.ok) throw rateLimitError('Jupiter', decision);
    try {
      const data = await getJSON(`${ORIGIN}${path}`, { fetcher, headers: { 'User-Agent': 'solana-paper-scanner/2' } });
      breaker.recordSuccess();
      return data;
    } catch (error) {
      limiter.refund('jupiter');
      if (error.transient) breaker.recordFailure();
      if (error.status === 429) limiter.cooldown('jupiter', error.retryAfterMs ?? 30_000);
      throw error;
    }
  }

  async function list(path, { refresh = false } = {}) {
    const { value } = await cache.resolve(path, () => request(path), { bypass: refresh });
    return value;
  }

  return {
    name: 'Jupiter',
    docs: JUPITER_DOCS,
    async topOrganic(interval = '1h', limit = 100, { refresh = false } = {}) {
      if (!INTERVALS.includes(interval)) throw new Error(`Interval Jupiter tidak dikenal: ${interval}`);
      const fetchedAt = new Date(clock()).toISOString();
      try {
        const data = await list(`/tokens/v2/toporganicscore/${interval}?limit=${Math.min(100, Math.max(1, limit))}`, { refresh });
        if (!Array.isArray(data)) throw new Error('skema bukan daftar token');
        return { status: 'available', source: 'Jupiter', interval, fetchedAt, tokens: data.map(raw => normalizeJupiterToken(raw, fetchedAt)).filter(Boolean), reason: null };
      } catch (error) {
        return { status: 'unknown', source: 'Jupiter', interval, fetchedAt, tokens: [], reason: errorReason(error, 'Jupiter top organic: ') };
      }
    },
    async topTrending(interval = '1h', limit = 100, { refresh = false } = {}) {
      if (!INTERVALS.includes(interval)) throw new Error(`Interval Jupiter tidak dikenal: ${interval}`);
      const fetchedAt = new Date(clock()).toISOString();
      try {
        const data = await list(`/tokens/v2/toptrending/${interval}?limit=${Math.min(100, Math.max(1, limit))}`, { refresh });
        if (!Array.isArray(data)) throw new Error('skema bukan daftar token');
        return { status: 'available', source: 'Jupiter', interval, fetchedAt, tokens: data.map(raw => normalizeJupiterToken(raw, fetchedAt)).filter(Boolean), reason: null };
      } catch (error) {
        return { status: 'unknown', source: 'Jupiter', interval, fetchedAt, tokens: [], reason: errorReason(error, 'Jupiter trending: ') };
      }
    },
    async recent(limit = 100, { refresh = false } = {}) {
      const fetchedAt = new Date(clock()).toISOString();
      try {
        const data = await list(`/tokens/v2/recent?limit=${Math.min(100, Math.max(1, limit))}`, { refresh });
        if (!Array.isArray(data)) throw new Error('skema bukan daftar token');
        return { status: 'available', source: 'Jupiter', fetchedAt, tokens: data.map(raw => normalizeJupiterToken(raw, fetchedAt)).filter(Boolean), reason: null };
      } catch (error) {
        return { status: 'unknown', source: 'Jupiter', fetchedAt, tokens: [], reason: errorReason(error, 'Jupiter recent: ') };
      }
    }
  };
}
