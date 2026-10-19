const $ = id => document.getElementById(id);
const usd = value => value === null || value === undefined ? 'unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...(value > 0 && value < 1 ? { maximumSignificantDigits: 8 } : { maximumFractionDigits: 2 }) }).format(value);
const compact = value => value === null || value === undefined ? 'unknown' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const num = value => value === null || value === undefined ? 'unknown' : new Intl.NumberFormat('en-US').format(value);
const percent = value => value === null || value === undefined ? 'unknown' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const pct = value => value === null || value === undefined ? 'unknown' : `${value.toFixed(1)}%`;
const age = hours => hours === null || hours === undefined ? 'unknown' : hours < 1 ? `${Math.round(hours * 60)} mnt` : hours < 48 ? `${hours.toFixed(1)} jam` : `${Math.round(hours / 24)} hari`;
const usd0 = value => value === null || value === undefined ? 'unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

/* Label manusiawi untuk kode gate; kode asli tetap ditampilkan agar bisa dicari. */
const GATE_LABELS = {
  excluded_mint: 'aset dasar dikecualikan', excluded_tag: 'tag stable/wrapped/major', market_missing: 'pool tidak ditemukan',
  liquidity_low: 'likuiditas di bawah ambang', volume_low: 'volume 24 jam rendah', pool_too_new: 'pool terlalu baru',
  price_change_24h_low: 'penurunan 24 jam terlalu tajam',
  turnover_low: 'turnover terlalu rendah', turnover_high: 'turnover ekstrem (curiga wash)', mcap_low: 'market cap rendah',
  fdv_ratio: 'FDV jauh di atas market cap', pump_24h: 'lonjakan 24 jam terlalu besar', holders_low: 'holder terlalu sedikit',
  concentration_high: 'konsentrasi top 10 tinggi', mintable: 'mint authority masih aktif', freezable: 'freeze authority masih aktif',
  transfer_fee: 'token punya transfer fee', transfer_hook: 'token punya transfer hook', non_transferable: 'token tidak dapat ditransfer',
  safety_unknown: 'keamanan belum terverifikasi', unverified: 'token belum terverifikasi', organic_low: 'organic score rendah'
};
const gateLabel = code => GATE_LABELS[code] ? `${GATE_LABELS[code]} (${code})` : code;
const gateShort = code => GATE_LABELS[code] ?? code;

function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function findings(container, items) {
  container.replaceChildren();
  for (const item of items) {
    const level = ['warning', 'unknown', 'info', 'warn', 'reject'].includes(item.level) ? item.level : (['warning', 'unknown', 'info'].includes(item.severity) ? item.severity : 'unknown');
    const box = node('div', undefined, `finding ${level === 'warn' ? 'warning' : level === 'reject' ? 'warning' : level}`);
    box.append(node('strong', `${item.level ?? item.severity ?? 'info'} · ${item.title ?? item.code ?? 'Temuan'}`), node('p', item.reason));
    container.append(box);
  }
  if (!items.length) container.append(node('p', 'Tidak ada temuan untuk ditampilkan. Ini bukan bukti aman.', 'hint'));
}

/* ---------------- tabs ---------------- */
let activeTab = 'discover';
function showTab(name) {
  activeTab = name;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${name}`;
  if (name === 'watchlist') loadWatchlist();
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));

/* ---------------- config ---------------- */
let CONFIG = null;
function presetSummary() {
  const hint = $('preset-hint');
  const preset = CONFIG?.presets?.[$('preset').value];
  if (!preset?.thresholds) { hint.textContent = ''; return; }
  const t = preset.thresholds;
  const parts = [
    `Likuiditas ≥ ${usd0(t.minLiquidityUsd)}`,
    `volume 24j ≥ ${usd0(t.minVolume24hUsd)}`,
    `usia pool ≥ ${age(t.minPoolAgeHours)}`,
    `holder ≥ ${num(t.minHolderCount)}`,
    `top 10 ≤ ${t.maxTop10Pct}%`,
    `FDV/MC ≤ ${t.maxFdvToMcap}×`,
    `turnover ≤ ${t.maxTurnover}×`,
    `perubahan 24j ${t.minPriceChange24hPct}% s.d. +${t.maxPriceChange24hPct}%`,
    t.requireVerified ? 'wajib verified' : null,
    t.allowUnknownSafety ? 'keamanan boleh unknown (grade dibatasi C)' : 'keamanan wajib diverifikasi GoPlus'
  ].filter(Boolean);
  hint.textContent = `${preset.label}: ${parts.join(' · ')}. Ambang likuiditas mengikuti preset, jadi skor token yang sama bisa berbeda antar-preset.`;
}
async function loadConfig() {
  try {
    CONFIG = await (await fetch('/api/config', { cache: 'no-store' })).json();
    const storage = CONFIG.storage?.available ? 'SQLite aktif' : `SQLite nonaktif: ${CONFIG.storage?.reason ?? 'unknown'}`;
    $('config-hint').textContent = `config ${CONFIG.configHash} · ${storage} · notional ${usd(CONFIG.entry?.notionalUsd)} · maks slippage ${CONFIG.entry?.maxSlippagePct}% · R:R minimum ${CONFIG.entry?.minRiskReward}`;
    presetSummary();
  } catch (error) {
    $('config-hint').textContent = `Konfigurasi tidak dapat dimuat: ${error.message}`;
  }
}
loadConfig();
$('preset').addEventListener('change', presetSummary);

/* ---------------- discover ---------------- */
let discoverData = null;
let jobTimer = null;
let jobGeneration = 0;
const openDetails = new Set();
function scoreBadge(score, grade) {
  const el = node('div', undefined, `score grade-${(grade || 'unknown').toLowerCase()}`);
  el.append(node('strong', score === null ? '—' : String(score)), node('span', grade ?? 'unknown'));
  return el;
}

function changeCell(value) {
  const el = node('td', percent(value));
  if (value !== null && value !== undefined) el.className = value > 0 ? 'up' : value < 0 ? 'down' : '';
  return el;
}

function renderCandidates(data) {
  const tbody = $('candidates');
  tbody.replaceChildren();
  if (!data.rows.length) {
    const row = node('tr'), cell = node('td', 'Tidak ada kandidat yang lolos gate pada preset ini. Longgarkan preset atau tunggu kondisi pasar berubah.');
    cell.colSpan = 13; row.append(cell); tbody.append(row);
    return;
  }
  for (const row of data.rows) {
    const tr = node('tr', undefined, 'candidate-row');
    tr.dataset.mint = row.mint;
    tr.append(node('td', String(row.rank)));
    const token = node('td', undefined, 'token-cell');
    token.append(node('strong', row.symbol ?? 'unknown'), node('small', row.mint));
    tr.append(token);
    const score = node('td'); score.append(scoreBadge(row.score, row.grade)); tr.append(score);
    tr.append(node('td', usd(row.market.priceUsd)));
    tr.append(changeCell(row.market.change?.h1));
    tr.append(changeCell(row.market.change?.h24));
    tr.append(node('td', usd(row.market.liquidityUsd)));
    tr.append(node('td', row.market.turnover === null ? 'unknown' : `${row.market.turnover.toFixed(2)}×`));
    tr.append(node('td', compact(row.market.marketCap)));
    tr.append(node('td', pct(row.safety.top10Pct)));
    tr.append(node('td', age(row.market.ageHours)));
    const setup = node('td');
    if (row.disqualified?.length) {
      setup.append(node('span', `gugur: ${gateShort(row.disqualified[0].code)}`, 'chip chip-bad'));
      tr.classList.add('disqualified');
    } else {
      const state = row.entryPlan?.setup ?? row.structure?.trend ?? 'pending';
      setup.append(node('span', state, `chip ${row.entryPlan?.status === 'plan' ? 'chip-ok' : 'chip-muted'}`));
    }
    tr.append(setup);
    const action = node('td');
    const detailButton = node('button', 'Rincian', 'text-button');
    detailButton.type = 'button';
    detailButton.addEventListener('click', event => { event.stopPropagation(); toggleDetail(tr, row); });
    action.append(detailButton);
    tr.append(action);
    tbody.append(tr);
    if (openDetails.has(row.mint)) toggleDetail(tr, row, true);
  }
}

function toggleDetail(tr, row, restore = false) {
  const next = tr.nextElementSibling;
  if (!restore && next?.classList.contains('detail-row')) { next.remove(); openDetails.delete(row.mint); return; }
  openDetails.add(row.mint);
  const detail = node('tr', undefined, 'detail-row');
  const cell = node('td');
  cell.colSpan = 13;

  const grid = node('div', undefined, 'detail-grid');
  const components = node('div');
  components.append(node('h4', 'Komponen skor'));
  for (const item of row.components) {
    const line = node('div', undefined, 'component');
    line.append(node('span', item.label));
    const bar = node('div', undefined, 'bar');
    const fill = node('i');
    fill.style.width = `${item.score ?? 0}%`;
    fill.className = item.score === null ? 'missing' : item.score >= 70 ? 'good' : item.score >= 45 ? 'mid' : 'bad';
    bar.append(fill);
    line.append(bar, node('strong', item.score === null ? 'n/a' : String(item.score)));
    components.append(line);
  }
  if (row.penalties.length) {
    components.append(node('h4', 'Penalti'));
    for (const penalty of row.penalties) components.append(node('p', `−${penalty.points} · ${penalty.reason}`, 'hint'));
  }

  const evidence = node('div');
  evidence.append(node('h4', 'Bukti per metrik'));
  const table = node('table', undefined, 'evidence');
  const thead = node('thead');
  const hr = node('tr');
  for (const label of ['Metrik', 'Nilai', 'Sumber']) hr.append(node('th', label));
  thead.append(hr); table.append(thead);
  const tb = node('tbody');
  for (const item of row.components.flatMap(component => component.evidence)) {
    const r = node('tr');
    r.append(node('td', item.metric), node('td', String(item.value)), node('td', item.source ?? 'unknown'));
    tb.append(r);
  }
  table.append(tb);
  evidence.append(table);

  const plan = node('div');
  plan.append(node('h4', 'Rencana entry 1 jam'));
  if (row.disqualified?.length) {
    plan.append(node('p', 'Deep scan menemukan pelanggaran gate yang tidak terlihat saat ranking awal:', 'hint'));
    for (const item of row.disqualified) plan.append(node('p', `${gateLabel(item.code)}: ${item.reason}`, 'hint'));
  }
  if (row.disqualified?.length) {
    plan.append(node('p', 'Rencana entry dinonaktifkan karena kandidat gugur gate.', 'hint'));
  } else if (row.entryPlan?.status === 'plan') {
    const p = row.entryPlan;
    const values = [
      ['Setup', p.setup], ['Zona entry', `${usd(p.entryLow)} – ${usd(p.entryHigh)}`], ['Invalidasi', usd(p.invalidation)],
      ['Target 1 / 2 / 3', p.targets.map(usd).join(' / ')], ['R:R', `${p.riskReward} (min ${p.minRiskReward})`],
      ['Risiko ke invalidasi', `${p.riskPct}%`], ['Ukuran posisi paper', usd(p.positionUsd)], ['Estimasi slippage', p.slippagePct === null ? 'unknown' : `${p.slippagePct.toFixed(2)}%`]
    ];
    for (const [label, value] of values) {
      const line = node('div', undefined, 'kv');
      line.append(node('span', label), node('strong', String(value)));
      plan.append(line);
    }
  } else {
    plan.append(node('p', row.entryPlan?.reason ?? 'Rencana entry belum dibuat (deep scan belum selesai).', 'hint'));
  }
  plan.append(node('p', 'Rencana adalah skenario, bukan perintah. Invalidasi bukan stop-order otomatis.', 'hint'));

  const actions = node('div', undefined, 'detail-actions');
  const watchButton = node('button', '+ Watchlist', 'text-button');
  watchButton.type = 'button';
  watchButton.addEventListener('click', async () => {
    await saveWatch(watchButton, row.mint, { symbol: row.symbol, score: row.score, grade: row.grade, price: row.market.priceUsd });
  });
  const inspectButton = node('button', 'Buka di Inspect', 'text-button');
  inspectButton.type = 'button';
  inspectButton.addEventListener('click', () => { $('mint').value = row.mint; showTab('inspect'); $('scan-form').requestSubmit(); });
  actions.append(watchButton, inspectButton);

  grid.append(components, evidence, plan);
  cell.append(grid, actions);
  detail.append(cell);
  tr.after(detail);
}

function renderDiscover(data) {
  discoverData = data;
  $('discover-results').hidden = false;
  $('discover-meta').textContent = `${data.preset.label} · config ${data.configHash}`;
  const values = [
    ['Universe', `${data.universe.total} token`], ['Dievaluasi (punya pool)', String(data.universe.evaluated ?? data.universe.checked)],
    ['Lolos gate', String(data.universe.accepted)], ['Digugurkan', String(data.universe.rejected)],
    ['Kandidat tampil', String(data.rows.length)], ['Deep scan', data.jobTotal ? `${data.jobTotal} token` : 'tidak ada']
  ];
  $('discover-summary').replaceChildren(...values.map(([label, value]) => { const el = node('div', undefined, 'metric'); el.append(node('p', label), node('strong', value)); return el; }));
  findings($('discover-warnings'), data.warnings.map(reason => ({ level: 'unknown', title: 'Sumber data', reason })));

  renderCandidates(data);

  $('rejected-count').textContent = `${data.universe.rejected} ditolak`;
  const rejected = $('rejected');
  rejected.replaceChildren();
  if (!data.rejected.length) rejected.append(node('p', 'Tidak ada kandidat yang digugurkan pada daftar ini.', 'hint'));
  for (const item of data.rejected) {
    const box = node('div', undefined, 'finding warning');
    box.append(node('strong', `${item.symbol ?? item.mint.slice(0, 8)} · ${item.rejections.length} gate`));
    const list = node('ul');
    for (const rejection of item.rejections) list.append(node('li', `${gateLabel(rejection.code)}: ${rejection.reason}`));
    box.append(list);
    rejected.append(box);
  }

  $('deep-status').textContent = data.jobId ? `deep scan: 0/${data.jobTotal}` : 'deep scan: tidak ada';
  if (data.jobId) pollJob(data.jobId, data.jobTotal);
}

function pollJob(jobId, total) {
  clearTimeout(jobTimer);
  const generation = ++jobGeneration;
  const deadline = Date.now() + 90_000;
  const tick = async () => {
    let job;
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
      job = await response.json();
      if (!response.ok || job.error) throw new Error(job.error || `HTTP ${response.status}`);
    } catch (error) {
      if (generation !== jobGeneration) return;
      $('deep-status').textContent = `deep scan tertunda: ${error.message}. Hasil awal belum final.`;
      if (Date.now() < deadline) jobTimer = setTimeout(tick, 2000);
      return;
    }
    if (generation !== jobGeneration || !discoverData) return;
    $('deep-status').textContent = `deep scan: ${job.completed}/${total}${job.failures ? ` · ${job.failures} gagal` : ''}`;
    for (const result of job.results) {
      if (!result.ok || !discoverData) continue;
      const row = discoverData.rows.find(item => item.mint === result.mint);
      if (!row) continue;
      row.score = result.result.score;
      row.grade = result.result.grade;
      row.confidence = result.result.confidence;
      row.components = result.result.components;
      row.penalties = result.result.penalties;
      row.safety = result.result.safety;
      row.structure = result.result.structure;
      row.entryPlan = result.result.entryPlan;
      row.disqualified = result.result.disqualified ?? null;
    }
    // Perbarui seluruh bukti, setup, dan status gugur pada setiap progres;
    // kandidat gugur tidak boleh dipromosikan oleh skor tingginya.
    discoverData.rows.sort((a, b) => Number(Boolean(a.disqualified?.length)) - Number(Boolean(b.disqualified?.length)) || (b.score ?? -1) - (a.score ?? -1));
    discoverData.rows.forEach((row, index) => { row.rank = index + 1; });
    renderCandidates(discoverData);
    if (job.status === 'done') {
      $('discover-status').textContent = `Deep scan selesai · ${discoverData.rows.filter(row => !row.disqualified?.length).length} kandidat tampil masih lolos gate · ${job.failures || 0} gagal dianalisis.`;
    } else if (Date.now() < deadline) {
      jobTimer = setTimeout(tick, 2000);
    } else {
      $('deep-status').textContent += ' · batas waktu; hasil belum final, jalankan Discover lagi.';
    }
  };
  jobTimer = setTimeout(tick, 2000);
}

$('discover-button').addEventListener('click', async () => {
  const preset = $('preset').value;
  clearTimeout(jobTimer);
  jobGeneration++;
  discoverData = null;
  openDetails.clear();
  $('discover-button').disabled = true;
  $('discover-results').hidden = true;
  $('discover-status').className = '';
  $('discover-status').textContent = 'Mengambil universe, menyaring gate, dan memeringkat kandidat… Deep scan shortlist berjalan setelah hasil awal.';
  try {
    const response = await fetch(`/api/discover?preset=${encodeURIComponent(preset)}`, { signal: AbortSignal.timeout(90000), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderDiscover(data);
    $('discover-status').textContent = `Selesai · ${data.universe.accepted} lolos gate dari ${data.universe.evaluated ?? data.universe.checked} dievaluasi · ${data.rows.length} kandidat tampil${data.jobId ? ' · deep scan berjalan' : ''}.`;
  } catch (error) {
    $('discover-status').className = 'error';
    $('discover-status').textContent = `Discover gagal: ${error.name === 'TimeoutError' ? 'batas waktu tercapai' : error.message}. Tidak ada hasil lama yang ditampilkan.`;
  } finally { $('discover-button').disabled = false; }
});

/* ---------------- inspect ---------------- */
let displayedHistory = null;
let currentMint = null;

function freshness() {
  const h = displayedHistory;
  if (!h) return;
  const ageSeconds = h.lastClosedAt ? (Date.now() - Date.parse(h.lastClosedAt)) / 1000 : null;
  const stale = ageSeconds !== null && ageSeconds > 1800;
  $('history-freshness').textContent = ageSeconds === null ? 'Waktu candle terakhir unknown; tidak ada watch yang dapat dinilai.' : `Candle terakhir tutup ${new Date(h.lastClosedAt).toLocaleString('id-ID')} · umur penutupan ${Math.max(0, Math.floor(ageSeconds / 60))} menit. ${stale ? 'Data melewati 30 menit: abaikan kondisi watch lama, scan ulang manual.' : 'Bukan harga live; scan ulang untuk memperbarui.'}`;
  $('history-freshness').className = stale ? 'error' : 'hint';
  $('watch-title').textContent = stale ? 'Watch kedaluwarsa — scan ulang' : (h.watch?.title || 'Watch unknown');
}
setInterval(freshness, 15000);

function renderHistory(data) {
  const h = data.history, m = h.metrics || {};
  displayedHistory = h;
  $('watch-reason').textContent = h.watch?.reason || h.reason;
  $('watch-invalidation').textContent = `Kondisi gugur / batas: ${h.watch?.invalidation || 'Tidak ada watch aktif.'}`;
  $('entry-note').textContent = data.entryContext.reason;
  findings($('entry-cautions'), data.entryContext.cautions.map(reason => ({ level: 'warning', title: 'Batas penilaian entry', reason })));
  findings($('setup-flags'), (h.flags || []).map(flag => ({ level: flag.severity === 'warn' ? 'warning' : flag.severity, title: flag.code, reason: flag.reason })));
  $('history-status').textContent = `historis: ${h.status}`;
  $('history-source').textContent = `${h.source} · pool ${h.poolAddress || 'unknown'} · token diminta ${data.mint} · USD · ${h.timeframe}. ${h.fetchedAt ? `Diambil ${new Date(h.fetchedAt).toLocaleString('id-ID')}${h.historyCached ? ' (cache lokal ≤ 60 detik)' : ''}.` : 'Belum ada respons candle terverifikasi.'} Cache provider 60 detik. ${h.reason || ''}${h.droppedRows ? ` ${h.droppedRows} baris rusak dibuang.` : ''}`;
  const values = [
    ['Close 15m (bukan harga live)', usd(m.closeUsd)], ['SMA20 close (5 jam)', usd(m.sma20Usd)],
    ['Resistance 20 candle sebelumnya', usd(m.previousHighUsd)], ['Support 20 candle sebelumnya', usd(m.previousLowUsd)],
    ['Volume relatif vs 20 sebelumnya', m.relativeVolume == null ? 'unknown' : `${m.relativeVolume.toFixed(2)}×`],
    ['Jarak di bawah resistance', percent(m.distanceToResistancePct)], ['Deviasi di atas SMA20', percent(m.extensionPct)],
    ['Perubahan close ±5 jam', percent(m.change5hPct)]
  ];
  $('history-metrics').replaceChildren(...values.map(([label, value]) => { const el = node('div', undefined, 'metric'); el.append(node('p', label), node('strong', value)); return el; }));
  findings($('history-signals'), h.signals || []);
  $('candles').replaceChildren();
  for (const candle of (h.candles || []).slice(-8).reverse()) {
    const row = node('tr');
    row.append(node('td', new Date((candle.time + 900) * 1000).toLocaleString('id-ID')), node('td', usd(candle.close)), node('td', usd(candle.volume)));
    $('candles').append(row);
  }
  if (!(h.candles || []).length) { const row = node('tr'), cell = node('td', 'Candle tertutup tidak tersedia.'); cell.colSpan = 3; row.append(cell); $('candles').append(row); }
  freshness();
}

function render(data) {
  const market = data.market, risk = data.risk, primary = market.primary;
  currentMint = data.mint;
  $('add-watch').textContent = '+ Tambah ke watchlist';
  $('add-watch').disabled = false;
  $('token-name').textContent = primary ? `${primary.tokenName || 'Token'}${primary.tokenSymbol ? ` / ${primary.tokenSymbol}` : ''}` : 'Token belum teridentifikasi';
  $('token-mint').textContent = data.mint;
  $('timestamp').textContent = `Snapshot diterima ${new Date(data.checkedAt).toLocaleString('id-ID')} · ${data.cached ? 'cache ≤ 30 detik' : 'scan baru'}`;
  $('market-status').textContent = `pasar: ${market.status}`;
  renderHistory(data);
  const metrics = [
    ['Harga mint', usd(primary?.priceUsd)], ['Likuiditas pool utama', usd(primary?.liquidityUsd)],
    ['Volume pool 24 jam', usd(primary?.volume24h)], ['Perubahan harga 24 jam', percent(primary?.change24h)],
    ['Market cap (sumber)', usd(primary?.marketCap)], ['FDV (bukan market cap)', usd(primary?.fdv)],
    ['Buy / sell pool 24 jam', `${num(primary?.buys24h)} / ${num(primary?.sells24h)}`],
    ['Usia pool, bukan token', primary?.ageHours === null || primary?.ageHours === undefined ? 'unknown' : `${primary.ageHours.toFixed(1)} jam`]
  ];
  $('metrics').replaceChildren(...metrics.map(([label, value]) => { const el = node('div', undefined, 'metric'); el.append(node('p', label), node('strong', value)); return el; }));
  $('market-note').textContent = `${market.reason} ${market.fetchedAt ? `Diambil: ${new Date(market.fetchedAt).toLocaleString('id-ID')}.` : ''}`;
  $('risk-status').textContent = risk.status;
  $('risk-reason').textContent = risk.reason;
  findings($('risk-findings'), risk.findings || []);
  findings($('signals'), market.signals?.length ? market.signals : [{ level: 'unknown', title: 'Sinyal pasar belum tersedia', reason: market.reason }]);
  $('pool-count').textContent = `${market.pairs.length} pool`;
  $('pools').replaceChildren();
  for (const pool of market.pairs) {
    const row = node('tr');
    const label = node('td', `${pool.base} / ${pool.quote} · ${pool.dex}`);
    label.append(node('small', pool.address || 'alamat pool unknown'));
    row.append(label, node('td', pool.targetIsBase ? 'base' : 'quote'), node('td', usd(pool.priceUsd)), node('td', usd(pool.liquidityUsd)), node('td', usd(pool.volume24h)));
    $('pools').append(row);
  }
  if (!market.pairs.length) { const row = node('tr'), cell = node('td', 'Tidak ada pool untuk ditampilkan. Ini bukan bukti token aman.'); cell.colSpan = 5; row.append(cell); $('pools').append(row); }
  $('raw').textContent = JSON.stringify(data, null, 2);
  $('results').hidden = false;
}

$('example').addEventListener('click', () => { $('mint').value = 'So11111111111111111111111111111111111111112'; $('mint').focus(); });
$('scan-form').addEventListener('submit', async event => {
  event.preventDefault();
  const mint = $('mint').value.trim();
  $('status').className = '';
  $('status').textContent = 'Memeriksa sumber data… Tidak ada transaksi yang dikirim.';
  displayedHistory = null;
  $('results').hidden = true;
  $('scan-button').disabled = true; $('example').disabled = true; $('mint').disabled = true;
  try {
    const response = await fetch(`/api/scan?mint=${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    render(data);
    $('status').textContent = `Selesai · pasar ${data.market.status} · historis ${data.history.status} · keamanan ${data.risk.status}. Watch bukan keputusan buy; baca alasan dan batas datanya.`;
  } catch (error) {
    $('status').className = 'error';
    $('status').textContent = `Tidak dapat menyelesaikan scan: ${error.name === 'TimeoutError' ? 'batas waktu permintaan tercapai' : error.message}. Hasil sebelumnya disembunyikan.`;
  } finally { $('scan-button').disabled = false; $('example').disabled = false; $('mint').disabled = false; }
});

async function saveWatch(button, mint, snapshot) {
  button.disabled = true;
  try {
    const response = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mint, snapshot }), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    button.textContent = 'Tersimpan ✓';
  } catch (error) {
    button.textContent = `Gagal menyimpan: ${error.message}`;
  } finally { button.disabled = false; }
}

$('add-watch').addEventListener('click', async () => {
  if (!currentMint) return;
  const mint = currentMint;
  const data = JSON.parse($('raw').textContent);
  await saveWatch($('add-watch'), mint, { symbol: data.market.primary?.tokenSymbol, price: data.market.primary?.priceUsd, at: data.checkedAt });
});

/* ---------------- watchlist ---------------- */
let watchGeneration = 0;
async function loadWatchlist() {
  const generation = ++watchGeneration;
  $('watch-status').className = '';
  $('watch-status').textContent = 'Memuat watchlist…';
  $('watch-items').replaceChildren();
  $('watch-runs').replaceChildren();
  try {
    const response = await fetch('/api/watchlist', { signal: AbortSignal.timeout(10000), cache: 'no-store' });
    const data = await response.json();
    if (generation !== watchGeneration) return;
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    $('watch-status').textContent = data.items.length ? `${data.items.length} token dipantau.` : 'Watchlist kosong. Tambahkan dari Discover atau Inspect.';
    const items = $('watch-items');
    items.replaceChildren();
    for (const item of data.items) {
      const box = node('div', undefined, 'watch-item');
      const head = node('div', undefined, 'section-head');
      head.append(node('strong', item.snapshot?.symbol ? `${item.snapshot.symbol} · ${item.mint.slice(0, 8)}…` : item.mint), node('span', item.addedAt, 'hint'));
      const actions = node('div', undefined, 'detail-actions');
      const inspect = node('button', 'Inspect', 'text-button');
      inspect.type = 'button';
      inspect.addEventListener('click', () => { $('mint').value = item.mint; showTab('inspect'); $('scan-form').requestSubmit(); });
      const remove = node('button', 'Hapus', 'text-button');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          const response = await fetch(`/api/watchlist/${encodeURIComponent(item.mint)}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
          if (!response.ok) { const result = await response.json(); throw new Error(result.error || `HTTP ${response.status}`); }
          await loadWatchlist();
        } catch (error) {
          $('watch-status').className = 'error';
          $('watch-status').textContent = `Gagal menghapus: ${error.message}`;
        } finally { remove.disabled = false; }
      });
      actions.append(inspect, remove);
      box.append(head, node('p', `skor ${item.snapshot?.score ?? 'unknown'} · grade ${item.snapshot?.grade ?? 'unknown'} · harga ${usd(item.snapshot?.price)}`, 'hint'), actions);
      items.append(box);
    }
    if (!data.items.length) items.append(node('p', 'Belum ada token disimpan.', 'hint'));

    const runs = $('watch-runs');
    runs.replaceChildren();
    for (const run of data.history) {
      const line = node('div', undefined, 'kv');
      line.append(node('span', `${new Date(run.startedAt).toLocaleString('id-ID')} · ${run.preset} · config ${run.configHash}`), node('strong', `${run.accepted}/${run.candidates} lolos`));
      runs.append(line);
    }
    if (!data.history.length) runs.append(node('p', 'Belum ada run discovery tersimpan.', 'hint'));
  } catch (error) {
    if (generation !== watchGeneration) return;
    $('watch-status').className = 'error';
    $('watch-status').textContent = `Watchlist tidak dapat dimuat: ${error.message}`;
  }
}
$('watch-refresh').addEventListener('click', loadWatchlist);
