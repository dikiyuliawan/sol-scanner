import { DISCOVERY, PRESETS } from '../config.mjs';
import { evaluateGates } from './gates.mjs';
import { scoreCandidate } from './score.mjs';

/** Gabungkan universe dari beberapa sumber tanpa kehilangan provenance. */
export function mergeUniverse(entries) {
  const byMint = new Map();
  for (const entry of entries) {
    if (!entry?.mint) continue;
    const current = byMint.get(entry.mint);
    if (!current) {
      byMint.set(entry.mint, { mint: entry.mint, sources: [entry.source], jupiter: entry.jupiter ?? null, pool: entry.pool ?? null });
      continue;
    }
    if (!current.sources.includes(entry.source)) current.sources.push(entry.source);
    if (!current.jupiter && entry.jupiter) current.jupiter = entry.jupiter;
    if (!current.pool && entry.pool) current.pool = entry.pool;
    if (current.pool && entry.pool) {
      const better = (entry.pool.liquidityUsd ?? -1) > (current.pool.liquidityUsd ?? -1);
      if (better) current.pool = entry.pool;
    }
  }
  return [...byMint.values()];
}

/**
 * Gate dan skor SEMUA kandidat, termasuk yang gagal gate.
 *
 * Sebelumnya hanya kandidat yang lolos yang diberi skor, sehingga token yang
 * digugurkan satu gate (sering justru kandidat berpotensi) hilang tanpa angka
 * dan tidak pernah tercatat. Sekarang setiap kandidat punya skor, dan yang
 * gagal disimpan sebagai `nearMiss` agar bisa dibaca, diurutkan, dan dipakai
 * untuk mengevaluasi gate mana yang terlalu ketat.
 */
export function rankCandidates(candidates, { preset, limit = 20, nearMissLimit = DISCOVERY.nearMissLimit } = {}) {
  const accepted = [];
  const rejected = [];
  const scoredRejected = [];
  for (const candidate of candidates) {
    const gates = evaluateGates(candidate, preset);
    const scoring = scoreCandidate(candidate, preset);
    if (!gates.passed) {
      rejected.push({
        mint: candidate.mint,
        symbol: candidate.jupiter?.symbol ?? candidate.market?.pool?.baseSymbol ?? null,
        rejections: gates.rejections,
        warnings: gates.warnings,
        score: scoring.score,
        grade: scoring.grade
      });
      scoredRejected.push({ ...candidate, gates, scoring });
      continue;
    }
    accepted.push({ ...candidate, gates, scoring });
  }
  accepted.sort((a, b) => (b.scoring.score ?? -1) - (a.scoring.score ?? -1) || (b.market?.pool?.liquidityUsd ?? 0) - (a.market?.pool?.liquidityUsd ?? 0));
  scoredRejected.sort((a, b) => (b.scoring.score ?? -1) - (a.scoring.score ?? -1) || (b.market?.pool?.liquidityUsd ?? 0) - (a.market?.pool?.liquidityUsd ?? 0));
  const ranked = accepted.slice(0, limit).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const nearMiss = scoredRejected.slice(0, nearMissLimit);
  return {
    ranked,
    accepted: accepted.length,
    rejected: rejected.slice(0, 40),
    rejectedCount: rejected.length,
    nearMiss,
    nearMissCount: scoredRejected.length
  };
}

export function presetOrDefault(name) {
  return name && name in PRESETS ? name : 'balanced';
}
