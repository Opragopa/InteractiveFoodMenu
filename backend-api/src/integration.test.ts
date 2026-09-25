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
