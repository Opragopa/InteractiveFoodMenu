export const groups = {
  menuChanges: ['category_created', 'category_updated', 'category_deleted', 'item_created', 'item_updated', 'item_deleted', 'venue_updated', 'break_started', 'break_stopped'],
  availabilityChanges: ['availability_changed'], stockChanges: ['stock_adjusted'], staffLogins: ['staff_login'],
  displayConnections: ['display_connected'], displayContactIntervals: ['display_seen'],
};
export const eventTypes = [...new Set(Object.values(groups).flat())];
export function totals(venues, source) {
  const result = {};
  for (const venue of venues) for (const [name, value] of Object.entries(venue[source])) result[name] = (result[name] ?? 0) + value;
  return result;
}
export function compareSnapshots(before, after, requests, summary) {
  if (before.format !== 'ifm-audit-statistics-v1' || after.format !== before.format || before.runId !== after.runId ||
      JSON.stringify(before.identity) !== JSON.stringify(after.identity) || JSON.stringify(before.period) !== JSON.stringify(after.period)) {
    throw new Error('Snapshot identity or period differs.');
  }
  const times = [before.capturedAt, after.captureStartedAt, summary.startedAt, summary.endedAt].map(Date.parse);
  if (times.some(value => !Number.isFinite(value)) || times[2] > times[3]) throw new Error('Invalid snapshot or workload timestamps.');
  if (times[0] > times[2] || times[1] < times[3]) {
    throw new Error('Snapshots must bracket the complete workload while writers are stopped.');
  }
  const expected = {
    stockChanges: requests.filter(row => row.ok && row.route === 'stock-adjust').length,
    menuChanges: requests.filter(row => row.ok && ['availability-write', 'price-write', 'break-write'].includes(row.route)).length,
    staffLogins: 0, displayConnections: 0, errors: 0,
  };
  if (summary.mutationEvidenceVersion !== 1 || !before.items || !after.items) throw new Error('Versioned mutation evidence and item-state snapshots are required. Old quick journals cannot prove full event semantics.');
  const state = structuredClone(before.items), sequences = new Map(), evidenceErrors = [];
  const breakState = Object.fromEntries((before.venues ?? []).map(row => [row.venueId, row.state?.breakActive]));
  expected.availabilityChanges = 0;
  const mutationRoutes = new Set(['stock-adjust', 'availability-write', 'price-write', 'break-write']);
  for (const row of requests.filter(row => row.ok && mutationRoutes.has(row.route))) {
    const evidence = row.mutation;
    if (evidence?.version !== 1 || evidence.operation !== row.route || typeof evidence.venueId !== 'string' || evidence.sequence !== (sequences.get(evidence.venueId) ?? 0) + 1) { evidenceErrors.push('Missing, out-of-order or invalid mutation evidence.'); continue; }
    sequences.set(evidence.venueId, evidence.sequence);
    if (row.route === 'break-write') {
      if (!(evidence.venueId in breakState) || typeof evidence.state?.breakActive !== 'boolean') evidenceErrors.push('Invalid break state evidence.');
      else breakState[evidence.venueId] = evidence.state.breakActive;
      continue;
    }
    const previous = state[evidence.itemId], next = evidence.state;
    if (!previous || previous.venueId !== evidence.venueId || typeof next?.isAvailable !== 'boolean' || !Number.isInteger(next.priceMinor) || next.stockQuantity !== null && (!Number.isInteger(next.stockQuantity) || next.stockQuantity < 0)) { evidenceErrors.push('Invalid item state evidence.'); continue; }
    if (row.route === 'stock-adjust' && (![1,-1].includes(evidence.delta) || previous.stockQuantity === null || next.stockQuantity !== previous.stockQuantity + evidence.delta)) evidenceErrors.push('Stock delta and resulting state differ.');
    if (row.route !== 'stock-adjust' && next.stockQuantity !== previous.stockQuantity) evidenceErrors.push('Unexpected stock mutation.');
    if (previous.isAvailable !== next.isAvailable) expected.availabilityChanges++;
    state[evidence.itemId] = { venueId: evidence.venueId, ...next };
  }
  const fields = ['venueId', 'stockQuantity', 'isAvailable', 'priceMinor'];
  const itemChecks = Object.entries(state).map(([itemId, expectedState]) => ({ itemId, expected: expectedState, actual: after.items[itemId],
    initialMatches: fields.every(field => summary.initialItemStates?.[itemId]?.[field] === before.items[itemId][field]),
    passed: fields.every(field => summary.initialItemStates?.[itemId]?.[field] === before.items[itemId][field] && after.items[itemId]?.[field] === expectedState[field]) }));
  const breakChecks = Object.entries(breakState).map(([venueId, expected]) => ({ venueId, expected, actual: after.venues?.find(row => row.venueId === venueId)?.state?.breakActive,
    passed: typeof expected === 'boolean' && after.venues?.find(row => row.venueId === venueId)?.state?.breakActive === expected }));
  const delta = Object.fromEntries(Object.keys(after.sourceTotals).map(name => [name, after.sourceTotals[name] - (before.sourceTotals[name] ?? 0)]));
  const apiDelta = Object.fromEntries(Object.keys(after.apiTotals).map(name => [name, after.apiTotals[name] - (before.apiTotals[name] ?? 0)]));
  const counts = Object.entries(expected).map(([name, value]) => ({ name, expected: value, sourceActual: delta[name], apiActual: apiDelta[name], passed: delta[name] === value && apiDelta[name] === value }));
  const priorContacts = new Set(before.contacts.intervals);
  const newContacts = after.contacts.intervals.filter(key => !priorContacts.has(key));
  counts.push({ name: 'displayContactIntervals', expected: newContacts.length, sourceActual: delta.displayContactIntervals, apiActual: apiDelta.displayContactIntervals,
    passed: delta.displayContactIntervals === newContacts.length && apiDelta.displayContactIntervals === newContacts.length });
  const stockChecks = (summary.stockChecks ?? []).map(row => ({ itemId: row.itemId, expected: row.expected, sourceActual: after.stocks[row.itemId],
    initialMatches: before.stocks[row.itemId] === row.initial, passed: row.ok && before.stocks[row.itemId] === row.initial && after.stocks[row.itemId] === row.expected }));
  return {
    format: 'ifm-audit-reconciliation-v1', runId: before.runId, before: before.capturedAt, after: after.capturedAt, period: before.period,
    apiEqualsSource: before.apiEqualsSource && after.apiEqualsSource,
    expectedFrom: 'Successful workload requests. No additional mutations may run between snapshots.',
    coverage: 'versioned_mutation_state_replay', allCounterSemanticsVerified: evidenceErrors.length === 0, evidenceErrors, itemChecks, breakChecks, counts, sourceDelta: delta, apiDelta, stockChecks,
    contacts: { newDistinctScreenIntervals: newContacts.length, invalidRows: before.contacts.invalidRows + after.contacts.invalidRows,
      meaning: 'Operational screen contact intervals; not people, visitor views, orders or sales.' },
    workloadFailures: requests.filter(row => !row.ok).length,
    passed: evidenceErrors.length === 0 && itemChecks.length > 0 && itemChecks.every(row => row.passed) && breakChecks.length > 0 && breakChecks.every(row => row.passed) && before.apiEqualsSource && after.apiEqualsSource && counts.every(row => row.passed) && stockChecks.length > 0 && stockChecks.every(row => row.passed) &&
      !before.contacts.invalidRows && !after.contacts.invalidRows && requests.every(row => row.ok),
  };
}
