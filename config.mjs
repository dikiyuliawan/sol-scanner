import { createHash } from 'node:crypto';

export const CONFIG_VERSION = '2026-11-06.2';

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
    minPriceChange24hPct: -15,
    maxPriceChange24hPct: 150,
    minBuyRatio24h: 0.5,
    requireKnownMarketCap: true,
    // Kurva upside digeser ke bawah: token $10jt di preset ini sudah "besar".
    upsideMaxMarketCapUsd: 25_000_000,
    upsideMinMarketCapUsd: 250_000,
    upsideMaxLiquidityUsd: 3_000_000,
    rejectDowntrend: true,
    allowUnknownSafety: false
  },
  balanced: {
    label: 'Balanced',
    description: 'Likuiditas dan usia pool memadai, holder cukup tersebar. Default.',
    minLiquidityUsd: 150_000,
    minVolume24hUsd: 50_000,
    minPoolAgeHours: 48,
    minHolderCount: 1_500,
    maxTop10Pct: 30,
    minMarketCapUsd: 1_000_000,
    maxFdvToMcap: 1.5,
    minTurnover: 0.15,
    maxTurnover: 10,
    requireVerified: false,
    minOrganicLabel: 'medium',
    minPriceChange24hPct: -30,
    maxPriceChange24hPct: 100,
    minBuyRatio24h: 0.45,
    rejectDowntrend: true,
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
    minBuyRatio24h: 0.4,
    // Ambang pola rug terpisah dari maxTop10Pct. Sebelumnya memakai
    // maxTop10Pct (60%), yang sudah pasti ditolak concentration_high lebih
    // dulu sehingga gate ini tidak pernah menambah apa pun.
    rugTop10Pct: 40,
    // Upside di Degen: geser kurva agar pool $60k–$1jt tidak otomatis 100.
    upsideMaxMarketCapUsd: 20_000_000,
    upsideMinMarketCapUsd: 100_000,
    upsideMaxLiquidityUsd: 1_500_000,
    rejectDowntrend: false,
    allowUnknownSafety: true
  },
  // Preset khusus hidden gem: menerima token kecil/baru yang masih punya
  // ruang naik besar, tetapi bahaya kontrak eksplisit tetap menggugurkan.
  gem: {
    label: 'Gem hunter',
    description: 'Token kecil dan baru untuk ruang naik besar. Risiko sangat tinggi; gate keamanan eksplisit tetap berlaku.',
    minLiquidityUsd: 50_000,
    minVolume24hUsd: 15_000,
    minPoolAgeHours: 1,
    minHolderCount: 100,
    maxTop10Pct: 45,
    minMarketCapUsd: 50_000,
    // Batas atas: token di atas $5jt bukan lagi hidden gem untuk preset ini.
    maxMarketCapUsd: 5_000_000,
    maxFdvToMcap: 5,
    minTurnover: 0.1,
    // Turnover tinggi pada pool kecil sering menandakan hype nyata, bukan
    // wash. Batas atas tetap ada agar wash-trading ekstrem tidak lolos.
    maxTurnover: 80,
    requireVerified: false,
    minOrganicLabel: 'low',
    minPriceChange24hPct: -60,
    // Multi-bagger sering SUDAH naik >500% dalam 24 jam. Batas atas di sini
    // sengaja sangat longgar; pump diberi penalti skor, bukan gugur gate.
    maxPriceChange24hPct: 2000,
    minBuyRatio24h: 0.35,
    // Tidak ada gate pola-rug tambahan di preset paling agresif ini: ambang
    // maxTop10Pct (45%) sudah menjadi batas keras, dan informasi kunci LP
    // jarang tersedia untuk token mikro sehingga gate ini akan menolak hampir
    // seluruh kohort yang justru dicari preset ini.
    rugTop10Pct: null,
    // Kurva paling agresif: $50k = ruang naik penuh, $5jt sudah "mapan".
    upsideMaxMarketCapUsd: 5_000_000,
    upsideMinMarketCapUsd: 50_000,
    upsideMaxLiquidityUsd: 750_000,
    rejectDowntrend: false,
    allowUnknownSafety: true
  }
};

/**
 * Bobot global adalah fallback untuk preset yang tidak punya bobot sendiri.
 * Preset boleh menimpa sebagian atau seluruh bobot lewat `weights`.
 *
 * Alasannya: satu set bobot tidak bisa melayani tiga profil risiko. Preset
 * Conservative yang memakai upside 25 akan menghukum token aman justru karena
 * token itu aman; Gem hunter yang memakai safety 22 akan memberi nilai tinggi
 * pada token yang sudah mapan. Bobot per preset membuat "skor" berarti hal
 * yang berbeda per preset — dan itu memang tujuannya, karena gate-nya berbeda.
 */
export const SCORE_WEIGHTS = {
  safety: 22,
  liquidity: 15,
  momentum: 14,
  structure: 15,
  organic: 9,
  upside: 25
};

/** Bobot per preset; harus berjumlah 100 agar `confidence` tetap bermakna. */
export const PRESET_WEIGHTS = {
  // Aman dulu: keamanan dan struktur mendominasi, upside kecil.
  conservative: { safety: 34, liquidity: 20, momentum: 15, structure: 18, organic: 10, upside: 3 },
  // Default: kualitas tetap utama, upside cukup untuk mengangkat token kecil.
  balanced: { safety: 22, liquidity: 15, momentum: 14, structure: 15, organic: 9, upside: 25 },
  // Risiko tinggi: upside dan momentum dominan, safety tetap cukup untuk
  // membedakan token yang jelas berbahaya.
  degen: { safety: 15, liquidity: 10, momentum: 20, structure: 15, organic: 10, upside: 30 },
  // Paling agresif: upside terbesar; safety hanya pembeda terakhir karena
  // bahaya eksplisit sudah digugurkan gate.
  gem: { safety: 12, liquidity: 10, momentum: 22, structure: 13, organic: 8, upside: 35 }
};

export function weightsForPreset(name) {
  const override = PRESET_WEIGHTS[name];
  return override ? { ...SCORE_WEIGHTS, ...override } : SCORE_WEIGHTS;
}

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
  // Kandidat "hampir lolos": diberi skor penuh walau gagal gate, supaya
  // token yang digugurkan satu gate (sering justru kandidat gem) tetap bisa
  // dibaca, diurutkan, dan dipelajari. Jumlahnya dibatasi karena tiap baris
  // membawa payload besar.
  nearMissLimit: 20,
  // Batas atas market cap untuk komponen upside. Token di atas batas ini
  // masih dinilai tetapi ruang naiknya dianggap paling kecil.
  upsideMaxMarketCapUsd: 50_000_000,
  // Batas atas likuiditas untuk komponen upside: likuiditas raksasa berarti
  // token sudah mapan, bukan hidden gem.
  upsideMaxLiquidityUsd: 2_000_000,
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

/**
 * Batas waktu satu poll di Vercel (60 detik). Tunggu slot latar dibatasi
 * supaya satu poll tetap selesai di bawah batas itu; item yang macet di
 * status processing ditandai gagal setelah reapAfterMs (lebih lama dari satu
 * poll penuh, sehingga tidak menandai item yang masih berjalan).
 */
export const SERVERLESS = {
  backgroundWaitMs: 30_000,
  reapAfterMs: 75_000
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
  return { name: key, ...PRESETS[key], weights: weightsForPreset(key) };
}

export function configHash() {
  return createHash('sha256')
    .update(JSON.stringify({ CONFIG_VERSION, PRESETS, SCORE_WEIGHTS, PRESET_WEIGHTS, ENTRY, GRADE_THRESHOLDS, DISCOVERY, LIMITS }))
    .digest('hex')
    .slice(0, 12);
}

export const CONFIG_HASH = configHash();
