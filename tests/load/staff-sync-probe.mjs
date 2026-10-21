import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, externalPath, fixtureGuard, loadJsonExternal, positiveNumber, requestFull, summarize, verifyApiIdentity } from './lib.mjs';

export async function probeStaffSync(fixture, { durationSeconds = 120, intervalMs = 5000, timeoutMs = 10000, signal } = {}) {
  await verifyApiIdentity(fixture, { timeoutMs, signal });
  const requests = [], startedAt = new Date().toISOString(), started = performance.now(), end = started + durationSeconds * 1000;
  const wait = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  async function call(actor, route, name) {
    const result = await requestFull(fixture.baseUrl, route, { headers: { cookie: actor.cookie }, timeoutMs, signal });
    if (result.ok && (name === 'staff-version' ? !Number.isFinite(result.data?.version) : result.data?.venue?.id !== actor.venueId || !Array.isArray(result.data?.items))) {
      result.ok = false; result.error = 'invalid_payload';
    }
    requests.push({ at: new Date().toISOString(), route: name, status: result.status, ok: result.ok, error: result.error, durationMs: result.durationMs, ttfbMs: result.ttfbMs, bytes: result.bytes, requestId: result.requestId });
    return result;
  }
  await Promise.all(fixture.staff.map(async (actor, index) => {
    await wait(index / fixture.staff.length * intervalMs);
    if (signal?.aborted || performance.now() >= end) return;
    const menu = await call(actor, '/api/menu', 'staff-menu');
    let version = menu.ok ? Number(menu.data.venue.menuVersion ?? 1) : null;
    let next = performance.now() + intervalMs;
    while (!signal?.aborted && next < end) {
      await wait(next - performance.now());
      if (signal?.aborted) break;
      const current = await call(actor, '/api/menu/version', 'staff-version');
      if (current.ok && current.data.version !== version) {
        const updated = await call(actor, '/api/menu', 'staff-menu');
        if (updated.ok) version = Number(updated.data.venue.menuVersion ?? 1);
      }
      next = performance.now() + intervalMs;
    }
  }));
  const versions = requests.filter(row => row.route === 'staff-version');
  const stats = summarize(versions);
  return { format: 'ifm-staff-sync-supplement-v1', runId: fixture.runId, startedAt, endedAt: new Date().toISOString(), durationSeconds, staffCount: fixture.staff.length, intervalMs,
    mode: 'Candidate foreground staff sync supplement. Excluded from frozen baseline/candidate comparison.', requests,
    versionSummary: stats, totalSummary: summarize(requests), passed: !signal?.aborted && versions.length > 0 && requests.every(row => row.ok) && stats.p95Ms <= 500 };
}
async function main() {
  const cli = args();
  if (!cli.fixture || !cli.output || !cli['allow-load']) throw new Error('Use --fixture FILE --output NEW_EXTERNAL_DIR --allow-load --confirm-run RUN_ID [--duration-seconds 120].');
  const fixture = fixtureGuard(await loadJsonExternal(cli.fixture));
  if (cli['confirm-run'] !== fixture.runId) throw new Error('Run confirmation differs.');
  const output = await externalPath(cli.output, { existing: false });
  await mkdir(output, { recursive: false, mode: 0o700 });
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort()); process.on('SIGTERM', () => controller.abort());
  const result = await probeStaffSync(fixture, { durationSeconds: positiveNumber(cli['duration-seconds'] ?? 120, 'duration-seconds', 10, 3600), signal: controller.signal });
  const { requests, ...summary } = result;
  await writeFile(path.join(output, 'requests.jsonl'), requests.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ event: 'staff_sync_supplement_complete', runId: fixture.runId, passed: result.passed, versionRequests: result.versionSummary.count, p95Ms: result.versionSummary.p95Ms }));
  if (!result.passed) process.exitCode = 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => { console.error(JSON.stringify({ event: 'staff_sync_supplement_failed' })); process.exitCode = 1; });
