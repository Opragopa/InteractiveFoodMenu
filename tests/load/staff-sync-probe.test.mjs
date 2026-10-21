import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { probeStaffSync } from './staff-sync-probe.mjs';
test('foreground staff sync refreshes menu after an observed version change', async () => {
  let versionCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/hub/overview') return response.end(JSON.stringify({ venues: [{ id: 'v1', name: 'AUDIT test123 1' }] }));
    if (request.url === '/api/menu/version') { versionCalls++; return response.end(JSON.stringify({ version: 2 })); }
    if (request.url === '/api/menu') return response.end(JSON.stringify({ venue: { id: 'v1', menuVersion: versionCalls ? 2 : 1 }, items: [] }));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const fixture = { format: 'ifm-audit-v1', runId: 'test123', identity: { projectId: 'ifm-audit-test123', databaseId: 'ifm-audit-test123' }, baseUrl: base, origin: base,
      markerVenueId: 'v1', venueIds: ['v1'], hub: { cookie: 'ifm_hub=fake' }, staff: [{ venueId: 'v1', cookie: 'ifm_staff=fake' }], screens: [{}] };
    const result = await probeStaffSync(fixture, { durationSeconds: .13, intervalMs: 30, timeoutMs: 200 });
    assert.equal(result.passed, true); assert.ok(result.versionSummary.count >= 2); assert.equal(result.requests.filter(row => row.route === 'staff-menu').length, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
