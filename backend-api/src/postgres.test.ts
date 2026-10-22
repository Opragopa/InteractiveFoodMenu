import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { Query } from "node-appwrite";
import { createPostgresServices, ensurePostgresSchema } from "./postgres.js";
import { migrateAppwrite } from "./migrateAppwrite.js";
import { migrationPreflight } from "./migrationPreflight.js";
import { TABLES } from "./schema.js";
import { createApp } from "./server.js";
import { signSession, hashSecret } from "./security.js";
import { menuEtag } from "./menuHash.js";
import type { BackendConfig } from "./config.js";
import type { AppwriteServices } from "./appwrite.js";

const adminUrl = process.env.TEST_POSTGRES_URL;
const now = "2026-10-14T08:00:00.000Z";
const venue = { name: "Тестовая столовая", code: "test-cafe", pinHash: "preserved-hash", currency: "RUB", backgroundColor: "#56965B", accentColor: "#FFFFFF", pageDurationSeconds: 10, displayScalePercent: 100, staffVersion: 1, displayVersion: 1, menuVersion: 1, active: true, updatedAt: now, updatedBy: "test" };

test("menu hash is deterministic and changes with menu data", () => {
  assert.equal(menuEtag({ b: 2, a: 1 }), menuEtag({ a: 1, b: 2 }));
  assert.notEqual(menuEtag({ stock: 2 }), menuEtag({ stock: 1 }));
});

test("PostgreSQL migration, atomic stock, pagination and cross-instance idle SSE", { skip: !adminUrl, timeout: 60000 }, async t => {
  const admin = new Pool({ connectionString: adminUrl });
  const database = `ifm_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(adminUrl!); url.pathname = `/${database}`;
  const config: BackendConfig = { databaseProvider: "postgres", databaseUrl: url.toString(), databasePoolSize: 6, port: 0, publicUrl: "http://localhost", displayBaseUrl: "http://localhost", appwriteEndpoint: "", appwriteSelfSigned: false, appwriteProjectId: "", appwriteApiKey: "", appwriteDatabaseId: "test", appwriteBucketId: "assets", sessionSecret: "s".repeat(32), hubAccessKey: "h".repeat(32), corsOrigins: [] };
  const first = await createPostgresServices(config), second = await createPostgresServices(config);
  const pool = first.pool!;
  const category = { $id: "category-1", $createdAt: now, $updatedAt: now, venueId: "venue-1", name: "Горячее", sortOrder: 0, updatedAt: now, updatedBy: "test" };
  const item = { $id: "item-1", $createdAt: now, $updatedAt: now, venueId: "venue-1", categoryId: "category-1", name: "Суп", priceMinor: 10000, sortOrder: 0, isAvailable: true, stockQuantity: 5, updatedAt: now, updatedBy: "test" };
  const sourceRows: Record<string, any[]> = { venues: [{ $id: "venue-1", $createdAt: now, $updatedAt: now, ...venue, pinHash: await hashSecret("123456"), logoFileId: "logo-1" }], categories: [category], items: [item], operators: [{ $id: "operator-1", $createdAt: now, $updatedAt: now, username: "testuser", passwordHash: "argon2-hash-preserved", active: true, sessionVersion: 1, createdAt: now }] };
  const source = { tables: {
    listColumns: async ({ tableId }: { tableId: string }) => { const columns = TABLES.find(t => t.id === tableId)!.columns; return { columns, total: columns.length }; },
    listRows: async ({ tableId }: { tableId: string }) => ({ rows: sourceRows[tableId] ?? [], total: sourceRows[tableId]?.length ?? 0 }),
  }, storage: { listFiles: async () => ({ total: 1, files: [{ $id: "logo-1", name: "logo.png", mimeType: "image/png", sizeOriginal: 3 }] }), getFileDownload: async () => Buffer.from([1, 2, 3]) } } as unknown as AppwriteServices;
  try {
    await t.test("read-only preflight inventories source and refuses unmapped columns", async () => {
      const report = await migrationPreflight(source, pool, "source", "assets");
      assert.equal(report.passed, true); assert.equal(report.source.tables.venues, 1); assert.equal(report.source.files, 1); assert.equal(report.target.empty, true);
      assert.equal((await pool.query("SELECT to_regclass('ifm.venues') AS target")).rows[0].target, null, "preflight must not create the target schema");
      const bad = { ...source, tables: { ...source.tables, listColumns: async () => ({ total: 1, columns: [{ key: "unknown" }] }) } } as unknown as AppwriteServices;
      await assert.rejects(migrationPreflight(bad, pool, "source", "assets"), /Unmapped source columns/);
    });
    await t.test("migration verifies rows and assets, refuses overwrite", async () => {
      const report = await migrateAppwrite(source, pool, "source", "assets");
      assert.equal(report.venues.rows, 1); assert.equal(report.assets.rows, 1);
      assert.equal((await first.tables.getRow({ databaseId: "test", tableId: "operators", rowId: "operator-1" })).passwordHash, "argon2-hash-preserved");
      assert.deepEqual(await first.storage.getFileDownload({ bucketId: "assets", fileId: "logo-1" }), Buffer.from([1, 2, 3]));
      await assert.rejects(migrateAppwrite(source, pool, "source", "assets"), /not empty/);
      await assert.rejects(migrationPreflight(source, pool, "source", "assets"), /Target contains data/);
      await ensurePostgresSchema(pool); // bootstrap is idempotent
    });
    await t.test("SQL uniqueness, stable keyset paging and bounded concurrent stock", async () => {
      await assert.rejects(first.tables.createRow({ databaseId: "test", tableId: "venues", rowId: "duplicate", data: venue }), (e: any) => e.code === 409);
      for (let i = 0; i < 7; i++) await first.tables.createRow({ databaseId: "test", tableId: "categories", rowId: `page-${i}`, data: { ...category, $id: undefined, $createdAt: undefined, $updatedAt: undefined, sortOrder: Math.floor(i / 2) } });
      let cursor: string | undefined; const seen: string[] = [];
      for (;;) {
        const result = await first.tables.listRows({ databaseId: "test", tableId: "categories", queries: [Query.orderDesc("sortOrder"), Query.limit(2), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
        seen.push(...result.rows.map(row => row.$id)); if (result.rows.length < 2) break; cursor = result.rows.at(-1)!.$id;
      }
      assert.equal(seen.length, 8); assert.equal(new Set(seen).size, 8);
      const results = await Promise.allSettled(Array.from({ length: 15 }, (_, i) => (i % 2 ? first : second).tables.decrementRowColumn({ databaseId: "test", tableId: "items", rowId: "item-1", column: "stockQuantity", value: 1, min: 0 })));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 5);
      assert.equal((await first.tables.getRow({ databaseId: "test", tableId: "items", rowId: "item-1" })).stockQuantity, 0);
      await Promise.all(Array.from({ length: 15 }, (_, i) => (i % 2 ? first : second).tables.incrementRowColumn({ databaseId: "test", tableId: "venues", rowId: "venue-1", column: "menuVersion", value: 1 })));
      assert.equal((await first.tables.getRow({ databaseId: "test", tableId: "venues", rowId: "venue-1" })).menuVersion, 16);
      await assert.rejects(first.tables.listRows({ databaseId: "test", tableId: "venues", queries: [Query.equal('code"; DROP TABLE venues; --', ["x"])] }), /Unknown column/);
    });
    await t.test("ETag, API writes, push from another instance and zero idle queries", async () => {
      await first.tables.createRow({ databaseId: "test", tableId: "display_tokens", rowId: "display-token-1", data: { venueId: "venue-1", tokenHash: "unused", active: true, createdAt: now } });
      await sleep(150);
      let reads = 0;
      const originalQuery = pool.query;
      pool.query = function (this: Pool, ...args: any[]) { reads++; return (originalQuery as any).apply(this, args); } as typeof pool.query;
      const server = createServer(createApp(config, first));
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const base = `http://127.0.0.1:${address.port}/api`;
      const token = signSession({ role: "display", venueId: "venue-1", displayTokenId: "display-token-1", version: 1 }, config.sessionSecret);
      const headers = { authorization: `Bearer ${token}` };
      const controller = new AbortController();
      try {
        const menu = await fetch(`${base}/menu`, { headers }); assert.equal(menu.status, 200);
        const etag = menu.headers.get("etag")!; assert.match(etag, /^"[a-f0-9]{64}"$/);
        assert.equal((await fetch(`${base}/menu`, { headers: { ...headers, "if-none-match": etag } })).status, 304);
        const stream = await fetch(`${base}/menu/events`, { headers, signal: controller.signal }); assert.equal(stream.status, 200);
        const reader = stream.body!.getReader();
        const firstEvent = new TextDecoder().decode((await reader.read()).value); assert.match(firstEvent, /"version":16/);
        const before = reads;
        await sleep(26000); // includes a transport heartbeat at 25 seconds
        assert.equal(reads, before, "no database access during idle, including heartbeat");
        const heartbeat = new TextDecoder().decode((await reader.read()).value); assert.match(heartbeat, /keep-alive/);
        await second.tables.incrementRowColumn({ databaseId: "test", tableId: "venues", rowId: "venue-1", column: "menuVersion", value: 1 });
        const update = new TextDecoder().decode((await reader.read()).value); assert.match(update, /"version":17/);
        await second.tables.updateRow({ databaseId: "test", tableId: "display_tokens", rowId: "display-token-1", data: { active: false } });
        const revoked = new TextDecoder().decode((await reader.read()).value); assert.match(revoked, /"revoked":true/);
        assert.equal((await fetch(`${base}/menu`, { headers: { ...headers, "if-none-match": etag } })).status, 401);
      } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });
    await t.test("failed migration rolls back every imported row", async () => {
      for (const table of ["venues", "categories", "items", "operators", "display_tokens", "statistics_events", "assets"]) await pool.query(`TRUNCATE ifm."${table}"`);
      const bad = { ...source, storage: { ...source.storage, getFileDownload: async () => Buffer.from([9]) } } as unknown as AppwriteServices;
      await assert.rejects(migrateAppwrite(bad, pool, "source", "assets"), /size mismatch/);
      assert.equal((await pool.query("SELECT count(*)::int n FROM ifm.venues")).rows[0].n, 0);
    });
    await t.test("truncated source pages and missing item images roll back the import", async () => {
      const truncated = { ...source, tables: { ...source.tables, listRows: async () => ({ rows: [], total: 1 }) } } as unknown as AppwriteServices;
      await assert.rejects(migrateAppwrite(truncated, pool, "source", "assets"), /Count mismatch/);
      sourceRows.items[0].imageFileId = "missing-image";
      try { await assert.rejects(migrateAppwrite(source, pool, "source", "assets"), /Missing item image/); }
      finally { delete sourceRows.items[0].imageFileId; }
      assert.equal((await pool.query("SELECT count(*)::int n FROM ifm.operators")).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int n FROM ifm.assets")).rows[0].n, 0);
    });
  } finally {
    await first.close!(); await second.close!();
    await admin.query(`DROP DATABASE "${database}"`); await admin.end();
  }
});
