import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { args, assertTestUrl, externalPath, fixtureGuard, jwt, loadJsonExternal, repoRoot, requestFull, verifyApiIdentity } from './lib.mjs';

const cli = args();
if (!cli.config || !cli.output || !cli['allow-regressions']) throw new Error('Usage: node tests/load/appwrite-regressions.mjs --config /external/audit.json --output /external/result.json --allow-regressions --confirm-run RUN_ID [--phase baseline|fixed]');
const config = await loadJsonExternal(cli.config);
const fixture = fixtureGuard(await loadJsonExternal(config.fixturePath));
if (cli['confirm-run'] !== config.runId || fixture.runId !== config.runId || config.sessionSecret?.length < 32) throw new Error('Run identity confirmation failed.');
for (const key of ['projectId', 'databaseId', 'bucketId']) if (config.appwrite?.[key] !== `ifm-audit-${config.runId}`) throw new Error('Not an isolated Appwrite audit project.');
if (fixture.identity.projectId !== config.appwrite.projectId || fixture.identity.databaseId !== config.appwrite.databaseId) throw new Error('Fixture and Appwrite identities differ.');
const base = assertTestUrl(config.baseUrl);
if (base !== assertTestUrl(fixture.baseUrl) || assertTestUrl(config.origin) !== assertTestUrl(fixture.origin)) throw new Error('Fixture/API origins differ.');
assertTestUrl(config.appwrite.endpoint);
const output = await externalPath(cli.output, { existing: false });
const require = createRequire(repoRoot + '/backend-api/package.json');
const { Client, TablesDB, Query } = require('node-appwrite');
const tables = new TablesDB(new Client().setEndpoint(config.appwrite.endpoint).setProject(config.appwrite.projectId).setKey(config.appwrite.apiKey).setSelfSigned(config.appwrite.selfSigned === true));
const databaseId = config.appwrite.databaseId;
const nonce = randomBytes(3).toString('hex');
const prefix = `a${config.runId}r${nonce}`;
const venueIds = [`${prefix}v1`, `${prefix}v2`];
const id = suffix => `${prefix}${suffix}`;
const knownRows = new Map();
const createdVenues = new Set();
const results = [];
const report = { format: 'ifm-appwrite-regressions-v1', phase: String(cli.phase ?? 'fixed'), runId: config.runId, startedAt: new Date().toISOString(), datastore: 'appwrite', results, cleanup: null };
const hub = { cookie: fixture.hub.cookie, origin: fixture.origin, 'content-type': 'application/json' };
const staffHeaders = venueId => ({ authorization: `Bearer ${jwt({ role: 'staff', venueId, version: 1, authType: 'legacy' }, config.sessionSecret)}`, 'content-type': 'application/json' });
const api = (route, { method = 'GET', body, headers = staffHeaders(venueIds[0]) } = {}) => requestFull(base, '/api' + route, { method, body, headers, timeoutMs: 30000 });
const expectStatus = (result, expected) => assert.equal(result.status, expected, `expected HTTP ${expected}, got ${result.status}`);
const secret = randomBytes(32).toString('base64url');
const salt = randomBytes(16);
const digest = `scrypt:${salt.toString('base64url')}:${scryptSync(secret, salt, 64).toString('base64url')}`;
const pin = String(100000 + randomBytes(4).readUInt32BE() % 900000);
const pinSalt = randomBytes(16);
const pinHash = `scrypt:${pinSalt.toString('base64url')}:${scryptSync(pin, pinSalt, 64).toString('base64url')}`;
const now = () => new Date().toISOString();
async function get(tableId, rowId) { return tables.getRow({ databaseId, tableId, rowId }); }
async function put(tableId, rowId, data) {
  if (!rowId.startsWith(prefix) || data.venueId && !venueIds.includes(data.venueId)) throw new Error('Refusing a foreign regression row.');
  const row = await tables.createRow({ databaseId, tableId, rowId, data });
  if (!knownRows.has(tableId)) knownRows.set(tableId, new Set());
  knownRows.get(tableId).add(rowId);
  if (tableId === 'venues') createdVenues.add(rowId);
  return row;
}
async function update(tableId, rowId, data) {
  if (!rowId.startsWith(prefix)) throw new Error('Refusing a foreign regression update.');
  return tables.updateRow({ databaseId, tableId, rowId, data });
}
async function all(tableId, filters = []) {
  const rows = []; let cursor;
  for (;;) {
    const page = await tables.listRows({ databaseId, tableId, queries: [...filters, Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
    rows.push(...page.rows);
    if (page.rows.length < 100) return rows;
    cursor = page.rows.at(-1).$id;
  }
}
async function owned(tableId, venueId = venueIds[0], filters = []) { return all(tableId, [Query.equal('venueId', [venueId]), ...filters]); }
async function marker() {
  const row = await get('venues', fixture.markerVenueId);
  if (row.name !== `AUDIT ${config.runId} 1`) throw new Error('Sentinel mismatch; refusing regression mutation.');
}
async function check(name, operation) {
  await marker();
  const started = performance.now();
  try {
    const observed = await operation();
    results.push({ name, passed: true, durationMs: Math.round(performance.now() - started), observed });
  } catch (error) {
    // Only locally generated assertion text is retained. Remote SDK errors may
    // contain request details, so retain their numeric code without messages.
    results.push({ name, passed: false, durationMs: Math.round(performance.now() - started), failure: error instanceof assert.AssertionError ? error.message.split('\n')[0].slice(0, 180) : `operation_error_${Number(error.code) || 'unknown'}` });
  }
  console.log(JSON.stringify({ event: 'appwrite_regression', ...results.at(-1) }));
}
async function newPair(suffix) {
  const rowId = id(suffix);
  await put('display_pairings', rowId, { tokenHash: digest, status: 'pending', expiresAt: new Date(Date.now() + 300000).toISOString(), createdAt: now() });
  return { pairingToken: `${rowId}.${secret}`, venueCode: `audit-${config.runId}-${nonce}-1`, pin };
}
let mutationStarted = false;
try {
  await verifyApiIdentity(fixture);
  await marker();
  const ready = await requestFull(base, '/ready');
  if (!ready.ok || ready.data?.status !== 'ready' || ready.data.datastore && ready.data.datastore !== 'appwrite') throw new Error('API not ready on Appwrite.');
  const template = Object.fromEntries(Object.entries(await get('venues', fixture.markerVenueId)).filter(([key]) => !key.startsWith('$')));
  mutationStarted = true;
  for (let index = 0; index < venueIds.length; index++) {
    await put('venues', venueIds[index], { ...template, name: `AUDIT REG ${nonce} ${index + 1}`, code: `audit-${config.runId}-${nonce}-${index + 1}`, pinHash, staffVersion: 1, displayVersion: 1, menuVersion: 1, active: true, updatedAt: now(), updatedBy: 'audit-regression' });
    await put('categories', id(`c${index + 1}`), { venueId: venueIds[index], name: 'Regression category', sortOrder: 0, updatedAt: now(), updatedBy: 'audit-regression' });
    await put('items', id(`i${index + 1}`), { venueId: venueIds[index], categoryId: id(`c${index + 1}`), name: 'Regression item', priceMinor: 100, stockQuantity: 0, isAvailable: false, sortOrder: 0, updatedAt: now(), updatedBy: 'audit-regression' });
  }
  await check('staff_version_route_and_cross_venue_isolation', async () => {
    expectStatus(await api('/menu/version'), 200);
    expectStatus(await api(`/items/${id('i2')}`, { method: 'PATCH', body: { name: 'Foreign change' } }), 404);
    assert.equal((await get('items', id('i2'))).name, 'Regression item');
    expectStatus(await api('/hub/overview'), 403);
    return { staffVersion: 'authorized', crossVenue: 'denied' };
  });
  await check('staff_revocation_and_disabled_venue', async () => {
    try {
      await update('venues', venueIds[0], { staffVersion: 2 });
      expectStatus(await api(`/items/${id('i1')}`, { method: 'PATCH', body: { name: 'Revoked change' } }), 401);
      expectStatus(await api(`/items/${id('i1')}/stock/adjust`, { method: 'POST', body: { delta: 1 } }), 401);
      await update('venues', venueIds[0], { staffVersion: 1, active: false });
      expectStatus(await api(`/items/${id('i1')}`, { method: 'PATCH', body: { name: 'Disabled change' } }), 401);
      return { staleMutations: 'denied', disabledMutation: 'denied' };
    } finally { await update('venues', venueIds[0], { staffVersion: 1, active: true }); }
  });
  await check('display_login_ignores_unrelated_revoked_staff_cookie', async () => {
    const tokenId = id('staled');
    await put('display_tokens', tokenId, { venueId: venueIds[0], active: true, tokenHash: digest, createdAt: now(), label: 'Audit stale-cookie regression' });
    const cookie = `ifm_staff=${jwt({ role: 'staff', venueId: venueIds[0], version: 0, authType: 'legacy' }, config.sessionSecret)}`;
    const headers = { cookie, origin: fixture.origin, 'content-type': 'application/json' };
    const login = await api('/auth/display', { method: 'POST', body: { tokenId, secret }, headers });
    expectStatus(login, 200);
    expectStatus(await api(`/items/${id('i1')}`, { method: 'PATCH', body: { name: 'Stale cookie change' }, headers }), 401);
    await tables.deleteRow({ databaseId, tableId: 'display_tokens', rowId: tokenId });
    return { displayLoginStatus: login.status, protectedStaffWriteStatus: 401 };
  });
  for (const [count, kind] of [[101, 'rotate'], [201, 'revoke-all'], [501, 'venue-revoke']]) await check(`mass_${kind}_${count}_tokens_and_old_link_reauthentication`, async () => {
    // A prior failed assertion must not contaminate the next page boundary.
    for (const row of await owned('display_tokens')) await tables.deleteRow({ databaseId, tableId: 'display_tokens', rowId: row.$id });
    try {
      for (let start = 0; start < count; start += 8) await Promise.all(Array.from({ length: Math.min(8, count - start) }, (_, offset) => put('display_tokens', id(`d${count}-${start + offset}`), { venueId: venueIds[0], active: true, tokenHash: digest, createdAt: now(), label: 'Audit regression' })));
      const route = kind === 'rotate' ? '/display/rotate' : `/hub/venues/${venueIds[0]}/${kind === 'revoke-all' ? 'displays/revoke-all' : 'revoke'}`;
      const result = await api(route, { method: 'POST', body: {}, headers: kind === 'rotate' ? staffHeaders(venueIds[0]) : hub });
      expectStatus(result, kind === 'rotate' ? 201 : 200);
      const active = await owned('display_tokens', venueIds[0], [Query.equal('active', [true])]);
      const remainingOld = active.filter(row => row.$id.startsWith(id(`d${count}-`))).length;
      const oldLink = await api('/auth/display', { method: 'POST', body: { tokenId: id(`d${count}-${count - 1}`), secret }, headers: { 'content-type': 'application/json' } });
      assert.equal(remainingOld, 0, 'every old display link must be revoked');
      expectStatus(oldLink, 401);
      assert.equal(active.length, kind === 'rotate' ? 1 : 0, 'only rotation may leave its new display link active');
      if (kind === 'revoke-all') assert.equal(result.data.revoked, count);
      return { requested: count, remainingOld, remainingActive: active.length, oldLinkStatus: oldLink.status };
    } finally {
      await update('venues', venueIds[0], { staffVersion: 1 });
      for (const row of await owned('display_tokens')) await tables.deleteRow({ databaseId, tableId: 'display_tokens', rowId: row.$id });
    }
  });
  await check('parallel_pairing_and_idempotent_retry', async () => {
    const body = await newPair('p1');
    const before = (await owned('display_tokens')).length;
    const calls = await Promise.all([api('/display/pairings/complete', { method: 'POST', body, headers: { 'content-type': 'application/json' } }), api('/display/pairings/complete', { method: 'POST', body, headers: { 'content-type': 'application/json' } })]);
    for (const result of calls) expectStatus(result, 200);
    assert.equal(calls[0].data.displayUrl, calls[1].data.displayUrl, 'parallel retries must share one URL');
    const retried = await api('/display/pairings/complete', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expectStatus(retried, 200); assert.equal(retried.data.displayUrl, calls[0].data.displayUrl, 'retry must return the existing URL');
    assert.equal((await owned('display_tokens')).length - before, 1, 'one QR must create one display token');
    return { parallelStatuses: calls.map(row => row.status), tokensCreated: 1, retryStatus: retried.status };
  });
  await check('competing_venues_cannot_reuse_pairing', async () => {
    const body = await newPair('p2');
    const calls = await Promise.all([api('/display/pairings/complete', { method: 'POST', body, headers: { 'content-type': 'application/json' } }), api('/display/pairings/complete', { method: 'POST', body: { ...body, venueCode: `audit-${config.runId}-${nonce}-2` }, headers: { 'content-type': 'application/json' } })]);
    const statuses = calls.map(row => row.status).sort();
    assert.deepEqual(statuses, [200, 409], 'one venue must win the QR claim');
    return { statuses };
  });
  await check('preseeded_interrupted_pairing_claim_recovers_without_duplicate', async () => {
    const body = await newPair('partialp');
    const pairingId = id('partialp');
    const tokenId = createHash('sha256').update(`pairing:${pairingId}`).digest('hex').slice(0, 32);
    const displaySecret = createHmac('sha256', config.sessionSecret).update(`pairing-display:${pairingId}:${secret}`).digest('base64url');
    const claimSalt = randomBytes(16);
    const tokenHash = `scrypt:${claimSalt.toString('base64url')}:${scryptSync(displaySecret, claimSalt, 64).toString('base64url')}`;
    // Seed the actual persisted state between token creation and pairing update.
    // This tests Appwrite's unique-row conflict and API recovery, not a server crash.
    await tables.createRow({ databaseId, tableId: 'display_tokens', rowId: tokenId, data: { venueId: venueIds[0], active: true, tokenHash, createdAt: now(), label: 'Audit interrupted claim' } });
    if (!knownRows.has('display_tokens')) knownRows.set('display_tokens', new Set());
    knownRows.get('display_tokens').add(tokenId);
    const before = (await owned('display_tokens')).length;
    const result = await api('/display/pairings/complete', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expectStatus(result, 200);
    assert.equal(result.data.displayUrl, `${config.origin}/#${tokenId}.${displaySecret}`, 'recovery must return the existing deterministic display claim');
    assert.equal((await owned('display_tokens')).length, before, 'recovery must not create another token');
    assert.equal((await get('display_pairings', pairingId)).status, 'complete');
    expectStatus(await api(`/hub/venues/${venueIds[0]}/displays/${tokenId}/revoke`, { method: 'POST', body: {}, headers: hub }), 200);
    const revokedRetry = await api('/display/pairings/complete', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expectStatus(revokedRetry, 409);
    assert.equal((await get('display_tokens', tokenId)).active, false);
    return { setup: 'preseeded_intermediate_state', completionStatus: result.status, tokenCountChange: 0, revokedRetryStatus: revokedRetry.status };
  });
  await check('atomic_stock_bounds_and_transition_statistics', async () => {
    await update('items', id('i1'), { stockQuantity: 0 });
    const before = (await owned('statistics_events', venueIds[0], [Query.equal('eventType', ['availability_changed'])])).length;
    const calls = await Promise.all([api(`/items/${id('i1')}/stock/adjust`, { method: 'POST', body: { delta: 1 } }), api(`/items/${id('i1')}/stock/adjust`, { method: 'POST', body: { delta: 1 } })]);
    for (const result of calls) expectStatus(result, 200);
    assert.equal(Number((await get('items', id('i1'))).stockQuantity), 2, 'two atomic increments must persist quantity two');
    const transitionCount = (await owned('statistics_events', venueIds[0], [Query.equal('eventType', ['availability_changed'])])).length - before;
    assert.equal(transitionCount, 1, 'one actual availability transition must produce one event');
    await update('items', id('i1'), { stockQuantity: 1 });
    const decrements = await Promise.all([api(`/items/${id('i1')}/stock/adjust`, { method: 'POST', body: { delta: -1 } }), api(`/items/${id('i1')}/stock/adjust`, { method: 'POST', body: { delta: -1 } })]);
    assert.deepEqual(decrements.map(row => row.status).sort(), [200, 409]);
    assert.equal(Number((await get('items', id('i1'))).stockQuantity), 0);
    await update('items', id('i1'), { stockQuantity: 2000000000 });
    expectStatus(await api(`/items/${id('i1')}/stock/adjust`, { method: 'POST', body: { delta: 1 } }), 409);
    return { atomicIncrements: calls.map(row => row.status), transitionCount, lowerBoundStatuses: decrements.map(row => row.status).sort(), upperBoundStatus: 409 };
  });
  await check('absolute_stock_and_adjust_share_transition_order', async () => {
    await update('items', id('i1'), { stockQuantity: 0 });
    const before = (await owned('statistics_events', venueIds[0], [Query.equal('eventType', ['availability_changed'])])).length;
    const calls = await Promise.all([api(`/items/${id('i1')}/stock/adjust`, { method: 'POST', body: { delta: 1 } }), api(`/items/${id('i1')}`, { method: 'PATCH', body: { stockQuantity: 2 } })]);
    for (const result of calls) expectStatus(result, 200);
    const transitions = (await owned('statistics_events', venueIds[0], [Query.equal('eventType', ['availability_changed'])])).length - before;
    assert.equal(transitions, 1);
    return { statuses: calls.map(row => row.status), transitionCount: transitions, finalQuantity: Number((await get('items', id('i1'))).stockQuantity) };
  });
  await check('moscow_day_epoch_and_cross_venue_statistics', async () => {
    for (const [index, createdAt] of ['2026-10-17T20:59:59.000Z', '2026-10-17T21:00:00.000Z', '2026-10-18T20:59:59.000Z', '2026-10-18T21:00:00.000Z'].entries()) await put('statistics_events', id(`e${index}`), { venueId: venueIds[0], eventType: 'item_updated', actor: 'audit-regression', createdAt });
    await put('statistics_events', id('eother'), { venueId: venueIds[1], eventType: 'item_updated', actor: 'audit-regression', createdAt: '2026-10-18T12:00:00.000Z' });
    const path = `/hub/venues/${venueIds[0]}/statistics?from=2026-10-18&to=2026-10-18`;
    const day = await api(path, { headers: hub }); expectStatus(day, 200); assert.equal(day.data.counts.menuChanges, 2);
    await put('statistics_events', id('reset'), { venueId: venueIds[0], eventType: 'statistics_reset', actor: 'audit-regression', createdAt: '2026-10-18T10:00:00.000Z' });
    const current = await api(path, { headers: hub }); expectStatus(current, 200); assert.equal(current.data.counts.menuChanges, 1);
    const previous = await api(path + '&epochId=initial', { headers: hub }); expectStatus(previous, 200); assert.equal(previous.data.counts.menuChanges, 1);
    return { moscowDayCount: 2, currentEpochCount: 1, archivedEpochCount: 1, crossVenue: 'excluded' };
  });
} catch (error) {
  report.fatal = `setup_or_guard_error_${Number(error.code) || 'unknown'}`;
} finally {
  if (mutationStarted) {
    try {
      await marker();
      let removed = 0;
      for (const tableId of ['staff_invites', 'display_pairings', 'display_tokens', 'client_logs', 'admin_audit_logs', 'statistics_events', 'items', 'categories', 'staff_accounts', 'venues']) {
        const candidates = new Map();
        if (tableId !== 'venues') for (const venueId of createdVenues) for (const row of await owned(tableId, venueId)) candidates.set(row.$id, row);
        for (const rowId of knownRows.get(tableId) ?? []) {
          try { candidates.set(rowId, await get(tableId, rowId)); } catch (error) { if (error.code !== 404) throw error; }
        }
        for (const row of candidates.values()) {
          if (tableId === 'venues' ? !createdVenues.has(row.$id) : row.venueId ? !createdVenues.has(row.venueId) : !knownRows.get(tableId)?.has(row.$id)) throw new Error('Cleanup ownership mismatch.');
          await tables.deleteRow({ databaseId, tableId, rowId: row.$id }); removed++;
        }
      }
      await verifyApiIdentity(fixture);
      report.cleanup = { passed: true, rowsRemoved: removed, seededFixtureRetained: true };
    } catch (error) { report.cleanup = { passed: false, failure: `cleanup_error_${Number(error.code) || 'unknown'}` }; }
  } else report.cleanup = { passed: true, rowsRemoved: 0 };
  report.finishedAt = now(); report.passed = !report.fatal && report.cleanup.passed && results.every(result => result.passed);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ event: 'appwrite_regressions_complete', phase: report.phase, passed: report.passed, checks: results.length, failures: results.filter(row => !row.passed).length, cleanup: report.cleanup, ...(report.fatal ? { fatal: report.fatal } : {}) }));
  if (!report.passed) process.exitCode = 1;
}
