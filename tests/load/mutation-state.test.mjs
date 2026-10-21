import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { requestFull } from './lib.mjs';
import { mutationEvidence } from './mutation-state.mjs';
import { compareSnapshots } from './reconcile-lib.mjs';

test('fake HTTP successful availability mutation fails reconciliation for missing or duplicate events', async () => {
  for (const eventsPerTransition of [1, 0, 2]) {
    let available = true, eventCount = 0;
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'PATCH') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (available !== body.isAvailable) eventCount += eventsPerTransition;
        available = body.isAvailable;
        return response.end(JSON.stringify({ item: { id: 'i2', venueId: 'v1', isAvailable: available, priceMinor: 200, token: 'must-not-enter-evidence' } }));
      }
      response.end(JSON.stringify({ availabilityChanges: eventCount }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = await requestFull(base, '/api/items/i2', { method: 'PATCH', body: { isAvailable: false } });
      assert.equal(response.ok, true);
      const mutation = { ...mutationEvidence('availability-write', { venueId: 'v1', untrackedItemId: 'i2' }, response.data, { isAvailable: false }), sequence: 1 };
      assert.doesNotMatch(JSON.stringify(mutation), /token|must-not-enter/);
      const actualEvents = (await requestFull(base, '/counts')).data.availabilityChanges;
      const item = { venueId: 'v1', stockQuantity: null, isAvailable: true, priceMinor: 200 };
      const counters = { availabilityChanges: 0, stockChanges: 0, menuChanges: 0, staffLogins: 0, displayConnections: 0, displayContactIntervals: 0, errors: 0 };
      const before = { format: 'ifm-audit-statistics-v1', runId: 'test123', identity: { databaseId: 'ifm-audit-test123' }, period: { from: '2026-09-20', to: '2026-10-22' }, capturedAt: '2026-10-20T00:00:00Z', apiEqualsSource: true,
        sourceTotals: structuredClone(counters), apiTotals: structuredClone(counters), contacts: { intervals: [], invalidRows: 0 }, stocks: { i2: null }, items: { i2: item }, venues: [{ venueId: 'v1', state: { breakActive: false } }] };
      const after = structuredClone(before); after.captureStartedAt = '2026-10-20T02:01:00Z'; after.capturedAt = '2026-10-20T02:02:00Z';
      after.items.i2.isAvailable = false; after.sourceTotals.availabilityChanges = after.apiTotals.availabilityChanges = actualEvents;
      after.sourceTotals.menuChanges = after.apiTotals.menuChanges = 1;
      const summary = { mutationEvidenceVersion: 1, initialItemStates: { i2: item }, startedAt: '2026-10-20T00:01:00Z', endedAt: '2026-10-20T02:00:00Z', stockChecks: [{ itemId: 'i2', initial: null, expected: null, ok: true }] };
      const result = compareSnapshots(before, after, [{ ok: true, route: 'availability-write', mutation }], summary);
      assert.equal(result.passed, eventsPerTransition === 1);
      assert.equal(result.counts.find(row => row.name === 'availabilityChanges').expected, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
