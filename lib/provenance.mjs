/**
 * Setiap angka membawa asal dan waktunya. `value === null` selalu berarti
 * unknown, tidak pernah berarti nol.
 */
export function fact(value, source, fetchedAt = null) {
  const known = typeof value === 'number' ? Number.isFinite(value) : value !== null && value !== undefined;
  return {
    value: known ? value : null,
    status: known ? 'available' : 'unknown',
    source: source ?? null,
    fetchedAt: fetchedAt ?? null
  };
}

export function unknownFact(source, fetchedAt = null) {
  return { value: null, status: 'unknown', source: source ?? null, fetchedAt: fetchedAt ?? null };
}

export function factValue(record) {
  return record && typeof record === 'object' && 'value' in record ? record.value : null;
}

export function evidenceRow(label, record, display) {
  return {
    label,
    value: factValue(record),
    status: record?.status ?? 'unknown',
    source: record?.source ?? null,
    fetchedAt: record?.fetchedAt ?? null,
    display: display ?? null
  };
}

export function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
