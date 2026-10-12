import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { createApp } from "./server.js";
import { signSession } from "./security.js";
import { moscowDay, sanitizeDiagnostic, safeDiagnosticDetails, venueStatistics } from "./statistics.js";

test("Moscow calendar days reject invalid dates and cross UTC at 21:00", () => {
  assert.equal(new Date(moscowDay("2026-10-12")).toISOString(), "2026-10-11T21:00:00.000Z");
  assert.throws(() => moscowDay("2026-02-30"));
});

test("diagnostics remove secrets from messages and arbitrary detail fields", () => {
  const message = sanitizeDiagnostic("pin=123456 /display/legacy/abcdefghijkl.abcdabcdabcdabcdabcdabcdabcdabcd token=abc");
  assert.doesNotMatch(message, /123456|abcdefghijkl|token=abc/);
  const details = safeDiagnosticDetails({ token: "hidden", url: "https://example", path: "#abcdefghijkl.abcdabcdabcdabcdabcdabcdabcdabcd", retries: 2 });
  assert.doesNotMatch(details, /hidden|example|abcdefghijkl/);
  assert.match(details, /"retries":2/);
});

test("statistics isolate venue, period and successive reset epochs", async () => {
  const events = [
    { $id: "old", venueId: "v1", eventType: "item_created", createdAt: "2026-10-10T12:00:00.000Z" },
    { $id: "reset1", venueId: "v1", eventType: "statistics_reset", createdAt: "2026-10-11T00:00:00.000Z" },
    { $id: "middle", venueId: "v1", eventType: "stock_adjusted", createdAt: "2026-10-11T12:00:00.000Z" },
    { $id: "reset2", venueId: "v1", eventType: "statistics_reset", createdAt: "2026-10-12T00:00:00.000Z" },
    { $id: "current", venueId: "v1", eventType: "item_updated", createdAt: "2026-10-12T10:00:00.000Z" },
    { $id: "other", venueId: "v2", eventType: "item_updated", createdAt: "2026-10-12T10:00:00.000Z" },
  ];
  const logs = [
    { $id: "error", venueId: "v1", level: "error", createdAt: "2026-10-12T11:00:00.000Z" },
    { $id: "warning", venueId: "v1", level: "warn", createdAt: "2026-10-12T12:00:00.000Z" },
  ];
  const tables = { listRows: async ({ tableId, queries }: { tableId: string; queries: string[] }) => {
    let values: Record<string, unknown>[] = (tableId === "client_logs" ? logs : events).slice();
    const parsed = queries.map(value => JSON.parse(value) as { method: string; attribute?: string; values: unknown[] });
    for (const query of parsed) {
      if (query.method === "equal") values = values.filter(row => query.values.includes((row as Record<string, unknown>)[query.attribute!]));
      if (query.method === "greaterThanEqual") values = values.filter(row => String((row as Record<string, unknown>)[query.attribute!]) >= String(query.values[0]));
      if (query.method === "lessThan") values = values.filter(row => String((row as Record<string, unknown>)[query.attribute!]) < String(query.values[0]));
      if (query.method === "orderAsc") values.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    }
    const total = values.length;
    const offset = Number(parsed.find(query => query.method === "offset")?.values[0] ?? 0);
    const limit = Number(parsed.find(query => query.method === "limit")?.values[0] ?? 500);
    return { rows: values.slice(offset, offset + limit), total };
  } };
  const services = { tables } as unknown as AppwriteServices;
  const current = await venueStatistics(services, "db", "v1", "2026-10-10", "2026-10-12");
  assert.equal(current.epochId, "reset2");
  assert.equal(current.counts.menuChanges, 1);
  assert.equal(current.counts.stockChanges, 0);
  assert.equal(current.counts.errors, 1);
  const previous = await venueStatistics(services, "db", "v1", "2026-10-10", "2026-10-12", "reset1");
  assert.equal(previous.counts.stockChanges, 1);
  assert.equal(previous.counts.menuChanges, 0);
  const initial = await venueStatistics(services, "db", "v1", "2026-10-10", "2026-10-12", "initial");
  assert.equal(initial.counts.menuChanges, 1);
  await assert.rejects(() => venueStatistics(services, "db", "v1", "2026-10-12", "2026-10-10"));
});

test("only hub can read or reset a venue period", async () => {
  const config = { port: 0, publicUrl: "https://api.example.test", displayBaseUrl: "https://menu.example.test",
    appwriteEndpoint: "https://appwrite.example.test/v1", appwriteSelfSigned: false,
    appwriteProjectId: "project", appwriteApiKey: "a".repeat(32), appwriteDatabaseId: "database", appwriteBucketId: "bucket",
    sessionSecret: "s".repeat(32), hubAccessKey: "h".repeat(32), corsOrigins: [] } satisfies BackendConfig;
  const events: Array<Record<string, unknown>> = [];
  const tables = {
    getRow: async ({ rowId }: { rowId: string }) => rowId === "v1" || rowId === "v2" ? { $id: rowId } : Promise.reject(new Error("missing")),
    listRows: async ({ tableId, queries }: { tableId: string; queries: string[] }) => {
      const parsed = queries.map(value => JSON.parse(value) as { method: string; attribute?: string; values: unknown[] });
      let rows = tableId === "statistics_events" ? events.slice() : [];
      for (const query of parsed) {
        if (query.method === "equal") rows = rows.filter(row => query.values.includes(row[query.attribute!]));
        if (query.method === "greaterThanEqual") rows = rows.filter(row => String(row[query.attribute!]) >= String(query.values[0]));
        if (query.method === "lessThan") rows = rows.filter(row => String(row[query.attribute!]) < String(query.values[0]));
      }
      return { rows, total: rows.length };
    },
    createRow: async ({ rowId, data }: { rowId: string; data: Record<string, unknown> }) => { const row = { $id: rowId, ...data }; if (data.eventType) events.push(row); return row; },
  };
  const server = createServer(createApp(config, { client: {}, tables, storage: {} } as unknown as AppwriteServices));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const hub = { authorization: `Bearer ${signSession({ role: "hub" }, config.sessionSecret)}` };
  const staff = { authorization: `Bearer ${signSession({ role: "staff", venueId: "v1" }, config.sessionSecret)}` };
  try {
    assert.equal((await fetch(`${base}/api/hub/venues/v1/statistics?from=2026-10-01&to=2026-10-12`, { headers: staff })).status, 403);
    assert.equal((await fetch(`${base}/api/hub/venues/v1/statistics/reset`, { method: "POST", headers: staff })).status, 403);
    assert.equal((await fetch(`${base}/api/hub/venues/v1/statistics?from=2026-10-01&to=2026-10-12`, { headers: hub })).status, 200);
    const reset = await fetch(`${base}/api/hub/venues/v1/statistics/reset`, { method: "POST", headers: hub });
    assert.equal(reset.status, 201);
    const epochId = (await reset.json() as { epochId: string }).epochId;
    assert.ok(epochId);
    assert.equal(events.filter(event => event.venueId === "v1" && event.eventType === "statistics_reset").length, 1);
    const other = await fetch(`${base}/api/hub/venues/v2/statistics?from=2026-10-01&to=2026-10-12`, { headers: hub });
    assert.deepEqual((await other.json() as { epochs: Array<{ id: string }> }).epochs.map(epoch => epoch.id), ["initial"]);
    assert.equal((await fetch(`${base}/api/hub/venues/v1/statistics?from=2026-10-01&to=2027-11-01`, { headers: hub })).status, 400);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
