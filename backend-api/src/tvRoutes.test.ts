import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "./server.js";
import { hashSecret } from "./security.js";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";

const config = {
  port: 0, publicUrl: "https://api.example.test", displayBaseUrl: "https://menu.example.test",
  appwriteEndpoint: "https://appwrite.example.test/v1", appwriteSelfSigned: false,
  appwriteProjectId: "project", appwriteApiKey: "a".repeat(32), appwriteDatabaseId: "database", appwriteBucketId: "bucket",
  sessionSecret: "s".repeat(32), hubAccessKey: "h".repeat(32), corsOrigins: [],
} satisfies BackendConfig;

test("old display link becomes a cookie session and revocation stops the menu", async () => {
  const id = "abcdefghijkl"; const secret = "q".repeat(32);
  const token = { $id: id, venueId: "venue-1", tokenHash: await hashSecret(secret), active: true };
  const venue = { $id: "venue-1", name: "Кафе", displayVersion: 1, menuVersion: 1, active: true };
  const rows: Record<string, Record<string, unknown>> = { [id]: token, "venue-1": venue };
  const tables = {
    getRow: async ({ rowId }: { rowId: string }) => rows[rowId] ?? Promise.reject(new Error("missing")),
    listRows: async ({ tableId }: { tableId: string }) => ({ rows: tableId === "categories" ? [{ $id: "cat", venueId: "venue-1", name: "Горячее" }] : tableId === "items" ? [{ $id: "item", venueId: "venue-1", categoryId: "cat", name: "Блюдо с длинным названием", priceMinor: 25000 }] : [], total: 0 }),
    updateRow: async () => ({}), createRow: async () => ({}),
  };
  const server = createServer(createApp(config, { client: {}, tables, storage: {} } as unknown as AppwriteServices));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const activate = await fetch(`${base}/tv/session`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https" }, body: JSON.stringify({ tokenId: id, secret }) });
    assert.equal(activate.status, 200);
    const setCookie = activate.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/);
    const sessionCookie = setCookie.split(";")[0];
    const menu = await fetch(`${base}/tv/menu?w=1366&h=768`, { headers: { cookie: sessionCookie } });
    assert.equal(menu.status, 200);
    const html = await menu.text();
    assert.match(html, /Блюдо с длинным названием/);
    assert.match(html, /\/tv\/events/);
    assert.doesNotMatch(html, /setInterval\(poll/);
    assert.doesNotMatch(html, new RegExp(secret));
    assert.doesNotMatch(html, /var\(--column-scale\)/);
    const state = await fetch(`${base}/tv/state`, { headers: { cookie: sessionCookie } });
    assert.equal(state.status, 200);
    token.active = false;
    const revoked = await fetch(`${base}/tv/state`, { headers: { cookie: sessionCookie } });
    assert.equal(revoked.status, 401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("QR pairing completes with a display cookie and no secret in the menu URL", async () => {
  const id = "abcdefghijkl"; const secret = "q".repeat(32);
  const rows: Record<string, Record<string, unknown>> = {
    [id]: { $id: id, venueId: "venue-1", tokenHash: await hashSecret(secret), active: true },
    "venue-1": { $id: "venue-1", name: "Кафе", displayVersion: 1, menuVersion: 1, active: true },
  };
  const tables = {
    getRow: async ({ rowId }: { rowId: string }) => rows[rowId] ?? Promise.reject(new Error("missing")),
    createRow: async ({ rowId, data }: { rowId: string; data: Record<string, unknown> }) => { rows[rowId] = { $id: rowId, ...data }; return rows[rowId]; },
    updateRow: async () => ({}),
    listRows: async () => ({ rows: [], total: 0 }),
  };
  const server = createServer(createApp(config, { client: {}, tables, storage: {} } as unknown as AppwriteServices));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(`${base}/tv/connect`, { headers: { "x-forwarded-proto": "https" } });
    assert.equal(page.status, 200);
    const pairingCookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
    const pairing = pairingCookie.split("=")[1];
    const pairId = pairing.split(".")[0];
    assert.match(await page.text(), /QR-код/);
    const pending = await fetch(`${base}/tv/connect/status`, { headers: { cookie: pairingCookie } });
    assert.deepEqual(await pending.json(), { status: "pending" });
    rows[pairId].status = "complete";
    rows[pairId].displayUrl = `${config.displayBaseUrl}/connect#${id}.${secret}`;
    const complete = await fetch(`${base}/tv/connect/status`, { headers: { cookie: pairingCookie, "x-forwarded-proto": "https" } });
    assert.equal(complete.status, 200);
    assert.deepEqual(await complete.json(), { status: "complete" });
    const cookie = (complete.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^ifm_tv_session=/);
    const menu = await fetch(`${base}/tv/menu?w=1920&h=1080`, { headers: { cookie } });
    assert.equal(menu.status, 200);
    assert.doesNotMatch(await menu.text(), new RegExp(secret));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
