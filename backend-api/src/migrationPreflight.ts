import { Pool } from "pg";
import { Query } from "node-appwrite";
import { fileURLToPath } from "node:url";
import { createAppwriteServices, type AppwriteServices } from "./appwrite.js";
import { loadConfig } from "./config.js";
import { TABLES } from "./schema.js";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Read-only inventory; it does not assert that the source is frozen or backed up. */
export async function migrationPreflight(source: AppwriteServices, pool: Pool, databaseId: string, bucketId: string) {
  const tables: Record<string, number> = {};
  for (const table of TABLES) {
    const columns = await source.tables.listColumns({ databaseId, tableId: table.id, queries: [Query.limit(100)] });
    if (columns.total > columns.columns.length) throw new Error(`Incomplete column inventory: ${table.id}`);
    const known = new Set(table.columns.map(c => (c as { key: string }).key));
    if (columns.columns.some(c => !known.has(c.key))) throw new Error(`Unmapped source columns: ${table.id}`);
    for (const c of table.columns as { key: string; required?: boolean }[]) {
      if (c.required && !columns.columns.some(column => column.key === c.key)) throw new Error(`Missing required source column: ${table.id}/${c.key}`);
    }
    const page = await source.tables.listRows({ databaseId, tableId: table.id, queries: [Query.limit(1)], total: true });
    if (!Number.isSafeInteger(page.total) || page.total < 0) throw new Error(`Invalid source count: ${table.id}`);
    tables[table.id] = page.total;
  }
  let cursor: string | undefined, files = 0, bytes = 0, sourceFiles: number | undefined;
  for (;;) {
    const page = await source.storage.listFiles({ bucketId, queries: [Query.orderAsc("$id"), Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
    if (!Number.isSafeInteger(page.total) || page.total < 0) throw new Error("Invalid asset inventory count.");
    sourceFiles ??= page.total;
    if (sourceFiles !== page.total) throw new Error("Asset inventory changed during preflight.");
    for (const file of page.files) {
      if (!Number.isSafeInteger(file.sizeOriginal) || file.sizeOriginal < 0 || file.sizeOriginal > 10 * 1024 * 1024) throw new Error("Source asset exceeds the target storage limit.");
      files++; bytes += file.sizeOriginal;
    }
    if (page.files.length < 100) break;
    const next = page.files.at(-1)!.$id;
    if (cursor === next) throw new Error("Asset pagination did not advance.");
    cursor = next;
  }
  if (files !== sourceFiles) throw new Error("Incomplete asset inventory.");
  const client = await pool.connect();
  let target;
  try {
    await client.query("BEGIN READ ONLY");
    const version = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 180000 || version >= 190000) throw new Error("The prepared target must run PostgreSQL 18.");
    if ((await client.query("SHOW server_encoding")).rows[0].server_encoding !== "UTF8") throw new Error("Target must use UTF8.");
    const existing = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='ifm'");
    for (const row of existing.rows) {
      if ((await client.query(`SELECT 1 FROM ifm.${quote(row.tablename)} LIMIT 1`)).rowCount) throw new Error("Target contains data. Existing data will not be overwritten.");
    }
    target = { postgresMajor: 18, encoding: "UTF8", empty: true, existingTables: existing.rowCount };
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { format: "ifm-migration-preflight-v1", at: new Date().toISOString(), passed: true, source: { databaseId, bucketId, tables, files, bytes }, target,
    limitations: ["Live inventory is not a consistent backup or proof of a frozen source.", "Only application tables declared in schema.ts and the configured asset bucket are migrated.", "The actual import still verifies every row, file and supported relationship in a transaction."] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  if (process.env.DATABASE_PROVIDER && process.env.DATABASE_PROVIDER !== "appwrite") throw new Error("Preflight requires DATABASE_PROVIDER=appwrite for the source.");
  const config = loadConfig();
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  try { console.log(JSON.stringify(await migrationPreflight(createAppwriteServices(config), pool, config.appwriteDatabaseId, config.appwriteBucketId), null, 2)); }
  catch { console.error(JSON.stringify({ event: "migration_preflight_failed", note: "Source schema/assets or target readiness failed. No data was changed; check private diagnostics and connectivity." })); process.exitCode = 1; }
  finally { await pool.end(); }
}
