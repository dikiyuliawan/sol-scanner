import { createHash } from 'node:crypto';

export const CONFIG_VERSION = '2026-10-20.1';

/**
 * Preset hanya mengubah angka, bukan kode. Semua ambang di sini adalah
 * heuristik yang belum dikalibrasi ulang oleh backtest; versi dicatat di
 * setiap run agar hasil lama tidak tercampur dengan aturan baru.
 */
export const PRESETS = {
  conservative: {
    label: 'Conservative',
    description: 'Likuid, berumur, dan sudah terverifikasi. Kandidat lebih sedikit.',
    minLiquidityUsd: 250_000,
    minVolume24hUsd: 100_000,
    minPoolAgeHours: 168,
    minHolderCount: 2_000,
    maxTop10Pct: 25,
    minMarketCapUsd: 2_000_000,
    maxFdvToMcap: 1.5,
    minTurnover: 0.15,
    maxTurnover: 8,
    requireVerified: true,
    minOrganicLabel: 'medium',
    minPriceChange24hPct: -25,
    maxPriceChange24hPct: 150,
    allowUnknownSafety: false
  },
  balanced: {
    label: 'Balanced',
    description: 'Likuiditas dan usia pool memadai, holder cukup tersebar. Default.',
    minLiquidityUsd: 150_000,
    minVolume24hUsd: 50_000,
    minPoolAgeHours: 48,
    minHolderCount: 1_000,
    maxTop10Pct: 30,
    minMarketCapUsd: 1_000_000,
    maxFdvToMcap: 1.5,
    minTurnover: 0.15,
    maxTurnover: 10,
    requireVerified: false,
    minOrganicLabel: 'medium',
    minPriceChange24hPct: -30,
    maxPriceChange24hPct: 150,
    allowUnknownSafety: true
  },
  degen: {
    label: 'Degen / new pools',
    description: 'Pool baru dan likuiditas lebih tipis. Risiko jauh lebih tinggi.',
    minLiquidityUsd: 60_000,
    minVolume24hUsd: 20_000,
    minPoolAgeHours: 1,
    minHolderCount: 200,
    maxTop10Pct: 60,
    minMarketCapUsd: 100_000,
    maxFdvToMcap: 4,
    minTurnover: 0.1,
    maxTurnover: 40,
    requireVerified: false,
    minOrganicLabel: 'low',
    minPriceChange24hPct: -50,
    maxPriceChange24hPct: 500,
    allowUnknownSafety: true
  }
};

export const SCORE_WEIGHTS = {
  safety: 25,
  liquidity: 20,
  momentum: 20,
  structure: 25,
  organic: 10
};

export const LIMITS = {
  // Batas publik Jupiter yang terukur: burst beberapa request memicu 429,
  // jadi batas lokal disetel konservatif.
  jupiter: { perMinute: 15, ttlMs: 60_000, max: 30 },
  dexscreener: { perMinute: 30, ttlMs: 30_000, max: 120, batchSize: 30 },
  // Batas GeckoTerminal publik yang terukur dari jaringan pengembangan:
  // ~4-5 request per menit aman, burst 3 request sudah memicu 429, dan
  // header Retry-After-nya bernilai "0" sehingga tidak bisa dipakai
  // sendiri. Karena itu: batas lokal 6/menit, jarak minimum antar
  // request 10 detik, dan cooldown minimum 30 detik saat 429.
  gecko: { perMinute: 6, ttlMs: 60_000, max: 200, minGapMs: 10_000, interactiveReserve: 1 },
  // Record GoPlus boleh berumur 5 menit, tetapi hasil negatif (mint belum
  // diindeks) tidak pernah di-cache.
  goplus: { perMinute: 20, ttlMs: 300_000, max: 200, minGapMs: 300, interactiveReserve: 4 }
};

export const DISCOVERY = {
  universeLimit: 100,
  maxCandidatesForMarket: 60,
  resultLimit: 20,
  // 0 = semua baris yang lolos gate ikut di-deep-scan. Job berjalan di
  // belakang dan diberi tempo, jadi tidak menambah waktu tunggu respons.
  deepScanTokens: 0,
  deepConcurrency: 1,
  // Kandidat yang tidak punya data holder Jupiter (mis. dari GeckoTerminal)
  // diverifikasi lewat GoPlus, karena tanpa jumlah holder gate akan
  // menolaknya sebagai unknown.
  verifySafetyTop: 12,
  verifyHolderTop: 10,
  runHistory: 20,
  // Daftar ranking Jupiter bergerak lambat: refresh berturut-turut selalu
  // menghasilkan token yang sama. Jendela 10 menit + pergeseran terjadwal
  // membuat tiap refresh mengambil potongan berbeda dari daftar yang sama.
  rotateWindowMs: 600_000,
  rotateStep: 37,
  // Lima posisi teratas tiap daftar tidak digeser supaya kandidat terbaik
  // tidak hilang dari run; sisanya bergeser setiap jendela.
  rotateHeadFixed: 5,
  // Tempo antar token pada deep scan. 10 detik ≈ 6 permintaan Gecko per
  // menit, di bawah batas publik yang terukur (~4-5 per menit).
  deepScanPaceMs: 10_000,
  // Pool baru GeckoTerminal hanya diambil kalau preset memang menerima
  // likuiditas tipis; untuk preset lain satu request itu terbuang.
  newPoolsMaxMinLiquidityUsd: 60_000,
  // Porsi kuota GeckoTerminal yang dicadangkan untuk permintaan interaktif
  // (tab Inspect) supaya deep scan_background tidak membuat Inspect kehabisan
  // kuota.
  interactiveReserve: 2
};

export const ENTRY = {
  notionalUsd: 500,
  maxSlippagePct: 2,
  paperBankrollUsd: 1_000,
  riskPerTradePct: 1,
  zoneAtrMultiple: 0.25,
  stopAtrMultiple: 1,
  minRiskReward: 1.5,
  extendedPct: 12
};

export const GRADE_THRESHOLDS = { A: 75, B: 60, C: 45 };

/** Aset dasar yang bukan kandidat "token baru untuk entry". */
export const EXCLUDED_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
]);

export const EXCLUDED_TAGS = new Set(['stable', 'wrapped', 'lst', 'major']);

export function getPreset(name) {
  const key = typeof name === 'string' && name in PRESETS ? name : 'balanced';
  return { name: key, ...PRESETS[key] };
}

export function configHash() {
  return createHash('sha256')
    .update(JSON.stringify({ CONFIG_VERSION, PRESETS, SCORE_WEIGHTS, ENTRY, GRADE_THRESHOLDS, DISCOVERY, LIMITS }))
    .digest('hex')
    .slice(0, 12);
}

export const CONFIG_HASH = configHash();
