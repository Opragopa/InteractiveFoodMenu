import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp, } from "./server.js";
import { hashSecret } from "./security.js";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";

const config = {
  port: 0,
  publicUrl: "https://api.example.test",
  displayBaseUrl: "https://menu.example.test",
  appwriteEndpoint: "https://appwrite.example.test/v1",
  appwriteSelfSigned: false,
  appwriteProjectId: "project",
  appwriteApiKey: "a".repeat(32),
  appwriteDatabaseId: "database",
  appwriteBucketId: "bucket",
  sessionSecret: "s".repeat(32),
  hubAccessKey: "h".repeat(32),
  corsOrigins: ["https://menu.example.test"],
} satisfies BackendConfig;

test("API integration exposes health, CORS and staff login", async () => {
  const venue = { $id: "venue-1", code: "wintercafe123", pinHash: await hashSecret("123456"), staffVersion: 1, active: true };
  const tables = {
    listRows: async ({ tableId }: { tableId: string }) => tableId === "venues" ? { rows: [venue], total: 1 } : { rows: [], total: 0 },
    get: async () => ({}),
    getTable: async () => ({}),
  };
  const storage = { getBucket: async () => ({}) };
  const app = createApp(config, { client: {}, tables, storage } as unknown as AppwriteServices);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "interactive-food-menu-api" });

    const preflight = await fetch(`${baseUrl}/api/auth/staff`, {
      method: "OPTIONS",
      headers: { Origin: "https://menu.example.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://menu.example.test");

    const login = await fetch(`${baseUrl}/api/auth/staff`, {
      method: "POST",
      headers: { Origin: "https://menu.example.test", "content-type": "application/json" },
      body: JSON.stringify({ venueCode: "wintercafe123", pin: "123456" }),
    });
    assert.equal(login.status, 200);
    const payload = await login.json() as { token?: string; venueId?: string };
    assert.equal(payload.venueId, "venue-1");
    assert.ok(payload.token);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("stock controls availability, refuses negative stock and preserves legacy items", async () => {
  const venue: Record<string, unknown> = { $id: "venue-1", code: "wintercafe123", pinHash: await hashSecret("123456"), staffVersion: 1, displayVersion: 1, menuVersion: 1, active: true };
  const category = { $id: "cat-1", venueId: "venue-1", name: "Кофе", sortOrder: 0 };
  const tracked: Record<string, unknown> = { $id: "tracked", venueId: "venue-1", categoryId: "cat-1", name: "Чай", priceMinor: 10000, sortOrder: 0, isAvailable: true, stockQuantity: 1 };
  const legacy: Record<string, unknown> = { $id: "legacy", venueId: "venue-1", categoryId: "cat-1", name: "Кофе", priceMinor: 20000, sortOrder: 1, isAvailable: false };
  const rows: Record<string, Record<string, unknown>> = { "venue-1": venue, tracked, legacy };
  const tables = {
    listRows: async ({ tableId }: { tableId: string }) => ({ rows: tableId === "venues" ? [venue] : tableId === "categories" ? [category] : tableId === "items" ? [tracked, legacy] : [], total: 1 }),
    getRow: async ({ rowId }: { rowId: string }) => {
      if (rowId === "venue-1") {
        const snapshot = { ...rows[rowId] };
        await new Promise(resolve => setTimeout(resolve, 2));
        return snapshot;
      }
      return rows[rowId];
    },
    updateRow: async ({ rowId, data }: { rowId: string; data: Record<string, unknown> }) => Object.assign(rows[rowId], data),
    decrementRowColumn: async ({ rowId, value, min }: { rowId: string; value: number; min: number }) => {
      const row = rows[rowId];
      if (Number(row.stockQuantity) - value < min) throw new Error("minimum exceeded");
      row.stockQuantity = Number(row.stockQuantity) - value;
      return row;
    },
    incrementRowColumn: async ({ rowId, value }: { rowId: string; value: number }) => {
      const row = rows[rowId]; row.stockQuantity = Number(row.stockQuantity) + value; return row;
    },
  };
  const app = createApp(config, { client: {}, tables, storage: {} } as unknown as AppwriteServices);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  try {
    const login = await fetch(`${baseUrl}/auth/staff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ venueCode: "wintercafe123", pin: "123456" }) });
    const { token } = await login.json() as { token: string };
    const request = async (path: string, method = "GET", body?: object) => {
      const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, data: await response.json() as Record<string, any> };
    };
    let menu = await request("/menu");
    assert.equal(menu.data.items.find((item: { id: string }) => item.id === "legacy").isAvailable, false);
    assert.equal(menu.data.items.find((item: { id: string }) => item.id === "legacy").stockQuantity, undefined);
    assert.equal((await request("/items/legacy/stock/adjust", "POST", { delta: 1 })).status, 409);
    assert.equal((await request("/items/legacy", "PATCH", { isAvailable: true })).data.item.isAvailable, true);
    assert.equal((await request("/items/tracked/stock/adjust", "POST", { delta: -1 })).data.item.isAvailable, false);
    assert.equal(tracked.stockQuantity, 0);
    assert.equal((await request("/items/tracked/stock/adjust", "POST", { delta: -1 })).status, 409);
    assert.equal((await request("/items/tracked", "PATCH", { isAvailable: true })).status, 409);
    assert.equal((await request("/items/bulk-availability", "PATCH", { itemIds: ["tracked"], isAvailable: true })).status, 409);
    menu = await request("/menu");
    assert.equal(menu.data.items.find((item: { id: string }) => item.id === "tracked").isAvailable, false);
    assert.equal((await request("/items/tracked/stock/adjust", "POST", { delta: 1 })).data.item.isAvailable, true);
    assert.equal((await request("/items/legacy", "PATCH", { stockQuantity: 0 })).data.item.isAvailable, false);
    assert.equal((await request("/items/legacy", "PATCH", { stockQuantity: 2 })).data.item.isAvailable, true);
    assert.equal((await request("/items/legacy", "PATCH", { stockQuantity: null })).status, 400);
    const versionBeforeParallelUpdates = Number(venue.menuVersion);
    const parallel = await Promise.all([
      request("/items/tracked/stock/adjust", "POST", { delta: 1 }),
      request("/items/legacy/stock/adjust", "POST", { delta: 1 }),
    ]);
    assert.deepEqual(parallel.map(result => result.status), [200, 200]);
    assert.equal(Number(venue.menuVersion), versionBeforeParallelUpdates + 2);
    assert.ok(Number(venue.menuVersion) >= 5);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
