import { createGoPlusSource } from './sources/goplus.mjs';
import { createJupiterSource } from './sources/jupiter.mjs';

/**
 * RugCheck tidak dipakai: hostname `api.rugcheck.xyz` tidak resolve dari
 * jaringan pengembangan (NXDOMAIN), sehingga endpoint dan skemanya tidak
 * dapat diverifikasi. Adapter ini memakai GoPlus (kontrak Token-2022 dan
 * distribusi holder) ditambah audit bawaan Jupiter sebagai pembanding.
 * Setiap nilai yang tidak tersedia tetap `unknown`, bukan "aman".
 */
export function createRiskProvider({ goplus = createGoPlusSource(), jupiter = createJupiterSource(), clock = Date.now } = {}) {
  return async function risk(mint) {
    const [security, search] = await Promise.all([
      goplus.security(mint),
      Promise.resolve().then(async () => {
        const result = await jupiter.topOrganic('1h', 100);
        if (result.status !== 'available') return { status: 'unknown', token: null, reason: result.reason };
        return { status: 'available', token: result.tokens.find(token => token.mint === mint) ?? null, reason: null };
      }).catch(error => ({ status: 'unknown', token: null, reason: error?.message ?? 'Jupiter gagal' }))
    ]);

    const s = security.security ?? null;
    const audit = search.token?.audit ?? null;
    const findings = [];

    if (s) {
      findings.push({
        level: s.mintable === true ? 'warning' : s.mintable === false ? 'info' : 'unknown',
        title: 'Mint authority',
        reason: s.mintable === true ? 'Mint authority masih aktif; suplai dapat ditambah.' : s.mintable === false ? 'Mint authority sudah dimatikan menurut GoPlus.' : 'Status mint authority tidak dapat dibaca.'
      });
      findings.push({
        level: s.freezable === true ? 'warning' : s.freezable === false ? 'info' : 'unknown',
        title: 'Freeze authority',
        reason: s.freezable === true ? 'Freeze authority masih aktif; saldo dapat dibekukan.' : s.freezable === false ? 'Freeze authority sudah dimatikan menurut GoPlus.' : 'Status freeze authority tidak dapat dibaca.'
      });
      const transferUnknown = s.transferFee == null || s.transferHook == null;
      findings.push({
        level: s.transferFee || s.transferHook ? 'warning' : transferUnknown ? 'unknown' : 'info',
        title: 'Perilaku transfer Token-2022',
        reason: s.transferFee ? 'Token memiliki transfer fee; nilai diterima berbeda dari nilai transaksi.'
          : s.transferHook ? 'Token memiliki transfer hook; logika pihak ketiga berjalan saat transfer.'
            : transferUnknown ? 'Status transfer fee atau hook tidak lengkap; nilai kosong bukan bukti tidak ada.'
              : 'Tidak ada transfer fee atau hook yang dilaporkan GoPlus.'
      });
      findings.push({
        level: s.top10Pct == null ? 'unknown' : s.top10Pct > 35 ? 'warning' : 'info',
        title: 'Konsentrasi top 10 holder',
        reason: s.top10Pct == null ? 'Distribusi holder tidak tersedia.' : `Top 10 holder memegang ${s.top10Pct.toFixed(1)}% suplai menurut GoPlus. Ambang peringatan lokal 35%.`
      });
      findings.push({
        level: s.lpHolderPct == null ? 'unknown' : 'info',
        title: 'Holder LP',
        reason: s.lpHolderPct == null ? 'Status kunci/burn LP tidak dilaporkan. Likuiditas tidak membuktikan LP terkunci.' : `GoPlus melaporkan ${s.lpHolderPct.toFixed(1)}% pasokan LP pada holder teridentifikasi; ini bukan bukti lock.`
      });
    } else {
      findings.push({ level: 'unknown', title: 'Pemeriksaan kontrak GoPlus', reason: security.reason ?? 'GoPlus tidak tersedia.' });
    }

    if (audit) {
      findings.push({
        level: audit.mintAuthorityDisabled && audit.freezeAuthorityDisabled ? 'info' : 'warning',
        title: 'Audit Jupiter (pembanding)',
        reason: `mint authority ${audit.mintAuthorityDisabled ? 'mati' : 'tidak dikonfirmasi mati'}, freeze authority ${audit.freezeAuthorityDisabled ? 'mati' : 'tidak dikonfirmasi mati'}, top holder ${audit.topHoldersPercentage == null ? 'unknown' : `${audit.topHoldersPercentage.toFixed(1)}%`}.`
      });
    } else if (search.status !== 'available') {
      findings.push({ level: 'unknown', title: 'Audit Jupiter (pembanding)', reason: search.reason ?? 'Token tidak ada di daftar Jupiter saat ini.' });
    } else {
      // Jupiter tersedia tapi token ini tidak ada di daftar top organic:
      // audit Jupiter memang tidak tersedia untuk mint ini, dan itu harus
      // terlihat. Kehilangan audit bukan berarti auditnya bersih.
      findings.push({ level: 'unknown', title: 'Audit Jupiter (pembanding)', reason: 'Token tidak ada di daftar top organic Jupiter saat ini, jadi audit Jupiter tidak tersedia untuk mint ini. Ketiadaan audit bukan tanda audit baik.' });
    }

    const critical = findings.filter(finding => finding.level === 'warning').length;
    const unknown = findings.filter(finding => finding.level === 'unknown').length;
    const status = !s && !audit ? 'unknown' : security.status !== 'available' || unknown ? 'partial' : 'available';

    return {
      status,
      source: 'GoPlus + Jupiter',
      endpoint: 'https://api.gopluslabs.io/api/v1/solana/token_security',
      docs: ['https://docs.gopluslabs.io/reference/solana-token-security', 'https://dev.jup.ag/docs/api/'],
      fetchedAt: security.fetchedAt ?? null,
      checked: { goplus: s !== null, jupiterAudit: audit !== null },
      score: s ? {
        criticalFindings: critical,
        unknownFindings: unknown,
        mintable: s.mintable,
        freezable: s.freezable,
        transferFee: s.transferFee == null ? null : Boolean(s.transferFee),
        transferHook: s.transferHook == null ? null : Boolean(s.transferHook),
        nonTransferable: s.nonTransferable,
        top10Pct: s.top10Pct,
        holderCount: s.holderCount
      } : null,
      reason: status === 'available'
        ? 'Pemeriksaan kontrak dan distribusi holder tersedia. Tidak ada temuan kritis menurut aturan lokal, tetapi ini bukan jaminan aman.'
        : status === 'partial'
          ? 'Sebagian data keamanan tidak tersedia. Nilai unknown bukan risiko rendah; baca tiap temuan.'
          : 'Sumber keamanan tidak tersedia. Semua status keamanan unknown, bukan risiko rendah.',
      findings
    };
  };
}

// Provider bawaan dibuat lazily supaya client baru lahir saat fetchRisk
// benar-benar dipakai; server memakai createRiskProvider dengan sumber yang
// sudah dipakai Discover agar cache dan batas laju tidak terhitung dua kali.
let defaultProvider = null;
export async function fetchRisk(mint) {
  defaultProvider ??= createRiskProvider();
  return defaultProvider(mint);
}
