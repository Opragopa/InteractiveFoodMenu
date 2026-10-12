import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const base = String(process.env.LOAD_BASE_URL ?? "").replace(/\/$/, "");
const fixturePath = process.env.LOAD_FIXTURE;
if (!base || !fixturePath) throw new Error("Set LOAD_BASE_URL and LOAD_FIXTURE.");
const host = new URL(base).hostname;
if (host.endsWith("foodmenu.cloudopragopa.online")) throw new Error("The production domain is blocked. Use a separate staging installation.");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const screens = fixture.screens ?? [];
const venues = fixture.venueIds ?? [];
const staff = fixture.staff ?? [];
if (!process.env.LOAD_SMALL && (venues.length < 100 || screens.length < 500)) throw new Error("The fixture must include 100 venues and 500 screens; use LOAD_SMALL=1 for a harness check.");
const durationSeconds = Math.max(10, Number(process.env.LOAD_DURATION_SECONDS ?? 90));
const origin = String(fixture.origin ?? "");
if (!origin || new URL(origin).origin !== origin) throw new Error("Fixture origin must be a valid origin.");
const measurements = new Map();
let failures = 0;

function record(name, ms, status) {
  if (!measurements.has(name)) measurements.set(name, []);
  measurements.get(name).push(ms);
  if (status < 200 || status >= 300) failures++;
}
function percentile(rows, p) { return rows[Math.min(rows.length - 1, Math.floor((rows.length - 1) * p))] ?? 0; }
function cookie(response) { return (response.headers.get("set-cookie") ?? "").split(";")[0]; }
async function call(name, path, options = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${path}`, options);
    record(name, performance.now() - started, response.status);
    return response;
  } catch {
    record(name, performance.now() - started, 0);
    return null;
  }
}

async function login(path, body) {
  const response = await call("login", path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response?.ok || !cookie(response)) throw new Error(`Staging login failed for ${path}.`);
  return cookie(response);
}

const hubCookie = await login("/api/hub/login/password", fixture.hub);
let accountCount = 0;
for (const venueId of venues) {
  const response = await call("staff-list", `/api/hub/venues/${encodeURIComponent(venueId)}/staff`, { headers: { cookie: hubCookie } });
  if (!response?.ok) throw new Error("Could not verify staging staff count.");
  accountCount += (await response.json()).staff.length;
}
if (!process.env.LOAD_SMALL && accountCount < 1000) throw new Error(`Only ${accountCount} staff accounts are seeded; expected at least 1000.`);
const activeStaff = [];
for (const account of staff.slice(0, 5)) activeStaff.push({ ...account, cookie: await login("/api/auth/staff/password", account) });

const versions = new Map();
const started = performance.now();
const end = started + durationSeconds * 1000;
const inflight = new Set();
function schedule(task) { const promise = task().finally(() => inflight.delete(promise)); inflight.add(promise); }
let nextScreen = 0;
let nextMenu = started;
let nextHub = started;
let nextWrite = started + 20_000;

while (performance.now() < end) {
  const now = performance.now();
  // Evenly spread 500 screen polls over each 15-second interval.
  const target = Math.floor((now - started) * screens.length / 15_000);
  while (nextScreen <= target) {
    const screen = screens[nextScreen % screens.length];
    nextScreen++;
    schedule(async () => {
      const response = await call("tv-state", "/tv/state", { headers: { cookie: screen.cookie } });
      if (!response?.ok) return;
      const state = await response.json();
      const prior = versions.get(screen.cookie);
      if (prior === undefined || prior !== state.version) await call("tv-menu", `/tv/menu?w=${screen.width ?? 1920}&h=${screen.height ?? 1080}`, { headers: { cookie: screen.cookie } });
      versions.set(screen.cookie, state.version);
    });
  }
  if (now >= nextMenu && activeStaff.length) {
    const account = activeStaff[Math.floor((now - started) / 3000) % activeStaff.length];
    schedule(() => call("staff-menu", "/api/menu", { headers: { cookie: account.cookie } }));
    nextMenu += 3000;
  }
  if (now >= nextHub) {
    schedule(() => call("hub-statistics", `/api/hub/venues/${encodeURIComponent(venues[0])}/statistics`, { headers: { cookie: hubCookie } }));
    nextHub += 30_000;
  }
  if (now >= nextWrite && activeStaff[0]?.itemId) {
    const account = activeStaff[0];
    schedule(() => call("staff-write", `/api/items/${encodeURIComponent(account.itemId)}`, {
      method: "PATCH", headers: { cookie: account.cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ stockQuantity: account.stockQuantity }),
    }));
    nextWrite += 20_000;
  }
  await new Promise(resolve => setTimeout(resolve, 20));
}
await Promise.allSettled([...inflight]);
const report = { target: { venues: venues.length, screens: screens.length, staffAccounts: accountCount }, durationSeconds,
  failures, appwriteCallsFromApiLogs: "collect by requestId from API JSON logs", routes: Object.fromEntries([...measurements].map(([name, values]) => {
    values.sort((a, b) => a - b);
    return [name, { count: values.length, p50Ms: Math.round(percentile(values, .5)), p95Ms: Math.round(percentile(values, .95)), p99Ms: Math.round(percentile(values, .99)) }];
  })) };
console.log(JSON.stringify(report, null, 2));
if (failures) process.exitCode = 1;
