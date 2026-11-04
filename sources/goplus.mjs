import { LIMITS } from '../config.mjs';
import { createCache } from '../lib/cache.mjs';
import { createLimiter, rateLimitError } from '../lib/limiter.mjs';
import { getJSON, errorReason, createBreaker } from '../lib/http.mjs';
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

/**
 * Baca bentuk transfer fee/hook dari GoPlus:
 * - object/array yang tidak kosong → ada fee atau hook (berbahaya),
 * - object/array kosong atau boolean false → tidak ada,
 * - tidak ada atau null → unknown.
 */
function transferFlag(value) {
  if (value === null || value === undefined) return null;
  if (value === false || value === '0' || value === 'false') return false;
  if (value === true || value === '1' || value === 'true') return true;
  if (typeof value === 'object') return Object.keys(value).length ? true : false;
  return null;
}

export function normalizeGoPlus(raw, fetchedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const holders = Array.isArray(raw.holders) ? raw.holders : [];
  // Hanya persen yang benar-benar terbaca yang dihitung; kalau semua rusak,
  // hasilnya unknown, bukan "0% terdistribusi sempurna".
  const holderPercents = holders
    .map(holder => goPlusPercent(holder?.percent))
    .filter(percent => percent !== null && percent >= 0);
  const top10 = holderPercents
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((sum, percent) => sum + percent, 0);
  const lp = Array.isArray(raw.lp_holders) ? raw.lp_holders : [];
  // Menjumlahkan pasokan LP pada holder yang teridentifikasi menurut GoPlus.
  // Ini BUKAN porsi yang terkunci/terbakar: holder normal terlihat sama.
  const lpPercents = lp
    .map(holder => goPlusPercent(holder?.percent))
    .filter(percent => percent !== null && percent >= 0);
  const lpLocked = lpPercents.reduce((sum, percent) => sum + percent, 0);
  // GoPlus memakai tiga bentuk: object (ada fee/hook), array kosong, dan
  // boolean false. Bentuk boolean harus dibaca sebagai "tidak ada", bukan
  // unknown; kalau tidak, setiap token tanpa fee akan selalu partial.
  const transferFee = transferFlag(raw.transfer_fee);
  const transferHook = transferFlag(raw.transfer_hook);
  return {
    source: 'GoPlus',
    fetchedAt,
    mintable: status(raw.mintable),
    freezable: status(raw.freezable),
    nonTransferable: raw.non_transferable === '1' ? true : raw.non_transferable === '0' ? false : null,
    transferFee,
    transferFeeUpgradable: status(raw.transfer_fee_upgradable),
    transferHook,
    transferHookUpgradable: status(raw.transfer_hook_upgradable),
    metadataMutable: status(raw.metadata_mutable),
    holderCount: finiteOrNull(raw.holder_count),
    top10Pct: holderPercents.length ? Number(top10.toFixed(4)) : null,
    // Array kosong (atau tanpa persen yang bisa dibaca) berarti GoPlus tidak
    // mengidentifikasi holder LP; itu unknown, bukan "0% terkunci".
    lpHolderPct: lpPercents.length ? Number(lpLocked.toFixed(4)) : null,
    trustedToken: raw.trusted_token === 1 || raw.trusted_token === '1',
    totalSupply: finiteOrNull(raw.total_supply)
  };
}

export function createGoPlusSource({ fetcher = fetch, clock = Date.now } = {}) {
  const limiter = createLimiter({ clock });
  const cache = createCache({ ttlMs: LIMITS.goplus.ttlMs, max: LIMITS.goplus.max, clock });
  const breaker = createBreaker({ clock });
  const config = LIMITS.goplus;
  let lastCallAt = 0;

  async function security(mint, { refresh = false, background = false } = {}) {
    if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return { status: 'unknown', source: 'GoPlus', fetchedAt: null, security: null, reason: 'Alamat mint tidak valid; GoPlus tidak dipanggil.' };
    }
    const blocked = breaker.check();
    if (blocked.blocked) {
      return { status: 'unknown', source: 'GoPlus', fetchedAt: new Date(clock()).toISOString(), security: null, reason: `GoPlus sedang tidak dapat dihubungi (gagal berulang); jeda ${Math.ceil(blocked.retryAfterMs / 1000)} detik sebelum mencoba lagi.` };
    }
    let fetchedAt = new Date(clock()).toISOString();
    try {
      const { value, cached, at } = await cache.resolve(mint, async () => {
        // Permintaan latar menunggu slot tersedia; permintaan interaktif
        // menunggu sebentar lalu menyerah supaya UI tidak menggantung.
        const decision = background
          ? await limiter.wait('goplus', config.perMinute, 60_000, { reserve: config.interactiveReserve, maxWaitMs: 120_000 })
          : await limiter.wait('goplus', config.perMinute, 60_000, { reserve: 0, maxWaitMs: 10_000 });
        if (!decision.ok) throw rateLimitError('GoPlus', decision);
        const gap = clock() - lastCallAt;
        if (gap < config.minGapMs) await new Promise(resolve => setTimeout(resolve, config.minGapMs - gap));
        lastCallAt = clock();
        try {
          const data = await getJSON(`${ORIGIN}/api/v1/solana/token_security?contract_addresses=${mint}`, { fetcher });
          breaker.recordSuccess();
          return data;
        } catch (error) {
          // Hanya kegagalan jaringan (request kemungkinan tidak sampai ke
          // origin) yang mengembalikan slot; respons HTTP berarti origin
          // sudah bekerja.
          if (error.transient) limiter.refund('goplus', decision.slot);
          if (error.transient || (error.status ?? 0) >= 500) breaker.recordFailure();
          if (error.status === 429) limiter.cooldown('goplus', Math.max(error.retryAfterMs ?? 0, 30_000));
          throw error;
        }
      }, { bypass: refresh });
      fetchedAt = new Date(at).toISOString();
      const record = value?.result?.[mint];
      if (!record) {
        // Hasil negatif tidak boleh di-cache: token yang baru saja
        // diindeks GoPlus akan terkunci "unknown" selama masa cache.
        cache.remove(mint);
        return { status: 'unknown', source: 'GoPlus', fetchedAt, security: null, reason: 'GoPlus tidak mengembalikan record untuk mint ini. Ini bukan bukti aman.' };
      }
      const security = normalizeGoPlus(record, fetchedAt);
      const complete = [security.mintable, security.freezable, security.nonTransferable, security.transferFee, security.transferHook]
        .every(value => value !== null);
      return {
        status: complete ? 'available' : 'partial',
        source: 'GoPlus', fetchedAt, cached, security,
        reason: complete ? null : 'GoPlus mengembalikan record, tetapi sebagian kontrol kontrak tidak diketahui.'
      };
    } catch (error) {
      return { status: 'unknown', source: 'GoPlus', fetchedAt, security: null, reason: errorReason(error, 'GoPlus: ') };
    }
  }

  return { name: 'GoPlus', docs: GOPLUS_DOCS, security };
}
