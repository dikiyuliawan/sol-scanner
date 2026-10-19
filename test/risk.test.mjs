import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiskProvider } from '../risk.mjs';

test('risk preserves known GoPlus hazards and reports missing transfer controls as partial', async () => {
  const risk = createRiskProvider({
    goplus: { async security() { return {
      status: 'partial', source: 'GoPlus', reason: 'missing fields',
      security: { mintable: true, freezable: false, nonTransferable: false, transferFee: null, transferHook: null, top10Pct: 20, lpHolderPct: null }
    }; } },
    jupiter: { async topOrganic() { return { status: 'unknown', reason: 'offline', tokens: [] }; } }
  });

  const result = await risk('Mint');
  assert.equal(result.status, 'partial');
  assert.equal(result.checked.goplus, true);
  assert.ok(result.findings.some(finding => finding.title === 'Mint authority' && finding.level === 'warning'));
  assert.ok(result.findings.some(finding => finding.title === 'Perilaku transfer Token-2022' && finding.level === 'unknown'));
});
