const $ = id => document.getElementById(id);
const usd = value => value === null || value === undefined ? 'unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...(value > 0 && value < 1 ? { maximumSignificantDigits: 8 } : { maximumFractionDigits: 2 }) }).format(value);
const compact = value => value === null || value === undefined ? 'unknown' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const num = value => value === null || value === undefined ? 'unknown' : new Intl.NumberFormat('en-US').format(value);
const percent = value => value === null || value === undefined ? 'unknown' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const pct = value => value === null || value === undefined ? 'unknown' : `${value.toFixed(1)}%`;
const age = hours => hours === null || hours === undefined ? 'unknown' : hours < 1 ? `${Math.round(hours * 60)} mnt` : hours < 48 ? `${hours.toFixed(1)} jam` : `${Math.round(hours / 24)} hari`;
const usd0 = value => value === null || value === undefined ? 'unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const usdCompact = value => value === null || value === undefined ? 'unknown' : `${value < 0 ? '-' : ''}$${compact(Math.abs(value))}`;

/* Alamat mint 44 karakter memakan lebar kolom; yang ditampilkan cukup
   untuk dikenali, sementara nilai penuh tetap disalin dan disimpan di
   judul elemen. */
const shortMint = mint => (!mint || mint.length <= 18) ? mint : `${mint.slice(0, 11)}…${mint.slice(-5)}`;

/* Label manusiawi untuk kode gate; kode asli tetap ditampilkan agar bisa dicari. */
const GATE_LABELS = {
  excluded_mint: 'aset dasar dikecualikan', excluded_tag: 'tag stable/wrapped/major', market_missing: 'pool tidak ditemukan',
  liquidity_low: 'likuiditas di bawah ambang', volume_low: 'volume 24 jam rendah', pool_too_new: 'pool terlalu baru',
  price_change_24h_low: 'penurunan 24 jam terlalu tajam',
  turnover_low: 'turnover terlalu rendah', turnover_high: 'turnover ekstrem (curiga wash)', mcap_low: 'market cap rendah', mcap_high: 'market cap di atas batas preset', mcap_unknown: 'market cap tidak diketahui',
  rug_pattern: 'pola rug pada distribusi holder',
  fdv_ratio: 'FDV jauh di atas market cap', pump_24h: 'lonjakan 24 jam terlalu besar', holders_low: 'holder terlalu sedikit',
  concentration_high: 'konsentrasi top 10 tinggi', mintable: 'mint authority masih aktif', freezable: 'freeze authority masih aktif',
  transfer_fee: 'token punya transfer fee', transfer_hook: 'token punya transfer hook', non_transferable: 'token tidak dapat ditransfer',
  safety_unknown: 'keamanan belum terverifikasi', unverified: 'token belum diverifikasi', organic_low: 'organic score rendah'
};
const gateLabel = code => GATE_LABELS[code] ? `${GATE_LABELS[code]} (${code})` : code;
const gateShort = code => GATE_LABELS[code] ?? code;

function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }

/* Nilai yang tidak diketahui harus terlihat sebagai tidak diketahui, bukan sebagai nol. */
const isBlank = value => value === null || value === undefined;
const blankClass = value => (isBlank(value) ? 'val-unknown' : '');

/* Label kolom kandidat. Dipakai untuk header tabel dan untuk layout bertumpuk di layar kecil. */
const CANDIDATE_COLS = ['#', 'Token', 'Skor', 'Harga', '1j', '24j', 'Likuiditas', 'Turnover', 'MCap', 'Top10', 'Umur pool', 'Setup', ''];

/** Salin teks ke clipboard: Clipboard API bila ada, fallback textarea. */
async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* coba fallback di bawah */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body?.append?.(area);
    area.select?.();
    const ok = document.execCommand?.('copy');
    area.remove?.();
    return Boolean(ok);
  } catch { return false; }
}

/** Jadikan elemen bisa diklik untuk menyalin; beri umpan balik "Tersalin". */
function enableCopy(el, getText) {
  if (!el) return;
  el.classList.add('copy-mint');
  const full = typeof getText === 'function' ? getText() : getText;
  el.title = full ? `${full} · klik untuk menyalin` : 'Klik untuk salin alamat mint';
  el.addEventListener('click', async event => {
    event?.stopPropagation?.();
    const text = typeof getText === 'function' ? getText() : getText;
    if (!text) return;
    const restore = el.textContent;
    el.textContent = 'Tersalin ✓';
    await copyText(text);
    setTimeout(() => { el.textContent = restore; }, 1200);
  });
}
function findings(container, items) {
  container.replaceChildren();
  for (const item of items) {
    const level = ['warning', 'unknown', 'info', 'warn', 'reject'].includes(item.level) ? item.level : (['warning', 'unknown', 'info'].includes(item.severity) ? item.severity : 'unknown');
    const box = node('div', undefined, `finding ${level === 'warn' ? 'warning' : level === 'reject' ? 'reject' : level}`);
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
    // Roving tabindex: hanya tab aktif yang bisa difokuskan lewat Tab.
    tab.setAttribute('tabindex', on ? '0' : '-1');
  }
  for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${name}`;
  if (name === 'watchlist') loadWatchlist();
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('.tab')];
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    let next = null;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    showTab(next.dataset.tab);
    if (typeof next.focus === 'function') next.focus();
  });
}

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
    t.maxMarketCapUsd ? `market cap ≤ ${usd0(t.maxMarketCapUsd)}` : null,
    t.requireVerified ? 'wajib verified' : null,
    t.requireKnownMarketCap ? 'market cap wajib diketahui' : null,
    t.rugTop10Pct !== null && t.rugTop10Pct !== undefined ? `pola rug top 10 > ${t.rugTop10Pct}% tanpa info LP` : null,
    t.allowUnknownSafety ? 'keamanan boleh unknown (grade dibatasi C)' : 'keamanan wajib diverifikasi GoPlus'
  ].filter(Boolean);
  // Bobot skor berbeda per preset: skor 70 di Conservative dan Gem hunter
  // mengukur hal yang berbeda, jadi bobotnya harus terlihat.
  const w = preset.weights;
  const weightNote = w
    ? ` Bobot skor: keamanan ${w.safety}, likuiditas ${w.liquidity}, momentum ${w.momentum}, struktur ${w.structure}, organic ${w.organic}, upside ${w.upside}.`
    : '';
  hint.textContent = `${preset.label}: ${parts.join(' · ')}. Ambang dan bobot mengikuti preset, jadi skor token yang sama bisa berbeda antar-preset.${weightNote}`;
}

/** Tabel perbandingan ambang antar preset: angka yang biasanya dibandingkan manual. */
function renderPresetCompare() {
  const body = $('preset-rows');
  if (!body || !CONFIG?.presets) return;
  body.replaceChildren();
  for (const [key, preset] of Object.entries(CONFIG.presets)) {
    const t = preset.thresholds || {};
    const tr = node('tr');
    const name = node('td', preset.label, key === $('preset').value ? 'chip chip-ok' : '');
    const mcap = [t.minMarketCapUsd ? usd0(t.minMarketCapUsd) : 'unknown', t.maxMarketCapUsd ? usd0(t.maxMarketCapUsd) : '—'].join(' – ');
    const values = [
      usd0(t.minLiquidityUsd), usd0(t.minVolume24hUsd), age(t.minPoolAgeHours), num(t.minHolderCount),
      `${t.maxTop10Pct}%`, mcap, `${t.maxFdvToMcap}×`, `${t.maxTurnover}×`,
      t.requireVerified ? 'wajib' : (t.allowUnknownSafety ? 'boleh unknown' : 'wajib')
    ];
    tr.append(name);
    values.forEach(value => tr.append(node('td', String(value), 'num')));
    body.append(tr);
  }
}

/** Label preset aktif: dari konfigurasi server, atau nama key sebagai cadangan. */
function presetLabel() {
  const value = $('preset')?.value;
  return CONFIG?.presets?.[value]?.label ?? value ?? 'unknown';
}

async function loadConfig() {
  try {
    CONFIG = await (await fetch('/api/config', { cache: 'no-store' })).json();
    const storage = CONFIG.storage?.available ? 'SQLite aktif' : `SQLite nonaktif: ${CONFIG.storage?.reason ?? 'unknown'}`;
    $('config-hint').textContent = `config ${CONFIG.configHash} · ${storage} · notional ${usd(CONFIG.entry?.notionalUsd)} · maks slippage ${CONFIG.entry?.maxSlippagePct}% · R:R minimum ${CONFIG.entry?.minRiskReward}`;
    $('tel-config').textContent = CONFIG.configHash ?? 'unknown';
    $('tel-preset').textContent = presetLabel();
    $('tel-watch-store').textContent = CONFIG.storage?.available ? 'SQLite lokal' : (CONFIG.storage?.reason ?? 'unknown');
    presetSummary();
    renderPresetCompare();
  } catch (error) {
    $('config-hint').textContent = `Konfigurasi tidak dapat dimuat: ${error.message}`;
  }
}
loadConfig();
$('preset').addEventListener('change', () => {
  presetSummary();
  renderPresetCompare();
  $('tel-preset').textContent = presetLabel();
});

/* ---------------- discover ---------------- */
let discoverData = null;
let jobTimer = null;
let jobGeneration = 0;
const openDetails = new Set();
let candidatesSignature = '';

const GRADE_TICKS = [45, 60, 75];

/**
 * Gauge skor. Isi penuh = skor. Pita bergaris = rentang yang belum
 * terukur: bila bobot yang belum dianalisis bernilai 0, skor bisa jatuh
 * ke titik paling kiri; bila bernilai 100, ke paling kanan. Garis tegak
 * menandai perkiraan titik skornya. Jadi skor dari 75% bobot terlihat
 * berbeda dari skor dari 100% bobot, bukan hanya berbeda di catatan.
 */
function scoreGauge(score, grade, confidence, large) {
  const el = node('div', undefined, `gauge ${large ? 'gauge-lg ' : ''}grade-${(grade || 'unknown').toLowerCase()}`);
  const hasScore = typeof score === 'number' && Number.isFinite(score);
  const bounded = hasScore ? Math.max(0, Math.min(100, score)) : 0;
  const hasConfidence = typeof confidence === 'number' && Number.isFinite(confidence);
  const measured = hasConfidence ? Math.max(0, Math.min(1, confidence)) : null;
  const floor = measured === null ? bounded : bounded * measured;
  const ceiling = measured === null ? bounded : bounded * measured + (1 - measured) * 100;

  const value = node('div', hasScore ? String(score) : '—', 'gauge-value');
  const track = node('div', undefined, 'gauge-track');
  const solid = node('i', undefined, 'gauge-solid');
  solid.style.width = `${floor}%`;
  track.append(solid);
  if (measured !== null && measured < 1) {
    const band = node('i', undefined, 'gauge-band');
    band.style.left = `${floor}%`;
    band.style.width = `${Math.max(0, ceiling - floor)}%`;
    track.append(band);
  }
  if (hasScore) {
    const mark = node('i', undefined, 'gauge-mark');
    mark.style.left = `${bounded}%`;
    track.append(mark);
  }
  // Tick grade hanya digambar di gauge besar: di kolom tabel tiga tick
  // terlalu rapat dan hanya jadi noise.
  if (large) {
    for (const tick of GRADE_TICKS) {
      const mark = node('i', undefined, 'gauge-tick');
      mark.style.left = `${tick}%`;
      track.append(mark);
    }
  }
  const letter = node('div', grade ?? 'unknown', 'gauge-grade');
  el.append(value, track, letter);
  el.title = hasScore
    ? `Skor ${score}. Grade ${grade ?? 'unknown'}.${measured === null ? ' Porsi bobot terukur tidak diketahui.' : measured >= 1 ? ' Seluruh bobot terukur.' : ` Bobot terukur ${Math.round(measured * 100)}%, rentang mungkin ${Math.round(floor)}–${Math.round(ceiling)}.`}`
    : 'Skor belum dihitung.';
  return el;
}

/** Rentang skor yang mungkin, untuk dibaca di rincian kandidat. */
function scoreRange(score, confidence) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'Skor belum dihitung.';
  const grade = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : 'D';
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return `Skor ${score} · porsi bobot terukur tidak diketahui, jadi rentang skornya tidak bisa dihitung · grade ${grade}.`;
  const measured = Math.max(0, Math.min(1, confidence));
  if (measured >= 1) return `Skor ${score} · seluruh bobot terukur, jadi skor ini final · grade ${grade}.`;
  const floor = score * measured;
  const ceiling = score * measured + (1 - measured) * 100;
  return `Skor ${score} · bobot terukur ${Math.round(measured * 100)}% · rentang mungkin ${Math.round(floor)}–${Math.round(ceiling)} · grade ${grade}.`;
}

/** Chip status: penanda bentuk + teks, bukan warna saja. */
function statusChip(text, className, title) {
  const chip = node('span', undefined, `chip ${className}`);
  const label = node('span', text);
  chip.append(label);
  if (title) chip.title = title;
  return chip;
}

function changeCell(value, label) {
  const cls = isBlank(value) ? 'num val-unknown' : `num ${value > 0 ? 'up' : value < 0 ? 'down' : ''}`;
  const el = node('td', percent(value), cls);
  el.dataset.label = label;
  return el;
}

/** Umur sebuah timestamp: berapa lama angka itu sudah ada di layar. */
function ageOf(timestamp) {
  if (!timestamp) return 'unknown';
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 'unknown';
  const seconds = Math.max(0, (Date.now() - parsed) / 1000);
  if (seconds < 90) return `${Math.round(seconds)} detik lalu`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} menit lalu`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} jam lalu`;
  return `${Math.round(seconds / 86400)} hari lalu`;
}

/**
 * Panel usia data: setiap angka di tampilan punya waktu pengambilan, dan
 * waktu itu harus terlihat. Angka tanpa waktu tidak boleh dibaca sebagai
 * harga terkini.
 */
function freshnessPanel(row) {
  const box = node('div', undefined, 'detail-freshness');
  const add = (label, value) => {
    const line = node('div', undefined, 'kv');
    line.append(node('span', label), node('strong', value));
    box.append(line);
  };
  add('Data pasar diambil', row.market?.fetchedAt ? `${ageOf(row.market.fetchedAt)} (${new Date(row.market.fetchedAt).toLocaleString('id-ID')})` : 'unknown');
  add('Sumber data pasar', row.market?.source ?? 'unknown');
  if (row.market?.targetIsBase === false) add('Orientasi pool', 'mint adalah token QUOTE: harga dan valuasi milik token base, jadi tidak ditampilkan');
  if (row.poolCheck) {
    add('Pemeriksaan ulang pool', row.poolCheck.replaced
      ? `Pool diganti dengan pool utama provider (${row.poolCheck.reason ?? 'pool lain lebih likuid'})`
      : row.poolCheck.reason ?? 'Pool utama provider sama dengan pool pada ranking');
  }
  add('Data keamanan diambil', row.safety?.fetchedAt ? ageOf(row.safety.fetchedAt) : 'GoPlus belum dipanggil untuk kandidat ini');
  if (row.structure?.lastClosedAt) {
    add('Candle 1 jam ditutup', `${ageOf(row.structure.lastClosedAt)} (${new Date(row.structure.lastClosedAt).toLocaleString('id-ID')})`);
  }
  if (row.structure?.close !== null && row.structure?.close !== undefined) {
    add('Close yang dipakai struktur', usd(row.structure.close));
  }
  if (row.candleSource?.fetchedAt) add('Candle diambil', ageOf(row.candleSource.fetchedAt));
  // Alasan kegagalan candle harus terlihat: batas laju provider berbeda
  // dari "tidak ada data pasar".
  if (row.candleSource?.reason) add('Alasan candle', row.candleSource.reason);
  if (row.deepReason) add('Alasan deep scan', row.deepReason);
  return box;
}

function candidateCell(label, text, className) {
  const td = node('td', text, className);
  td.dataset.label = label;
  return td;
}

function renderCandidates(data) {
  const tbody = $('candidates');
  // Baris tidak dibangun ulang kalau tidak ada yang berubah: rebuild
  // setiap 2 detikonomie memindahkan fokus keyboard dan-what the user was reading.
  const signature = data.rows.map(row => [
    row.mint, row.score, row.grade, row.confidence, row.deepState, row.deepReason,
    row.market?.priceUsd, row.market?.liquidityUsd, row.disqualified?.length ?? 0, row.entryPlan?.status
  ].join(',')).join('|');
  if (signature === candidatesSignature) return;
  candidatesSignature = signature;

  const focused = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-mint') : null;
  tbody.replaceChildren();
  if (!data.rows.length) {
    const row = node('tr');
    // Dua sebab yang berbeda harus dibaca berbeda: sumber data gagal,
    // atau memang tidak ada kandidat yang lolos gate.
    const message = data.universe?.total === 0
      ? 'Tidak ada kandidat yang bisa dinilai: tidak satu pun sumber data mengembalikan token. Lihat peringatan di atas — ini biasanya koneksi ke penyedia yang gagal (proxy/VPN/DNS menahan domain) atau batas laju, bukan pasar yang sepi. Jalankan Discover lagi setelah beberapa saat.'
      : 'Tidak ada kandidat yang lolos gate pada preset ini. Longgarkan preset atau tunggu kondisi pasar berubah.';
    const cell = node('td', message);
    cell.colSpan = 13; row.append(cell); tbody.append(row);
    return;
  }
  for (const row of data.rows) {
    const tr = node('tr', undefined, 'candidate-row');
    tr.dataset.mint = row.mint;
    if (row.disqualified?.length) tr.className = 'candidate-row disqualified';
    else if (row.deepState === 'antri') tr.className = 'candidate-row queued';
    else if (row.deepState === 'gagal') tr.className = 'candidate-row failed';
    tr.append(candidateCell('#', String(row.rank), 'num'));
    const token = node('td', undefined, 'cell-token token-cell');
    const mintCell = node('small', shortMint(row.mint));
    enableCopy(mintCell, row.mint);
    const symbolLine = node('strong', row.symbol ?? 'unknown');
    if (row.isNew) symbolLine.append(statusChip('baru', 'chip-new'));
    token.append(symbolLine, mintCell);
    tr.append(token);
    const score = candidateCell('Skor', undefined, 'cell-score');
    score.append(scoreGauge(row.score, row.grade, row.confidence));
    tr.append(score);
    const price = candidateCell('Harga', usd(row.market.priceUsd), `num ${blankClass(row.market.priceUsd)}`);
    price.title = row.market?.fetchedAt ? `Data pasar diambil ${ageOf(row.market.fetchedAt)}` : 'Waktu pengambilan data pasar unknown';
    tr.append(price);
    tr.append(changeCell(row.market.change?.h1, '1j'));
    tr.append(changeCell(row.market.change?.h24, '24j'));
    const liquidity = candidateCell('Likuiditas', usd0(row.market.liquidityUsd), `num ${blankClass(row.market.liquidityUsd)}`);
    liquidity.title = row.market?.source ? `Sumber: ${row.market.source}` : 'Sumber data likuiditas unknown';
    tr.append(liquidity);
    const turnover = candidateCell('Turnover', row.market.turnover === null ? 'unknown' : `${row.market.turnover.toFixed(2)}×`, `num ${blankClass(row.market.turnover)}`);
    tr.append(turnover);
    const mcap = candidateCell('MCap', usdCompact(row.market.marketCap), `num ${blankClass(row.market.marketCap)}`);
    tr.append(mcap);
    const top10 = candidateCell('Top10', pct(row.safety.top10Pct), `num ${blankClass(row.safety.top10Pct)}`);
    if (row.safety?.top10Source) top10.title = `Sumber konsentrasi holder: ${row.safety.top10Source}`;
    tr.append(top10);
    const poolAge = candidateCell('Umur pool', age(row.market.ageHours), `num ${blankClass(row.market.ageHours)}`);
    tr.append(poolAge);
    const setup = candidateCell('Setup');
    if (row.disqualified?.length) {
      setup.append(statusChip(`gugur: ${gateShort(row.disqualified[0].code)}`, 'chip-bad', row.disqualified.map(item => gateLabel(item.code)).join(' · ')));
    } else {
      // Tiga keadaan yang berbeda: sudah dianalisis, masih antri, atau gagal
      // dianalisis. "pending" lama membuat baris terlihat sedang berubah
      // padahal tidak ada yang menganalisisnya.
      const state = row.deepState === 'gagal' ? 'tidak dianalisis'
        : row.deepState === 'antri' ? 'antri'
          : (row.entryPlan?.setup ?? row.structure?.trend ?? 'tidak dianalisis');
      const ok = row.deepState !== 'antri' && row.deepState !== 'gagal' && row.entryPlan?.status === 'plan';
      setup.append(statusChip(state, ok ? 'chip-ok' : row.deepState === 'gagal' ? 'chip-warn' : 'chip-muted', row.deepReason ?? state));
    }
    tr.append(setup);
    const action = candidateCell('', undefined, 'cell-action');
    const detailButton = node('button', 'Rincian', 'text-button');
    detailButton.type = 'button';
    detailButton.setAttribute('data-mint', row.mint);
    detailButton.setAttribute('aria-expanded', openDetails.has(row.mint) ? 'true' : 'false');
    detailButton.addEventListener('click', event => { event.stopPropagation(); toggleDetail(tr, row); });
    action.append(detailButton);
    tr.append(action);
    tbody.append(tr);
    if (openDetails.has(row.mint)) toggleDetail(tr, row, true);
  }
  // Fokus keyboard harus kembali ke tombol yang sama setelah tabel dibangun ulang.
  if (focused && typeof document.querySelector === 'function') {
    const target = document.querySelector(`[data-mint="${focused}"]`);
    if (target && typeof target.focus === 'function') target.focus();
  }
}

function toggleDetail(tr, row, restore = false) {
  const next = tr.nextElementSibling;
  if (!restore && next?.classList.contains('detail-row')) {
    next.remove();
    openDetails.delete(row.mint);
    tr.querySelector?.('button')?.setAttribute?.('aria-expanded', 'false');
    return;
  }
  openDetails.add(row.mint);
  tr.querySelector?.('button')?.setAttribute?.('aria-expanded', 'true');
  const detail = node('tr', undefined, 'detail-row');
  const cell = node('td', undefined, 'detail-cell');
  cell.colSpan = 13;

  const grid = node('div', undefined, 'detail-grid');
  const components = node('div');
  components.append(node('h4', 'Komponen skor'));
  const gauge = scoreGauge(row.score, row.grade, row.confidence, true);
  components.append(gauge);
  const scale = node('div', undefined, 'gauge-scale');
  for (const [position, label] of [[0, '0'], [45, '45 C'], [60, '60 B'], [75, '75 A'], [100, '100']]) {
    const tick = node('span', label);
    tick.style.left = `${position}%`;
    tick.style.transform = position === 0 ? 'none' : position === 100 ? 'translateX(-100%)' : 'translateX(-50%)';
    scale.append(tick);
  }
  components.append(scale);
  components.append(node('p', scoreRange(row.score, row.confidence), 'hint'));
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

  const freshness = node('div');
  freshness.append(node('h4', 'Waktu dan asal data'));
  freshness.append(freshnessPanel(row));
  const concentration = node('p', undefined, 'hint');
  const top10 = row.safety?.top10Pct;
  const secondary = row.safety?.top10Secondary;
  concentration.textContent = row.safety?.top10Source
    ? `Top 10 holder memakai angka ${row.safety.top10Source} (${pct(top10)}).${secondary !== null && secondary !== undefined ? ` GoPlus membaca ${pct(secondary)} dengan definisi holder berbeda (termasuk wallet exchange/program); angka ini ditampilkan, bukan dipakai sebagai sumber gate.` : ''}`
    : 'Konsentrasi top 10 belum terukur dari sumber mana pun.';
  freshness.append(concentration);
  evidence.append(freshness);

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

function renderNearMiss(data) {
  const container = $('near-miss');
  const rows = data.nearMissRows ?? [];
  container.replaceChildren();
  $('near-miss-count').textContent = `${rows.length} dari ${data.universe?.nearMiss ?? rows.length} diberi skor`;
  if (!rows.length) {
    container.append(node('p', 'Tidak ada kandidat hampir-lolos pada run ini.', 'hint'));
    return;
  }
  const table = node('table', undefined, 'near-miss-table');
  const thead = node('thead');
  const hr = node('tr');
  for (const label of ['Token', 'Skor', 'MCap', 'Likuiditas', '24j', 'Gate yang gagal']) hr.append(node('th', label));
  thead.append(hr); table.append(thead);
  const tbody = node('tbody');
  for (const row of rows) {
    const tr = node('tr');
    const token = node('td', undefined, 'token-cell');
    const mint = node('small', shortMint(row.mint));
    enableCopy(mint, row.mint);
    token.append(node('strong', row.symbol ?? 'unknown'), mint);
    tr.append(token);
    const score = node('td', undefined, 'cell-score'); score.append(scoreGauge(row.score, row.grade, row.confidence)); tr.append(score);
    tr.append(node('td', usdCompact(row.market?.marketCap), 'num'));
    tr.append(node('td', usd0(row.market?.liquidityUsd), 'num'));
    tr.append(changeCell(row.market?.change?.h24, '24j'));
    const gates = node('td', undefined, 'near-miss-gates');
    for (const gate of row.failedGates ?? []) gates.append(statusChip(gateShort(gate.code), 'chip-bad', gateLabel(gate.code)));
    tr.append(gates);
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
}

function renderDiscover(data) {
  discoverData = data;
  $('discover-results').hidden = false;
  const runTime = data.finishedAt ? ` · diambil ${ageOf(data.finishedAt)}` : '';
  $('discover-meta').textContent = `${data.preset.label} · config ${data.configHash}${runTime}${data.cached ? ' · cache ≤ 60 detik' : ''}${data.refreshed ? ' · data disegarkan' : ''}`;
  const values = [
    ['Universe', `${data.universe.total} token`], ['Dievaluasi (punya pool)', String(data.universe.evaluated ?? data.universe.checked)],
    ['Lolos gate', String(data.universe.accepted)], ['Digugurkan', String(data.universe.rejected)],
    ['Kandidat tampil', String(data.rows.length)], ['Deep scan', data.jobTotal ? `${data.jobTotal} token` : 'tidak ada']
  ];
  $('discover-summary').replaceChildren(...values.map(([label, value]) => { const el = node('div', undefined, 'metric'); el.append(node('p', label), node('strong', value)); return el; }));
  findings($('discover-warnings'), data.warnings.map(reason => ({ level: 'unknown', title: 'Sumber data', reason })));

  // Kontribusi per sumber: sumber yang tidak berkontribusi harus terlihat,
  // bukan tercampur dalam satu angka universe.
  const sources = data.universe?.sources ?? {};
  const sourceNote = $('discover-sources');
  sourceNote.textContent = Object.keys(sources).length
    ? `Kandidat yang dievaluasi per sumber — ${Object.entries(sources).map(([label, count]) => `${label}: ${count}`).join(' · ')}.`
    : 'Kandidat yang dievaluasi per sumber: unknown.';

  renderCandidates(data);
  renderNearMiss(data);

  $('rejected-count').textContent = `${data.universe.rejected} ditolak`;
  const rejected = $('rejected');
  rejected.replaceChildren();
  if (!data.rejected.length) rejected.append(node('p', 'Tidak ada kandidat yang digugurkan pada daftar ini.', 'hint'));
  for (const item of data.rejected) {
    const box = node('div', undefined, 'finding reject');
    box.append(node('strong', `${item.symbol ?? item.mint.slice(0, 8)} · ${item.rejections.length} gate`));
    const list = node('ul');
    for (const rejection of item.rejections) list.append(node('li', `${gateLabel(rejection.code)}: ${rejection.reason}`));
    box.append(list);
    rejected.append(box);
  }

  $('deep-status').textContent = data.jobId ? `deep scan: 0/${data.jobTotal}` : 'deep scan: tidak ada';
  // Semua baris masuk antrean deep scan: baris yang belum dianalisis
  // ditandai "antri", bukan "pending" yang terlihat seperti sedang berubah.
  for (const row of data.rows) row.deepState = data.jobId ? 'antri' : 'tidak dianalisis';
  $('tel-run').textContent = data.finishedAt ? ageOf(data.finishedAt) : 'baru saja';
  $('tel-deep').textContent = data.jobId ? `0/${data.jobTotal}` : 'tidak ada';
  if (data.jobId) pollJob(data.jobId, data.jobTotal);
}

/**
 * Urutan baris: selama run, urutan awal tidak berubah kecuali ada kandidat
 * yang gugur (candidates yang gugur tidak boleh mendahului yang lolos).
 * Ranking penuh baru dihitung ulang setelah job selesai, supaya baris tidak
 * melompat di bawah cursor sambil dibaca.
 */
function sortRows(rows, final) {
  rows.sort((a, b) => Number(Boolean(a.disqualified?.length)) - Number(Boolean(b.disqualified?.length))
    || (final ? (b.score ?? -1) - (a.score ?? -1) : 0));
  rows.forEach((row, index) => { row.rank = index + 1; });
}

/** Sorot singkat pada baris yang baru saja berubah isinya. */
function flashRow(tr) {
  tr.className = `${tr.className} flash`;
  tr.addEventListener?.('animationend', () => { tr.className = tr.className.replace(/\s*flash\b/, ''); });
}

function pollJob(jobId, total) {
  clearTimeout(jobTimer);
  const generation = ++jobGeneration;
  // Deep scan mencakup semua baris dan diberi tempo (satu token setiap
  // ~13 detik karena batas publik GeckoTerminal), jadi satu run bisa
  // memakan beberapa menit. Batas poll disesuaikan dengan itu.
  // Di Vercel satu token diproses per poll (~15–25 detik). Run 15 baris
  // membutuhkan sekitar 5 menit; batas 12 menit memberi ruang untuk antrean
  // yang lambat tanpa membiarkan tab polling selamanya.
  const deadline = Date.now() + 12 * 60_000;
  const tick = async () => {
    let job;
    try {
      // Satu poll mungkin memproses satu token secara sinkron (13–25 detik,
      // termasuk jarak minimum GeckoTerminal), jadi timeout harus > itu.
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(45_000), cache: 'no-store' });
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
    $('tel-deep').textContent = `${job.completed}/${total}${job.failures ? ` · ${job.failures} gagal` : ''}`;
    const done = new Set();
    const updated = new Set();
    for (const result of job.results) {
      if (!discoverData) continue;
      const row = discoverData.rows.find(item => item.mint === result.mint);
      if (!row) continue;
      done.add(result.mint);
      updated.add(result.mint);
      if (!result.ok) {
        // Gagal dianalisis: alasannya ditampilkan, bukan disembunyikan di
        // balik label generik.
        row.deepState = 'gagal';
        row.deepReason = result.reason ?? 'Deep scan gagal.';
        continue;
      }
      row.deepState = 'analisis';
      row.score = result.result.score;
      row.grade = result.result.grade;
      row.confidence = result.result.confidence;
      row.components = result.result.components;
      row.penalties = result.result.penalties;
      row.safety = result.result.safety;
      row.structure = result.result.structure;
      row.entryPlan = result.result.entryPlan;
      row.disqualified = result.result.disqualified ?? null;
      // Data pasar dan waktu pengambilan candle ikut diperbarui: hasil
      // deep scan boleh memakai pool yang berbeda dari ranking awal.
      if (result.result.market) row.market = { ...row.market, ...result.result.market };
      if (result.result.candleSource) row.candleSource = result.result.candleSource;
      if (result.result.poolCheck) row.poolCheck = result.result.poolCheck;
    }
    // Baris yang belum selesai diantre, dan itu harus terlihat.
    for (const row of discoverData.rows) {
      if (row.deepState !== 'gagal' && !done.has(row.mint)) row.deepState = 'antri';
    }
    // Perbarui seluruh bukti, setup, dan status gugur pada setiap progres;
    // kandidat gugur tidak boleh dipromosikan oleh skor tingginya.
    const final = job.status === 'done';
    sortRows(discoverData.rows, final);
    renderCandidates(discoverData);
    for (const tr of $('candidates').children) {
      if (updated.has(tr.dataset.mint)) flashRow(tr);
    }
    if (final) {
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
  // Tombol Discover selalu berarti data baru: cache server dan cache sumber
  // selalu dilewati, tanpa toggle terpisah.
  const refresh = true;
  clearTimeout(jobTimer);
  jobGeneration++;
  discoverData = null;
  openDetails.clear();
  candidatesSignature = '';
  $('discover-button').disabled = true;
  $('discover-results').hidden = true;
  $('discover-status').className = '';
  $('discover-status').textContent = refresh
    ? 'Mengambil data baru (cache dilewati)… Deep scan shortlist berjalan setelah hasil awal.'
    : 'Mengambil universe, menyaring gate, dan memeringkat kandidat… Deep scan shortlist berjalan setelah hasil awal.';
  try {
    const response = await fetch(`/api/discover?preset=${encodeURIComponent(preset)}${refresh ? '&refresh=1' : ''}`, { signal: AbortSignal.timeout(90000), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderDiscover(data);
    $('discover-status').textContent = data.universe?.total === 0
      ? `Selesai · tidak ada sumber data yang bisa dibaca (${data.warnings.length} peringatan di atas) · bukan berarti pasar sepi.`
      : `Selesai · ${data.universe.accepted} lolos gate dari ${data.universe.evaluated ?? data.universe.checked} dievaluasi · ${data.rows.length} kandidat tampil${data.jobId ? ' · deep scan berjalan' : ''}.`;
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
  $('tel-candle').textContent = h.fetchedAt ? ageOf(h.fetchedAt) : 'belum ada';
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
  $('timestamp').textContent = `Snapshot diterima ${new Date(data.checkedAt).toLocaleString('id-ID')} (${ageOf(data.checkedAt)}) · ${data.cached ? 'cache ≤ 30 detik' : 'scan baru'}${data.refreshed ? ' · data disegarkan' : ''}${data.market?.fetchedAt ? ` · data pasar ${ageOf(data.market.fetchedAt)}` : ''}`;
  $('market-status').textContent = `pasar: ${market.status}`;
  $('tel-snapshot').textContent = ageOf(data.checkedAt);
  $('tel-market').textContent = market.fetchedAt ? ageOf(market.fetchedAt) : 'belum ada';
  $('tel-safety').textContent = risk.fetchedAt ? ageOf(risk.fetchedAt) : 'belum ada';
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
    row.append(label, node('td', pool.targetIsBase ? 'base' : 'quote'), node('td', usd(pool.priceUsd), 'num'), node('td', usd(pool.liquidityUsd), 'num'), node('td', usd(pool.volume24h), 'num'));
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
    $('tel-watch-count').textContent = String(data.items.length);
    const items = $('watch-items');
    items.replaceChildren();
    for (const item of data.items) {
      const box = node('div', undefined, 'watch-item');
      const head = node('div', undefined, 'section-head');
      const watchLabel = node('strong', item.snapshot?.symbol ? `${item.snapshot.symbol} · ${item.mint.slice(0, 8)}…` : item.mint);
      enableCopy(watchLabel, item.mint);
      head.append(watchLabel, node('span', item.addedAt, 'hint'));
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
    const last = data.history[0];
    $('tel-watch-run').textContent = last ? ageOf(last.startedAt) : 'belum ada';
    $('tel-watch-pass').textContent = last ? `${last.accepted}/${last.candidates} lolos` : 'belum ada';
  } catch (error) {
    if (generation !== watchGeneration) return;
    $('watch-status').className = 'error';
    $('watch-status').textContent = `Watchlist tidak dapat dimuat: ${error.message}`;
  }
}
$('watch-refresh').addEventListener('click', loadWatchlist);
enableCopy($('token-mint'), () => currentMint);
