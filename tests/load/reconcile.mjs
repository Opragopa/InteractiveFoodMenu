import { itemState } from './mutation-state.mjs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { args, assertTestUrl, externalPath, fixtureGuard, loadJsonExternal, repoRoot, requestFull, verifyApiIdentity } from './lib.mjs';
import { compareSnapshots, eventTypes, groups, totals } from './reconcile-lib.mjs';

async function main() {
  const cli = args(), mode = cli._[0];
  if (!['snapshot', 'compare'].includes(mode) || !cli.output) throw new Error('Use snapshot --config FILE --output FILE --confirm-run RUN_ID; or compare --before FILE --after FILE --run DIR --output FILE.');
  const output = await externalPath(cli.output, { existing: false });
  if (mode === 'compare') {
    const before = await loadJsonExternal(cli.before), after = await loadJsonExternal(cli.after), run = await externalPath(cli.run);
    const summary = JSON.parse(await readFile(path.join(run, 'summary.json'), 'utf8'));
    if (summary.runId !== before.runId) throw new Error('Workload and snapshot runIds differ.');
    const requests = (await readFile(path.join(run, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const result = compareSnapshots(before, after, requests, summary);
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ event: 'audit_statistics_reconciled', runId: result.runId, passed: result.passed, coverage: result.coverage, evidenceErrors: result.evidenceErrors, counts: result.counts, stockChecks: result.stockChecks.length }));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  const config = await loadJsonExternal(cli.config), fixture = fixtureGuard(await loadJsonExternal(config.fixturePath));
  if (cli['confirm-run'] !== config.runId || fixture.runId !== config.runId) throw new Error('Run confirmation differs.');
  for (const name of ['projectId', 'databaseId', 'bucketId']) if (config.appwrite?.[name] !== `ifm-audit-${config.runId}`) throw new Error('Not an isolated audit project.');
  if (fixture.identity.projectId !== config.appwrite.projectId || fixture.identity.databaseId !== config.appwrite.databaseId || assertTestUrl(config.baseUrl) !== assertTestUrl(fixture.baseUrl)) throw new Error('Fixture and configuration differ.');
  assertTestUrl(config.appwrite.endpoint);
  await verifyApiIdentity(fixture);
  const require = createRequire(repoRoot + '/backend-api/package.json');
  const { Client, TablesDB, Query } = require('node-appwrite');
  const tables = new TablesDB(new Client().setEndpoint(config.appwrite.endpoint).setProject(config.appwrite.projectId).setKey(config.appwrite.apiKey).setSelfSigned(config.appwrite.selfSigned === true));
  const databaseId = config.appwrite.databaseId;
  // Every SDK read is bounded, without retrying or printing SDK request details.
  async function sdk(task) {
    let timer;
    try { return await Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Appwrite snapshot read timed out.')), 30000); })]); }
    finally { clearTimeout(timer); }
  }
  const moscowDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const seed = Date.parse(fixture.seededAt);
  if (!Number.isFinite(seed)) throw new Error('Fixture has no valid seed timestamp.');
  // A fixed window covers the complete seed and the two following test days;
  // it stays identical across snapshots even when a run crosses midnight.
  const period = { from: moscowDay(seed - 31 * 86400000), to: moscowDay(seed + 2 * 86400000) };
  const boundary = day => new Date(day + 'T00:00:00+03:00').toISOString();
  const start = boundary(period.from), end = new Date(Date.parse(boundary(period.to)) + 86400000).toISOString();
  const dateFilters = [Query.greaterThanEqual('createdAt', start), Query.lessThan('createdAt', end)];
  async function count(tableId, venueId, type) {
    const queries = [Query.equal('venueId', [venueId]), ...dateFilters, Query.limit(1)];
    if (type) queries.push(Query.equal(tableId === 'client_logs' ? 'level' : 'eventType', [type]));
    return (await sdk(() => tables.listRows({ databaseId, tableId, queries, total: true }))).total;
  }
  async function contacts(venueId) {
    const rows = []; let cursor;
    for (;;) {
      const page = await sdk(() => tables.listRows({ databaseId, tableId: 'statistics_events', queries: [Query.equal('venueId', [venueId]), Query.equal('eventType', ['display_seen']),
        Query.greaterThanEqual('createdAt', fixture.seededAt), Query.limit(500), ...(cursor ? [Query.cursorAfter(cursor)] : [])] }));
      rows.push(...page.rows);
      if (page.rows.length < 500) return rows;
      cursor = page.rows.at(-1).$id;
    }
  }
  const result = { format: 'ifm-audit-statistics-v1', runId: fixture.runId, identity: fixture.identity, period, captureStartedAt: new Date().toISOString(), capturedAt: null,
    quiescentRequired: true, mutationEvidenceVersion: 1, venues: [], stocks: {}, items: {}, contacts: { intervals: [], invalidRows: 0 }, apiEqualsSource: true };
  const knownScreens = new Set(fixture.screens.map(row => row.id));
  for (const venueId of fixture.venueIds) {
    if (await count('statistics_events', venueId, 'statistics_reset')) throw new Error('Snapshot requires audit venues without reset epochs.');
    const raw = {};
    for (let n = 0; n < eventTypes.length; n += 4) await Promise.all(eventTypes.slice(n, n + 4).map(async type => { raw[type] = await count('statistics_events', venueId, type); }));
    const source = Object.fromEntries(Object.entries(groups).map(([name, types]) => [name, types.reduce((sum, type) => sum + raw[type], 0)]));
    source.errors = await count('client_logs', venueId, 'error');
    const api = await requestFull(fixture.baseUrl, `/api/hub/venues/${encodeURIComponent(venueId)}/statistics?from=${period.from}&to=${period.to}`, { headers: { cookie: fixture.hub.cookie }, timeoutMs: 30000 });
    if (!api.ok || api.data?.venueId !== venueId || api.data?.epochId !== 'initial') throw new Error('Statistics API snapshot failed.');
    const matches = Object.entries(source).every(([key, value]) => api.data.counts[key] === value);
    result.apiEqualsSource &&= matches;
    const venueRow=await sdk(()=>tables.getRow({databaseId,tableId:'venues',rowId:venueId}));
    result.venues.push({ venueId, source, api: api.data.counts, raw, apiEqualsSource: matches, state:{breakActive:venueRow.breakActive===true} });
    for (const actor of fixture.staff.filter(row => row.venueId === venueId)) for(const itemId of [actor.itemId,actor.untrackedItemId]){const row=await sdk(()=>tables.getRow({databaseId,tableId:'items',rowId:itemId}));result.items[itemId]={venueId,...itemState({...row,id:row.$id})};if(itemId===actor.itemId)result.stocks[itemId]=row.stockQuantity;}
    for (const row of await contacts(venueId)) {
      let bucket = Math.floor(Date.parse(row.createdAt) / 900000);
      const expected = number => createHash('sha256').update(`${venueId}:${row.resourceId}:${number}`).digest('hex').slice(0, 32);
      // recordDisplayContact selects its bucket immediately before createdAt;
      // tolerate that one-millisecond UTC boundary without accepting duplicates.
      if (row.$id !== expected(bucket) && Date.parse(row.createdAt) % 900000 < 1000 && row.$id === expected(bucket - 1)) bucket--;
      if (row.$id !== expected(bucket) || !knownScreens.has(row.resourceId)) result.contacts.invalidRows++;
      result.contacts.intervals.push(`${venueId}/${row.resourceId}/${bucket}`);
    }
  }
  const contactSet = new Set(result.contacts.intervals);
  result.contacts.invalidRows += result.contacts.intervals.length - contactSet.size;
  result.contacts.intervals = [...contactSet].sort();
  result.sourceTotals = totals(result.venues, 'source'); result.apiTotals = totals(result.venues, 'api'); result.capturedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ event: 'audit_statistics_snapshot', runId: result.runId, apiEqualsSource: result.apiEqualsSource, sourceTotals: result.sourceTotals,
    distinctRuntimeScreenIntervals: result.contacts.intervals.length, invalidContactRows: result.contacts.invalidRows }));
  if (!result.apiEqualsSource || result.contacts.invalidRows) process.exitCode = 1;
}
main().catch(error => {
  // SDK exceptions may carry request metadata; never print those objects.
  console.error(JSON.stringify({ event: 'audit_reconciliation_failed', kind: error.name, message: error.name === 'AppwriteException' ? 'Appwrite read failed.' : error.message }));
  process.exitCode = 1;
  // Close any stalled SDK socket after the bounded error has been reported.
  setTimeout(() => process.exit(1), 100).unref();
});
