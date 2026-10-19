import { LIMITS } from '../config.mjs';
import { createCache } from '../lib/cache.mjs';
import { createLimiter, rateLimitError } from '../lib/limiter.mjs';
import { getJSON, errorReason } from '../lib/http.mjs';
import { finiteOrNull } from '../lib/provenance.mjs';

export const GOPLUS_DOCS = 'https://docs.gopluslabs.io/reference/solana-token-security';
const ORIGIN = 'https://api.gopluslabs.io';

function status(value) {
  if (!value || typeof value !== 'object') return null;
  return value.status === '1' ? true : value.status === '0' ? false : null;
}

function goPlusPercent(value) {
  // GoPlus mengembalikan `percent` sebagai fraksi 0..1 (mis. "0.2478" = 24,78%),
  // berbeda dari Jupiter yang memakai poin persentase.
  const parsed = finiteOrNull(value);
  return parsed === null ? null : parsed * 100;
}

export function normalizeGoPlus(raw, fetchedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const holders = Array.isArray(raw.holders) ? raw.holders : [];
  const top10 = holders.slice(0, 10).reduce((sum, holder) => sum + (goPlusPercent(holder?.percent) ?? 0), 0);
  const lp = Array.isArray(raw.lp_holders) ? raw.lp_holders : [];
  const lpLocked = lp.reduce((sum, holder) => sum + (goPlusPercent(holder?.percent) ?? 0), 0);
  return {
    source: 'GoPlus',
    fetchedAt,
    mintable: status(raw.mintable),
    freezable: status(raw.freezable),
    nonTransferable: raw.non_transferable === '1' ? true : raw.non_transferable === '0' ? false : null,
    transferFee: raw.transfer_fee && Object.keys(raw.transfer_fee).length ? raw.transfer_fee : null,
    transferFeeUpgradable: status(raw.transfer_fee_upgradable),
    transferHook: Array.isArray(raw.transfer_hook) && raw.transfer_hook.length ? raw.transfer_hook : null,
    transferHookUpgradable: status(raw.transfer_hook_upgradable),
    metadataMutable: status(raw.metadata_mutable),
    holderCount: finiteOrNull(raw.holder_count),
    top10Pct: holders.length ? Number(top10.toFixed(4)) : null,
    // Array kosong berarti GoPlus tidak mengidentifikasi holder LP; itu unknown,
    // bukan "0% terkunci".
    lpHolderPct: lp.length ? Number(lpLocked.toFixed(4)) : null,
    trustedToken: raw.trusted_token === 1,
    totalSupply: finiteOrNull(raw.total_supply)
  };
}

export function createGoPlusSource({ fetcher = fetch, clock = Date.now } = {}) {
  const limiter = createLimiter({ clock });
  const cache = createCache({ ttlMs: LIMITS.goplus.ttlMs, max: LIMITS.goplus.max, clock });
  const config = LIMITS.goplus;
  let lastCallAt = 0;

  async function security(mint) {
    if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return { status: 'unknown', source: 'GoPlus', fetchedAt: null, security: null, reason: 'Alamat mint tidak valid; GoPlus tidak dipanggil.' };
    }
    const fetchedAt = new Date(clock()).toISOString();
    try {
      const { value, cached } = await cache.resolve(mint, async () => {
        const decision = limiter.tryTake('goplus', config.perMinute);
        if (!decision.ok) throw rateLimitError('GoPlus', decision);
        const gap = clock() - lastCallAt;
        if (gap < config.minGapMs) await new Promise(resolve => setTimeout(resolve, config.minGapMs - gap));
        lastCallAt = clock();
        try {
          return await getJSON(`${ORIGIN}/api/v1/solana/token_security?contract_addresses=${mint}`, { fetcher });
        } catch (error) {
          limiter.refund('goplus');
          if (error.status === 429) limiter.cooldown('goplus', error.retryAfterMs ?? 30_000);
          throw error;
        }
      });
      const record = value?.result?.[mint];
      if (!record) {
        return { status: 'unknown', source: 'GoPlus', fetchedAt, security: null, reason: 'GoPlus tidak mengembalikan record untuk mint ini. Ini bukan bukti aman.' };
      }
      return { status: 'available', source: 'GoPlus', fetchedAt, cached, security: normalizeGoPlus(record, fetchedAt), reason: null };
    } catch (error) {
      return { status: 'unknown', source: 'GoPlus', fetchedAt, security: null, reason: errorReason(error, 'GoPlus: ') };
    }
  }

  return { name: 'GoPlus', docs: GOPLUS_DOCS, security };
}
