import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRiskProvider } from '../risk.mjs';
import { createHistoryProvider, entryContext } from '../history.mjs';
import { CONFIG_HASH, DISCOVERY, ENTRY, PRESETS, getPreset } from '../config.mjs';
import { createJupiterSource } from '../sources/jupiter.mjs';
import { createDexScreenerSource } from '../sources/dexscreener.mjs';
import { createGeckoSource } from '../sources/gecko.mjs';
import { createGoPlusSource } from '../sources/goplus.mjs';
import { createDiscovery, createDeepScan, serializeCandidate, DISCOVERY_CONTEXT } from '../discover.mjs';
import { createJobs } from '../jobs.mjs';
import { evaluateGates } from '../screen/gates.mjs';
import { scoreCandidate } from '../screen/score.mjs';

export const DEX_DOCS = 'https://docs.dexscreener.com/api/reference';
export function validMint(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  let bytes = 0;
  while (n > 0n) { bytes++; n >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length || 0) === 32;
}
export function number(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
}
export function normalizeMarket(data, mint, now = Date.now()) {
  if (!Array.isArray(data)) throw new Error('Skema respons bukan daftar pool');
  const matches = data.filter(p => p && p.chainId === 'solana' && (p.baseToken?.address === mint || p.quoteToken?.address === mint));
  const pairs = matches.map(p => {
    const targetIsBase = p.baseToken?.address === mint;
    const created = number(p.pairCreatedAt);
    return {
      address: typeof p.pairAddress === 'string' ? p.pairAddress : null,
      dex: typeof p.dexId === 'string' ? p.dexId : 'unknown',
      base: p.baseToken?.symbol ?? 'unknown', quote: p.quoteToken?.symbol ?? 'unknown', targetIsBase,
      baseMint: p.baseToken?.address ?? null, quoteMint: p.quoteToken?.address ?? null,
      tokenName: targetIsBase ? p.baseToken?.name : p.quoteToken?.name,
      tokenSymbol: targetIsBase ? p.baseToken?.symbol : p.quoteToken?.symbol,
      // DEX Screener price/valuation fields refer to the base token, not necessarily the searched mint.
      priceUsd: targetIsBase ? number(p.priceUsd) : null,
      marketCap: targetIsBase ? number(p.marketCap) : null, fdv: targetIsBase ? number(p.fdv) : null,
      change24h: targetIsBase ? number(p.priceChange?.h24) : null,
      liquidityUsd: number(p.liquidity?.usd), volume24h: number(p.volume?.h24),
      buys24h: number(p.txns?.h24?.buys), sells24h: number(p.txns?.h24?.sells),
      ageHours: created !== null && created > 0 && created <= now ? (now - created) / 3_600_000 : null,
      createdAt: created !== null && created > 0 && created <= now ? new Date(created).toISOString() : null
    };
  }).sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1));
  const primary = pairs.find(p => p.targetIsBase) ?? null;
  const signals = [];
  if (!pairs.length) signals.push({ level: 'unknown', title: 'Pool tidak ditemukan', reason: 'DEX Screener tidak mengembalikan pool Solana untuk mint ini. Ini bukan bukti token aman atau mint valid on-chain.' });
  if (!primary && pairs.length) signals.push({ level: 'unknown', title: 'Harga token unknown', reason: 'Mint hanya muncul sebagai quote token. Harga dan valuasi base token tidak ditampilkan sebagai harga mint ini.' });
  if (primary) {
    signals.push(primary.liquidityUsd === null ? { level: 'unknown', title: 'Likuiditas unknown', reason: 'Nilai liquidity.usd tidak disediakan oleh sumber.' } : { level: primary.liquidityUsd < 50000 ? 'warning' : 'info', title: primary.liquidityUsd < 50000 ? 'Likuiditas pool tipis' : 'Likuiditas pool teramati', reason: `Pool utama memiliki likuiditas USD ${primary.liquidityUsd.toLocaleString('en-US')}. Ambang peringatan lokal < USD 50.000; bukan penilaian keamanan atau estimasi slippage.` });
    signals.push(primary.ageHours === null ? { level: 'unknown', title: 'Usia pool unknown', reason: 'Waktu pembuatan pool tidak tersedia atau tidak valid.' } : { level: primary.ageHours < 24 ? 'warning' : 'info', title: primary.ageHours < 24 ? 'Pool berusia di bawah 24 jam' : 'Usia pool teramati', reason: `Pool utama berusia ${primary.ageHours.toFixed(1)} jam. Usia pool bukan usia token; ambang lokal < 24 jam hanya penanda kehati-hatian.` });
  }
  return { status: pairs.length ? 'available' : 'empty', source: 'DEX Screener', docs: DEX_DOCS, pairs, primary, signals, reason: 'Pool utama = pool dengan mint sebagai base token dan likuiditas USD tertinggi yang dilaporkan. Data tiap pool tidak dijumlahkan; valuasi/harga dapat berbeda antar-pool.' };
}
export async function fetchMarket(mint, fetcher = fetch) {
  const source = createDexScreenerSource({ fetcher });
  const result = await source.tokenPairs(mint);
  const endpoint = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
  if (result.status !== 'available') {
    return { status: 'unknown', source: 'DEX Screener', docs: DEX_DOCS, endpoint, fetchedAt: new Date().toISOString(), reason: `Data pasar unknown: ${result.reason}. Coba lagi nanti.`, pairs: [], primary: null, signals: [] };
  }
  try {
    return { ...normalizeMarket(result.rows, mint), mint, endpoint, fetchedAt: result.fetchedAt };
  } catch (e) {
    return { status: 'unknown', source: 'DEX Screener', docs: DEX_DOCS, endpoint, fetchedAt: new Date().toISOString(), reason: `Data pasar unknown: ${e.message}. Coba lagi nanti.`, pairs: [], primary: null, signals: [] };
  }
}

/**
 * Provider pasar Inspect memakai sumber DEX Screener yang sama dengan
 * Discover, sehingga cache dan batas laju provider tidak dihitung dua kali
 * dan kedua tab memakai pool yang sama untuk mint yang sama.
 */
export function createMarketProvider({ dexscreener, clock = Date.now } = {}) {
  return async function market(mint, { refresh = false } = {}) {
    const endpoint = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
    const result = await dexscreener.tokenPairs(mint, { refresh });
    if (result.status !== 'available') {
      return {
        status: 'unknown', source: 'DEX Screener', docs: DEX_DOCS, endpoint, fetchedAt: new Date(clock()).toISOString(),
        reason: `Data pasar unknown: ${result.reason ?? 'DEX Screener tidak tersedia'}. Coba lagi nanti.`, pairs: [], primary: null, signals: []
      };
    }
    try {
      return { ...normalizeMarket(result.rows, mint, clock()), mint, endpoint, fetchedAt: result.fetchedAt };
    } catch (error) {
      return { status: 'unknown', source: 'DEX Screener', docs: DEX_DOCS, endpoint, fetchedAt: result.fetchedAt, reason: `Data pasar unknown: ${error.message}. Coba lagi nanti.`, pairs: [], primary: null, signals: [] };
    }
  };
}

function sendJSON(res, headers, status, data) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/**
 * Terapkan hasil deep scan ke baris yang sudah dikirim. Dipakai oleh cache
 * discover supaya permintaan berikutnya mengembalikan hasil final, bukan
 * skor awal yang berbeda angkanya.
 */
export function applyDeepResult(row, result) {
  if (!row || !result) return row;
  row.score = result.score;
  row.grade = result.grade;
  row.confidence = result.confidence;
  row.components = result.components;
  row.penalties = result.penalties;
  row.safety = result.safety;
  row.structure = result.structure;
  row.entryPlan = result.entryPlan;
  row.disqualified = result.disqualified ?? null;
  if (result.market) row.market = { ...row.market, ...result.market };
  if (result.candleSource) row.candleSource = result.candleSource;
  if (result.poolCheck) row.poolCheck = result.poolCheck;
  return row;
}

function allowedLocalMutationOrigin(req) {
  if (!req.headers.origin) return true; // non-browser local clients need no Origin header
  try {
    const origin = new URL(req.headers.origin);
    const expected = new URL(`http://${req.headers.host}`);
    return origin.protocol === 'http:' && origin.origin === expected.origin && ['localhost', '127.0.0.1'].includes(origin.hostname.toLowerCase());
  } catch {
    return false;
  }
}

class BodyError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'BodyError';
    this.statusCode = statusCode;
  }
}

async function readBody(req, limit = 32_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyError('Body terlalu besar.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BodyError('Body bukan JSON yang valid.', 400);
  }
}

export function createHandler({
  market = null,
  risk = null,
  history = null,
  db = null,
  jupiter = createJupiterSource(),
  dexscreener = createDexScreenerSource(),
  gecko = createGeckoSource(),
  goplus = createGoPlusSource(),
  jobs = null,
  discovery = null,
  deepScan = null,
  clock = Date.now
} = {}) {
  // Tanpa db yang disuntikkan, jalankan mode stateless alih-alih crash.
  const storage = db ?? { available: false, reason: 'db tidak disuntikkan; mode stateless', close() {} };
  const cache = new Map();
  const inFlight = new Map();
  const discoverCache = new Map();
  const discoverInFlight = new Map();
  let activeJobId = null;
  let activeJobIsDb = false;
  let windowStart = clock(), requests = 0;
  let discoverWindowStart = clock(), discoverRequests = 0;
  // Satu client per origin untuk seluruh aplikasi: Discover, Inspect, dan
  // deep scan memakai limiter dan cache yang sama, sehingga batas laju
  // provider tidak terhitung dua kali untuk satu origin.
  const marketProvider = market ?? createMarketProvider({ dexscreener, clock });
  const riskProvider = risk ?? createRiskProvider({ goplus, jupiter, clock });
  const historyProvider = history ?? createHistoryProvider({ gecko, clock });
  const jobQueue = jobs ?? createJobs({ concurrency: DISCOVERY.deepConcurrency, clock });
  const discover = discovery ?? createDiscovery({ jupiter, dexscreener, gecko, goplus, storage, clock });
  const deep = deepScan ?? createDeepScan({ gecko, goplus, dexscreener, clock });

  /**
   * Rekonstruksi konteks Jupiter dari baris awal supaya skor ulang memakai
   * komponen organic yang sama, bukan menghapusnya diam-diam.
   */
  function reconstructCandidate(base, mint) {
    return {
      mint,
      now: clock(),
      jupiter: base?.organic ? {
        mint,
        symbol: base.symbol,
        organicScore: base.organic.score,
        organicLabel: base.organic.label,
        isVerified: base.organic.verified,
        tags: base.organic.tags ?? [],
        holderCount: base.safety.holderCount ?? base.organic.holderCount,
        liquidityUsd: base.organic.liquidityUsd,
        // Audit Jupiter hanya disalin kalau memang sumber angka
        // konsentrasi; kalau angka berasal dari GoPlus, sumber
        // Jupiter jangan dipalsukan.
        audit: base.safety.top10Source === 'Jupiter' ? { topHoldersPercentage: base.safety.top10Pct } : {},
        stats: {}
      } : null,
      market: {
        pool: base?.market ? {
          poolAddress: base.market.poolAddress,
          dex: base.market.dex,
          liquidityUsd: base.market.liquidityUsd,
          createdAt: base.market.ageHours !== null ? clock() - base.market.ageHours * 3_600_000 : null,
          baseSymbol: base.symbol,
          quoteSymbol: base.market.quoteSymbol,
          priceUsd: base.market.priceUsd,
          marketCap: base.market.marketCap,
          fdv: base.market.fdv,
          change: base.market.change,
          volume: { m5: null, h1: base.market.volume1h, h6: base.market.volume6h, h24: base.market.volume24h },
          txns: { m5: null, h1: null, h6: null, h24: null }
        } : null,
        status: base?.market ? 'available' : 'empty'
      },
      safety: { status: 'unknown', security: null },
      structure: null,
      notionalUsd: ENTRY.notionalUsd
    };
  }

  /** Deep scan satu kandidat: gate ulang, skor ulang, rencana entry, persist. */
  async function executeDeepScan(candidate, { preset, refresh, mint, snapshotId, key, jobId }) {
    const presetDef = getPreset(preset);
    const enriched = await deep(candidate, { refresh });
    const gates = evaluateGates(enriched, presetDef);
    const scoring = scoreCandidate(enriched, presetDef);
    const serialized = serializeCandidate({ ...enriched, gates, scoring }, presetDef);
    if (storage.available && enriched.entryPlan) {
      try { await storage.recordPlan({ mint, createdAt: new Date(clock()).toISOString(), plan: enriched.entryPlan }); }
      catch { /* pencatatan rencana adalah upaya terbaik, bukan syarat hasil */ }
    }
    const payload = {
      mint,
      score: scoring.score,
      grade: scoring.grade,
      confidence: scoring.confidence,
      components: scoring.components,
      penalties: scoring.penalties,
      gates,
      // Deep scan bisa menemukan pelanggaran gate (mis. mintable) yang
      // tidak terlihat saat ranking awal. Tandai eksplisit agar UI
      // tidak menampilkannya seolah masih lolos.
      disqualified: gates.passed ? null : gates.rejections,
      safety: serialized.safety,
      structure: enriched.structure ? {
        status: enriched.structure.status, trend: enriched.structure.trend, rsi14: enriched.structure.rsi14,
        atrPct: enriched.structure.atrPct, distanceToHighPct: enriched.structure.distanceToHighPct,
        higherHigh: enriched.structure.higherHigh, higherLow: enriched.structure.higherLow,
        change24hPct: enriched.structure.change24hPct, timeframe: enriched.structure.timeframe,
        close: enriched.structure.close ?? null, lastClosedAt: enriched.structure.lastClosedAt ?? null,
        candles: enriched.structure.candles, dropped: enriched.structure.dropped ?? 0
      } : null,
      entryPlan: enriched.entryPlan,
      // Data pasar hasil pemeriksaan ulang pool dan waktu pengambilan
      // candle: tanpa ini UI tidak bisa menampilkan umur angkanya.
      market: serialized.market,
      poolCheck: enriched.poolCheck ?? null,
      candleSource: enriched.candleSource ?? null
    };
    // Skor final (setelah deep scan) menggantikan skor awal pada snapshot,
    // supaya backtest memakai grade yang benar-benar ditampilkan ke pengguna.
    if (storage.available && snapshotId != null) {
      try {
        await storage.updateSnapshotScore(snapshotId, {
          score: scoring.score,
          grade: scoring.grade,
          payload: { setup: enriched.entryPlan?.setup ?? null, gates: gates.warnings ?? [], scoreStage: 'deep' }
        });
      } catch { /* update skor adalah upaya terbaik */ }
    }
    // Perbarui cache discover hanya kalau jobId cocok dengan yang tercatat
    // di data cache: run yang lebih baru tidak boleh ditimpa run lama.
    const cached = key ? discoverCache.get(key) : null;
    if (cached && cached.data.jobId === jobId) {
      const cachedRow = cached.data.rows?.find(row => row.mint === mint);
      if (cachedRow) applyDeepResult(cachedRow, payload);
    }
    return payload;
  }

  /**
   * Pipeline discover: sampling universe → gate → skor → catat snapshot →
   * mulai deep scan → perbarui cache. Hanya dipanggil lewat single-flight
   * dari route, sehingga dua permintaan identik tidak menembak origin dua
   * kali dan tidak menulis snapshot dua kali.
   */
  async function runDiscover({ preset, limit, refresh, key }) {
    const result = await discover({ preset, limit, refresh });

    // Simpan snapshot untuk diff antar-run dan riwayat. Ditulis dalam satu
    // transaksi; kegagalan tidak menggagalkan respons discover.
    const snapshotIds = new Map();
    if (storage.available && typeof storage.persistSnapshots === 'function') {
      try {
        const at = result.finishedAt;
        const persistRows = result.rows.map(row => ({
          mint: row.mint,
          symbol: row.symbol,
          name: row.name,
          tags: row.organic?.tags,
          price: row.market.priceUsd,
          liquidityUsd: row.market.liquidityUsd,
          marketCap: row.market.marketCap,
          fdv: row.market.fdv,
          volume24h: row.market.volume24h,
          score: row.score,
          grade: row.grade,
          payload: { setup: row.entryPlan?.setup ?? null, gates: row.gates?.warnings ?? [], scoreStage: 'initial' }
        }));
        const ids = await storage.persistSnapshots({ at, rows: persistRows });
        for (const [mint, id] of ids) snapshotIds.set(mint, id);
      } catch (error) {
        if (Array.isArray(result.warnings)) result.warnings.push(`Snapshot tidak tersimpan: ${error?.message ?? 'kesalahan tidak dikenal'}.`);
      }
    }

    // Deep scan progresif: hasil awal langsung dikirim, detail di-patch via
    // /api/jobs/:id. Token diproses SATU PER POLL supaya fungsi serverless
    // (batas 60 detik) tetap bisa menyelesaikan satu deep scan utuh. Job baru
    // membatalkan antrean sebelumnya.
    if (activeJobId) {
      if (activeJobIsDb && typeof storage.cancelJob === 'function') await storage.cancelJob(activeJobId);
      else jobQueue.cancel(activeJobId);
    }
    activeJobId = null;
    activeJobIsDb = false;
    let job = null;
    const byMint = new Map(result.rows.map(row => [row.mint, row]));
    const makeContext = mint => {
      const original = result[DISCOVERY_CONTEXT]?.get(mint);
      return original ? { ...original, now: clock() } : reconstructCandidate(byMint.get(mint), mint);
    };
    const useDbJobs = !jobs && storage.available && typeof storage.createJobItems === 'function' && typeof storage.jobSummary === 'function';
    if (result.deepScanPending?.length) {
      if (useDbJobs) {
        const jobId = randomUUID();
        try {
          await storage.setJobMeta(jobId, { preset, cacheKey: key, refresh });
          await storage.createJobItems(jobId, result.deepScanPending.map(mint => ({
            mint,
            snapshotId: snapshotIds.get(mint) ?? null,
            context: makeContext(mint)
          })));
          job = { id: jobId, total: result.deepScanPending.length };
          activeJobIsDb = true;
        } catch (error) {
          if (Array.isArray(result.warnings)) result.warnings.push(`Deep scan gagal diantrekan: ${error?.message ?? 'kesalahan tidak dikenal'}.`);
        }
      }
      if (!job) {
        let createdId = null;
        const created = jobQueue.create(result.deepScanPending, mint => {
          const candidate = makeContext(mint);
          return executeDeepScan(candidate, { preset, refresh, mint, snapshotId: snapshotIds.get(mint) ?? null, key, jobId: createdId });
        });
        createdId = created.id;
        job = created;
      }
    }
    const response = { ...result, jobId: job?.id ?? null, jobTotal: job?.total ?? 0, refreshed: refresh };
    activeJobId = job?.id ?? null;
    discoverCache.set(key, { at: clock(), data: response });

    if (discoverCache.size > 8) discoverCache.delete(discoverCache.keys().next().value);
    return response;
  }

  return async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Cache-Control': 'no-store' };
    const send = (status, data, type = 'application/json; charset=utf-8') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data); };
    try {
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname.toLowerCase(); } catch { /* invalid Host is rejected below */ }
      // Di Vercel, routing berdasarkan Host ditangani platform itu sendiri:
      // request dengan Host yang tidak terdaftar pada project tidak pernah
      // sampai ke fungsi ini. Pengecekan loopback hanya berlaku untuk mode
      // lokal; APP_ORIGIN tetap didukung untuk self-host di belakang proxy.
      const isVercel = Boolean(process.env.VERCEL);
      if (!isVercel) {
        const allowedHosts = ['localhost', '127.0.0.1', '[::1]'];
        if (process.env.APP_ORIGIN) {
          try { allowedHosts.push(new URL(process.env.APP_ORIGIN).hostname.toLowerCase()); } catch { /* APP_ORIGIN tidak valid: diabaikan, fail closed */ }
        }
        if (!allowedHosts.includes(hostname)) return send(403, { error: 'Host harus berupa alamat loopback lokal.' });
      }
      const url = new URL(req.url, 'http://localhost');
      const readOnly = req.method === 'GET';

      if (url.pathname === '/api/watchlist' || url.pathname.startsWith('/api/watchlist/')) {
        if ((req.method === 'POST' || req.method === 'DELETE') && (!allowedLocalMutationOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site')) {
          return send(403, { error: 'Mutasi watchlist hanya diizinkan dari origin lokal yang sama.' });
        }
        if (!storage.available) return send(503, { error: storage.reason });
        if (readOnly && url.pathname === '/api/watchlist') {
          const items = await storage.listWatch();
          return send(200, { items, history: await storage.recentRuns(5) });
        }
        if (req.method === 'POST' && url.pathname === '/api/watchlist') {
          const body = await readBody(req);
          if (!validMint(body.mint)) return send(400, { error: 'Mint tidak valid.' });
          await storage.addWatch({ mint: body.mint, note: typeof body.note === 'string' ? body.note.slice(0, 500) : null, snapshot: body.snapshot ?? null, at: new Date(clock()).toISOString() });
          return send(200, { ok: true, items: await storage.listWatch() });
        }
        if (req.method === 'DELETE' && url.pathname.startsWith('/api/watchlist/')) {
          const mint = url.pathname.slice('/api/watchlist/'.length);
          if (!validMint(mint)) return send(400, { error: 'Mint tidak valid.' });
          return send(200, { ok: true, removed: await storage.removeWatch(mint), items: await storage.listWatch() });
        }
        return send(405, { error: 'Method tidak didukung untuk watchlist.' });
      }

      if (req.method !== 'GET') return send(405, { error: 'Hanya GET read-only yang diizinkan.' });

      if (url.pathname === '/api/discover') {
        const preset = url.searchParams.get('preset') || 'balanced';
        const limit = Math.min(DISCOVERY.resultLimit, Math.max(1, Number(url.searchParams.get('limit')) || DISCOVERY.resultLimit));
        // refresh=1 memaksa sampling baru: cache discover dan cache sumber
        // dilewati, jadi angka yang tampil benar-benar baru diambil.
        const refresh = ['1', 'true'].includes(url.searchParams.get('refresh'));
        const key = `${preset}:${limit}`;
        const hit = discoverCache.get(key);
        if (!refresh && hit && clock() - hit.at < 60_000) return send(200, { ...hit.data, cached: true });
        // Single-flight + batas lokal: discover mahal (sampling upstream
        // ditambah job deep scan), dan dua permintaan identik tidak boleh
        // menggandakan keduanya.
        if (!discoverInFlight.has(key)) {
          if (clock() - discoverWindowStart >= 60_000) { discoverWindowStart = clock(); discoverRequests = 0; }
          if (++discoverRequests > 10) return send(429, { error: 'Batas lokal 10 discover per menit tercapai. Tunggu satu menit.' });
          const tracked = runDiscover({ preset, limit, refresh, key })
            .finally(() => { if (discoverInFlight.get(key) === tracked) discoverInFlight.delete(key); });
          discoverInFlight.set(key, tracked);
        }
        return send(200, await discoverInFlight.get(key));
      }

      if (url.pathname.startsWith('/api/jobs/')) {
        const jobId = url.pathname.slice('/api/jobs/'.length);
        if (storage.available && typeof storage.jobMeta === 'function' && typeof storage.jobSummary === 'function') {
          const meta = await storage.jobMeta(jobId);
          if (meta) {
            // Tandai token yang macet (instance serverless berakhir di tengah
            // deep scan) sebagai gagal, supaya tidak menggantung selamanya.
            if (typeof storage.reapStaleJobItems === 'function') await storage.reapStaleJobItems(jobId, 90_000);
            // Satu token per poll: deep scan 13-20 detik tetap di bawah batas
            // waktu fungsi, dan dua tab yang polling bersamaan tidak menggandakan
            // pekerjaan (claim atomik oleh UPDATE ... RETURNING).
            const claim = await storage.claimJobItem(jobId);
            if (claim) {
              try {
                const candidate = claim.context
                  ? { ...claim.context, now: clock() }
                  : reconstructCandidate(null, claim.mint);
                const payload = await executeDeepScan(candidate, {
                  preset: meta.preset, refresh: meta.refresh,
                  mint: claim.mint, snapshotId: claim.snapshotId, key: meta.cacheKey, jobId
                });
                await storage.completeJobItem(claim.id, { ok: true, result: payload });
              } catch (error) {
                await storage.completeJobItem(claim.id, { ok: false, error: error?.message ?? 'deep scan gagal' });
              }
            }
            const summary = await storage.jobSummary(jobId);
            return send(200, {
              id: jobId,
              jobId,
              createdAt: meta.createdAt ?? null,
              status: summary?.status ?? 'done',
              total: summary?.total ?? 0,
              completed: summary?.completed ?? 0,
              failures: summary?.failures ?? 0,
              results: summary?.results ?? []
            });
          }
        }
        const job = jobQueue.get(jobId);
        if (!job) return send(404, { error: 'Job tidak ditemukan atau sudah kedaluwarsa.' });
        return send(200, { jobId, ...job });
      }

      if (url.pathname === '/api/config') {
        return send(200, {
          configHash: CONFIG_HASH,
          presets: Object.fromEntries(Object.entries(PRESETS).map(([key, value]) => [key, {
            label: value.label,
            description: value.description,
            thresholds: {
              minLiquidityUsd: value.minLiquidityUsd,
              minVolume24hUsd: value.minVolume24hUsd,
              minPoolAgeHours: value.minPoolAgeHours,
              minHolderCount: value.minHolderCount,
              maxTop10Pct: value.maxTop10Pct,
              maxFdvToMcap: value.maxFdvToMcap,
              maxTurnover: value.maxTurnover,
              minPriceChange24hPct: value.minPriceChange24hPct,
              maxPriceChange24hPct: value.maxPriceChange24hPct,
              requireVerified: value.requireVerified,
              allowUnknownSafety: value.allowUnknownSafety
            }
          }])),
          entry: ENTRY,
          discovery: DISCOVERY,
          storage: { available: storage.available, reason: storage.reason }
        });
      }

      if (url.pathname === '/api/history') {
        const mint = url.searchParams.get('mint');
        if (!validMint(mint)) return send(400, { error: 'Mint tidak valid.' });
        if (!storage.available) return send(503, { error: storage.reason });
        return send(200, { mint, snapshots: await storage.snapshotHistory(mint, 50), plan: await storage.latestPlan(mint) });
      }

      if (url.pathname === '/api/scan') {
        const mint = url.searchParams.get('mint')?.trim();
        if (!validMint(mint)) return send(400, { error: 'Masukkan alamat mint Solana base58 yang terdekode menjadi 32 byte. Validasi format tidak membuktikan alamat merupakan akun mint.' });
        const refresh = ['1', 'true'].includes(url.searchParams.get('refresh'));
        const hit = cache.get(mint);
        if (!refresh && hit && clock() - hit.at < 30000) return send(200, { ...hit.data, cached: true });
        if (clock() - windowStart >= 60000) { windowStart = clock(); requests = 0; }
        if (!inFlight.has(mint) || refresh) {
          if (++requests > 40) return send(429, { error: 'Batas lokal 40 scan per menit tercapai. Tunggu satu menit.' });
          const trackedScan = Promise.all([marketProvider(mint, { refresh }), riskProvider(mint, { refresh })]).then(async ([marketData, riskData]) => {
            const historical = await historyProvider(mint, marketData.primary);
            const data = { mint, checkedAt: new Date(clock()).toISOString(), cached: false, refreshed: refresh, market: marketData, risk: riskData, history: historical, entryContext: entryContext(marketData, riskData, historical), disclaimer: 'Read-only. Bukan rekomendasi beli/jual. Data pihak ketiga dapat terlambat atau tidak lengkap. Tidak ada hasil yang menjamin token aman.' };
            if (cache.size >= 100) cache.delete(cache.keys().next().value);
            cache.set(mint, { at: clock(), data }); return data;
          }).finally(() => { if (inFlight.get(mint) === trackedScan) inFlight.delete(mint); });
          inFlight.set(mint, trackedScan);
        }
        return send(200, await inFlight.get(mint));
      }
      if (url.pathname === '/api/health') return send(200, { status: 'ok', mode: 'read-only', storage: storage.available, configHash: CONFIG_HASH });
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
      const file = files[url.pathname];
      if (!file) return send(404, { error: 'Tidak ditemukan.' });
      try {
        return send(200, await readFile(new URL(`../public/${file[0]}`, import.meta.url), 'utf8'), file[1]);
      } catch (error) {
        if (error?.code === 'ENOENT') return send(404, { error: 'Tidak ditemukan.' });
        throw error;
      }
    } catch (error) {
      if (error instanceof BodyError) return send(error.statusCode, { error: error.message });
      sendJSON(res, headers, 500, { error: `Permintaan gagal: ${error?.message ?? 'kesalahan internal'}. Status keamanan yang tidak tersedia tetap unknown.` });
    }
  };
}
