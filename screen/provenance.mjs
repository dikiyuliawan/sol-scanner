/**
 * Sumber angka untuk screening.
 *
 * Satu proses gate harus memakai SATU sumber untuk satu metrik. Kalau
 * sumbernya berpindah di tengah proses (mis. ranking awal memakai satu
 * penyedia, gate ulang setelah deep scan memakai penyedia lain), kandidat
 * bisa gugur karena pergantian sumber, bukan karena temuan baru.
 *
 * Konsentrasi top 10 punya dua pembaca yang tidak bisa dibandingkan:
 * - GoPlus menjumlah sepuluh persentase holder terbesar dan menghitung
 *   wallet exchange/program sebagai holder,
 * - audit Jupiter memakai poin persentase dengan definisi holder yang
 *   lebih sempit.
 * Satu token bisa saja terbaca 65% di satu sumber dan 15% di sumber lain
 * pada menit yang sama. Angka GoPlus tetap ditampilkan sebagai peringatan
 * agar pembaca yang lebih ketat ikut terlihat, tetapi gate memakai satu
 * sumber saja: audit Jupiter bila tersedia (tersedia untuk setiap kandidat
 * Discover), kalau tidak GoPlus.
 */

export function concentrationFor(candidate) {
  const jupiter = candidate?.jupiter?.audit?.topHoldersPercentage ?? null;
  const goPlus = candidate?.safety?.security?.top10Pct ?? null;
  if (jupiter !== null && jupiter !== undefined) return { value: jupiter, source: 'Jupiter' };
  if (goPlus !== null && goPlus !== undefined) return { value: goPlus, source: 'GoPlus' };
  return { value: null, source: null };
}

/** Pembaca kedua (GoPlus) untuk metrik yang sama, kalau datanya ada. */
export function secondaryConcentration(candidate) {
  const concentration = concentrationFor(candidate);
  const goPlus = candidate?.safety?.security?.top10Pct ?? null;
  if (goPlus === null || goPlus === undefined) return null;
  if (concentration.source === 'GoPlus') return null;
  return { value: goPlus, source: 'GoPlus' };
}

/**
 * Sumber sebenarnya dari sebuah nilai: nilai yang diambil dari sumber
 * lain harus tetap menyebut sumber aslinya, bukan sumber bawaan.
 */
export function sourceLabel(value, primary, fallback) {
  if (value === null || value === undefined) return fallback;
  return value === primary ? primary : fallback;
}
