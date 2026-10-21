import { createHmac } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export function assertTestUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Expected a plain test HTTP(S) URL.');
  const host = url.hostname.toLowerCase();
  if (host === 'foodmenu.cloudopragopa.online' || host.endsWith('.foodmenu.cloudopragopa.online')) throw new Error('Production domains are blocked.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^172\.(1[6-9]|2\d|3[01])\./.test(host) && !host.endsWith('.test') && !host.endsWith('.localhost')) throw new Error('Only loopback, private LAN or reserved .test targets are allowed.');
  return url.toString().replace(/\/$/, '');
}
export async function externalPath(input, { existing = true } = {}) {
  const absolute = path.resolve(input ?? '');
  const resolved = existing ? await realpath(absolute) : path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) throw new Error('Secrets and run results must be outside the repository.');
  let directory = path.dirname(resolved);
  for (;;) {
    if (await access(path.join(directory, '.git')).then(() => true, () => false)) throw new Error('Secrets and results must be outside every Git repository.');
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  return resolved;
}
export async function loadJsonExternal(input) { const text = await readFile(await externalPath(input), 'utf8'); try { return JSON.parse(text); } catch { throw new Error('Invalid private JSON configuration; contents are not printed.'); } }
export function positiveNumber(value, name, min = 1, max = 100000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`Invalid ${name}.`);
  return number;
}
export function jwt(claims, secret, seconds = 24 * 3600) {
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ ...claims, iat: now, exp: now + seconds })}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}
export function args(argv = process.argv.slice(2)) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { result._.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    result[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return result;
}
export async function requestFull(base, route, { timeoutMs = 10000, method = 'GET', headers = {}, body, json = true, signal } = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let status = 0, ttfbMs = null, requestId = null;
  try {
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: controller.signal });
    status = response.status; ttfbMs = performance.now() - started; requestId = response.headers.get('x-request-id');
    const text = await response.text();
    let data;
    if (json && text) { try { data = JSON.parse(text); } catch { return { status, ok: false, error: 'invalid_json', durationMs: performance.now() - started, ttfbMs, bytes: Buffer.byteLength(text), requestId }; } }
    return { status, ok: response.ok, data: json ? data : text, durationMs: performance.now() - started, ttfbMs, bytes: Buffer.byteLength(text), requestId, error: response.ok ? null : `http_${status}` };
  } catch (error) {
    return { status, ok: false, error: controller.signal.aborted ? 'timeout_or_abort' : 'network_error', durationMs: performance.now() - started, ttfbMs, bytes: 0, requestId };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const percentile = (values, fraction) => values.length ? values.slice().sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
export function summarize(samples) {
  return { count: samples.length, failures: samples.filter(row => !row.ok).length, bytes: samples.reduce((n,row) => n + row.bytes, 0), statuses: samples.reduce((out,row) => { out[row.error ?? row.status] = (out[row.error ?? row.status] ?? 0) + 1; return out; }, {}), p50Ms: percentile(samples.map(row => row.durationMs), .5), p95Ms: percentile(samples.map(row => row.durationMs), .95), p99Ms: percentile(samples.map(row => row.durationMs), .99) };
}
export function fixtureGuard(fixture) {
  if (fixture.format !== 'ifm-audit-v1' || !/^[a-z0-9-]{3,16}$/.test(fixture.runId ?? '') || fixture.identity?.databaseId !== `ifm-audit-${fixture.runId}` || fixture.identity?.projectId !== `ifm-audit-${fixture.runId}`) throw new Error('Not an isolated audit fixture.');
  assertTestUrl(fixture.baseUrl); assertTestUrl(fixture.origin);
  if (!fixture.venueIds?.length || !fixture.hub?.cookie || !fixture.staff?.length || !fixture.screens?.length) throw new Error('Incomplete audit fixture.');
  return fixture;
}
export async function verifyApiIdentity(fixture, options = {}) {
  fixtureGuard(fixture);
  const result = await requestFull(fixture.baseUrl, '/api/hub/overview', { headers: { cookie: fixture.hub.cookie }, ...options });
  const expected = new Set(fixture.venueIds);
  const actual = result.data?.venues;
  if (!result.ok || !Array.isArray(actual) || actual.length !== expected.size || actual.some(row => !expected.has(row.id)) || !actual.some(row => row.id === fixture.markerVenueId && row.name === `AUDIT ${fixture.runId} 1`)) throw new Error('API identity mismatch; refusing test traffic.');
  return result;
}
