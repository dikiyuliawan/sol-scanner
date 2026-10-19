import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchRisk } from './risk.mjs';
import { createHistoryProvider, entryContext } from './history.mjs';
import { CONFIG_HASH, DISCOVERY, ENTRY, PRESETS, getPreset } from './config.mjs';
import { createJupiterSource } from './sources/jupiter.mjs';
import { createDexScreenerSource } from './sources/dexscreener.mjs';
import { createGeckoSource } from './sources/gecko.mjs';
import { createGoPlusSource } from './sources/goplus.mjs';
import { createDiscovery, createDeepScan, serializeCandidate, DISCOVERY_CONTEXT } from './discover.mjs';
import { createJobs } from './jobs.mjs';
import { createDb } from './db.mjs';
import { evaluateGates } from './screen/gates.mjs';
import { scoreCandidate } from './screen/score.mjs';

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
async function readTextLimited(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* oversized body is already rejected */ }
      throw new Error('Respons terlalu besar');
    }
    chunks.push(Buffer.from(value));
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size));
}
export async function getJSON(url, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await readTextLimited(response, 4_000_000);
  return JSON.parse(text);
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
  const endpoint = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
  try { return { ...normalizeMarket(await getJSON(endpoint, fetcher), mint), endpoint, fetchedAt: new Date().toISOString() }; }
  catch (e) { return { status: 'unknown', source: 'DEX Screener', docs: DEX_DOCS, endpoint, fetchedAt: new Date().toISOString(), reason: `Data pasar unknown: ${e.name === 'TimeoutError' ? 'batas waktu 10 detik' : e.message}. Coba lagi nanti.`, pairs: [], primary: null, signals: [] }; }
}

function sendJSON(res, headers, status, data) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
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

async function readBody(req, limit = 32_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body terlalu besar');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createServer({
  market = fetchMarket,
  risk = fetchRisk,
  history = createHistoryProvider(),
  db = createDb(),
  jupiter = createJupiterSource(),
  dexscreener = createDexScreenerSource(),
  gecko = createGeckoSource(),
  goplus = createGoPlusSource(),
  jobs = createJobs(),
  discovery = null,
  deepScan = null,
  clock = Date.now
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const discoverCache = new Map();
  let windowStart = Date.now(), requests = 0;
  const discover = discovery ?? createDiscovery({ jupiter, dexscreener, gecko, goplus, db, clock });
  const deep = deepScan ?? createDeepScan({ gecko, goplus, clock });

  return http.createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Cache-Control': 'no-store' };
    const send = (status, data, type = 'application/json; charset=utf-8') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data); };
    try {
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname.toLowerCase(); } catch { /* invalid Host is rejected below */ }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return send(403, { error: 'Host harus berupa alamat loopback lokal.' });
      const url = new URL(req.url, 'http://localhost');
      const readOnly = req.method === 'GET';

      if (url.pathname.startsWith('/api/watchlist')) {
        if ((req.method === 'POST' || req.method === 'DELETE') && (!allowedLocalMutationOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site')) {
          return send(403, { error: 'Mutasi watchlist hanya diizinkan dari origin lokal yang sama.' });
        }
        if (!db.available) return send(503, { error: db.reason });
        if (readOnly && url.pathname === '/api/watchlist') {
          const items = db.listWatch();
          return send(200, { items, history: db.recentRuns(5) });
        }
        if (req.method === 'POST' && url.pathname === '/api/watchlist') {
          const body = await readBody(req);
          if (!validMint(body.mint)) return send(400, { error: 'Mint tidak valid.' });
          db.addWatch({ mint: body.mint, note: typeof body.note === 'string' ? body.note.slice(0, 500) : null, snapshot: body.snapshot ?? null, at: new Date(clock()).toISOString() });
          return send(200, { ok: true, items: db.listWatch() });
        }
        if (req.method === 'DELETE' && url.pathname.startsWith('/api/watchlist/')) {
          const mint = url.pathname.slice('/api/watchlist/'.length);
          if (!validMint(mint)) return send(400, { error: 'Mint tidak valid.' });
          return send(200, { ok: true, removed: db.removeWatch(mint), items: db.listWatch() });
        }
        return send(405, { error: 'Method tidak didukung untuk watchlist.' });
      }

      if (req.method !== 'GET') return send(405, { error: 'Hanya GET read-only yang diizinkan.' });

      if (url.pathname === '/api/discover') {
        const preset = url.searchParams.get('preset') || 'balanced';
        const limit = Math.min(DISCOVERY.resultLimit, Math.max(1, Number(url.searchParams.get('limit')) || DISCOVERY.resultLimit));
        const key = `${preset}:${limit}`;
        const hit = discoverCache.get(key);
        if (hit && Date.now() - hit.at < 60_000) return send(200, { ...hit.data, cached: true });
        const result = await discover({ preset, limit });

        // Simpan snapshot untuk diff antar-run dan riwayat.
        if (db.available) {
          const at = result.finishedAt;
          for (const row of result.rows) {
            db.upsertToken({ mint: row.mint, symbol: row.symbol, name: row.name, tags: row.organic?.tags, at });
            db.recordSnapshot({ mint: row.mint, takenAt: at, price: row.market.priceUsd, liquidityUsd: row.market.liquidityUsd, marketCap: row.market.marketCap, fdv: row.market.fdv, volume24h: row.market.volume24h, score: row.score, grade: row.grade, payload: { setup: row.entryPlan?.setup ?? null, gates: row.gates?.warnings ?? [] } });
          }
        }

        // Deep scan progresif: hasil awal langsung dikirim, detail di-patch via /api/jobs/:id.
        let job = null;
        if (result.deepScanPending?.length) {
          const byMint = new Map(result.rows.map(row => [row.mint, row]));
          job = jobs.create(result.deepScanPending, async mint => {
            const base = byMint.get(mint);
            const original = result[DISCOVERY_CONTEXT]?.get(mint);
            const candidate = original ? { ...original, now: clock() } : {
              mint,
              now: clock(),
              // Rekonstruksi konteks Jupiter dari baris awal supaya skor ulang
              // memakai komponen organic yang sama, bukan menghapusnya diam-diam.
              jupiter: base.organic ? {
                mint,
                symbol: base.symbol,
                organicScore: base.organic.score,
                organicLabel: base.organic.label,
                isVerified: base.organic.verified,
                tags: base.organic.tags ?? [],
                holderCount: base.safety.holderCount ?? base.organic.holderCount,
                liquidityUsd: base.organic.liquidityUsd,
                audit: { topHoldersPercentage: base.safety.top10Pct },
                stats: {}
              } : null,
              market: {
                pool: {
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
                }
              },
              safety: { status: 'unknown', security: null },
              structure: null,
              notionalUsd: ENTRY.notionalUsd
            };
            const enriched = await deep(candidate);
            const presetDef = getPreset(preset);
            const gates = evaluateGates(enriched, presetDef);
            const scoring = scoreCandidate(enriched, presetDef);
            const serialized = serializeCandidate({ ...enriched, gates, scoring }, presetDef);
            if (db.available && enriched.entryPlan) {
              db.recordPlan({ mint, createdAt: new Date(clock()).toISOString(), plan: enriched.entryPlan });
            }
            return {
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
                candles: enriched.structure.candles, dropped: enriched.structure.dropped ?? 0
              } : null,
              entryPlan: enriched.entryPlan,
              candleSource: enriched.candleSource ?? null
            };
          });
        }
        const response = { ...result, jobId: job?.id ?? null, jobTotal: job?.total ?? 0 };
        discoverCache.set(key, { at: Date.now(), data: response });
        if (discoverCache.size > 8) discoverCache.delete(discoverCache.keys().next().value);
        return send(200, response);
      }

      if (url.pathname.startsWith('/api/jobs/')) {
        const job = jobs.get(url.pathname.slice('/api/jobs/'.length));
        if (!job) return send(404, { error: 'Job tidak ditemukan atau sudah kedaluwarsa.' });
        return send(200, job);
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
          storage: { available: db.available, reason: db.reason }
        });
      }

      if (url.pathname === '/api/history') {
        const mint = url.searchParams.get('mint');
        if (!validMint(mint)) return send(400, { error: 'Mint tidak valid.' });
        if (!db.available) return send(503, { error: db.reason });
        return send(200, { mint, snapshots: db.snapshotHistory(mint, 50), plan: db.latestPlan(mint) });
      }

      if (url.pathname === '/api/scan') {
        const mint = url.searchParams.get('mint')?.trim();
        if (!validMint(mint)) return send(400, { error: 'Masukkan alamat mint Solana base58 yang terdekode menjadi 32 byte. Validasi format tidak membuktikan alamat merupakan akun mint.' });
        const hit = cache.get(mint);
        if (hit && Date.now() - hit.at < 30000) return send(200, { ...hit.data, cached: true });
        if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requests = 0; }
        if (!inFlight.has(mint)) {
          if (++requests > 40) return send(429, { error: 'Batas lokal 40 scan per menit tercapai. Tunggu satu menit.' });
          inFlight.set(mint, Promise.all([market(mint), risk(mint)]).then(async ([market, risk]) => {
            const historical = await history(mint, market.primary);
            const data = { mint, checkedAt: new Date().toISOString(), cached: false, market, risk, history: historical, entryContext: entryContext(market, risk, historical), disclaimer: 'Read-only. Bukan rekomendasi beli/jual. Data pihak ketiga dapat terlambat atau tidak lengkap. Tidak ada hasil yang menjamin token aman.' };
            if (cache.size >= 100) cache.delete(cache.keys().next().value);
            cache.set(mint, { at: Date.now(), data }); return data;
          }).finally(() => inFlight.delete(mint)));
        }
        return send(200, await inFlight.get(mint));
      }
      if (url.pathname === '/api/health') return send(200, { status: 'ok', mode: 'read-only', storage: db.available, configHash: CONFIG_HASH });
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
      const file = files[url.pathname];
      if (!file) return send(404, { error: 'Tidak ditemukan.' });
      return send(200, await readFile(new URL(`./public/${file[0]}`, import.meta.url), 'utf8'), file[1]);
    } catch (error) {
      sendJSON(res, headers, 500, { error: `Permintaan gagal: ${error?.message ?? 'kesalahan internal'}. Status keamanan yang tidak tersedia tetap unknown.` });
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`Solana scanner read-only: http://127.0.0.1:${port}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
