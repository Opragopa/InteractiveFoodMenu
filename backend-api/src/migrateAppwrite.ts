import { Pool } from "pg";
import { Query } from "node-appwrite";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createAppwriteServices, type AppwriteServices } from "./appwrite.js";
import { loadConfig } from "./config.js";
import { TABLES } from "./schema.js";
import { canonicalJson } from "./menuHash.js";
import { ensurePostgresSchema } from "./postgres.js";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
// Source must be quiesced for the entire export: Appwrite has no cross-table snapshot API.
// Target must be empty. One transaction commits ALL rows and assets or none of them.
export async function migrateAppwrite(source: AppwriteServices, pool: Pool, databaseId: string, bucketId: string) {
  await ensurePostgresSchema(pool);
  const client = await pool.connect();
  const report: Record<string, { rows: number; sha256: string }> = {};
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(18473291)");
    await client.query(`LOCK TABLE ${[...TABLES.map(t => `ifm.${quote(t.id)}`), "ifm.assets"].join(",")} IN ACCESS EXCLUSIVE MODE`);
    for (const table of [...TABLES.map(t => t.id), "assets"]) {
      if ((await client.query(`SELECT 1 FROM ifm.${quote(table)} LIMIT 1`)).rowCount) throw new Error(`Target is not empty: ${table}. Use an empty database; existing data is never overwritten.`);
    }
    for (const table of TABLES) {
      let cursor: string | undefined, count = 0, sourceCount: number | undefined;
      const digest = createHash("sha256");
      const allowed = new Set(["$id", "$createdAt", "$updatedAt", ...table.columns.map(c => (c as { key: string }).key)]);
      for (;;) {
        const page = await source.tables.listRows({ databaseId, tableId: table.id, total: true, queries: [Query.orderAsc("$id"), Query.limit(500), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
        if (!Number.isSafeInteger(page.total) || page.total < 0) throw new Error(`Invalid source count: ${table.id}`);
        sourceCount ??= page.total;
        if (sourceCount !== page.total) throw new Error(`Source changed during migration: ${table.id}`);
        for (const row of page.rows) {
          const unknown = Object.keys(row).filter(key => !key.startsWith("$") && !allowed.has(key));
          if (unknown.length) throw new Error(`Unmapped source columns in ${table.id}: ${unknown.join(",")}`);
          const entries = Object.entries(row).filter(([key, value]) => allowed.has(key) && value !== undefined);
          const result = await client.query(`INSERT INTO ifm.${quote(table.id)} (${entries.map(([key]) => quote(key)).join(",")}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, entries.map(([, value]) => value));
          // Compare every source field after SQL type conversion, including IDs and password hashes.
          const original = Object.fromEntries(entries.map(([key, value]) => [key, value === undefined ? null : value]));
          const stored = Object.fromEntries(entries.map(([key]) => [key, result.rows[0][key] instanceof Date ? result.rows[0][key].toISOString() : result.rows[0][key]]));
          const normalize = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([key, val]) => [key, (key === "$createdAt" || key === "$updatedAt" || table.columns.some(c => (c as any).key === key && (c as any).type === "datetime")) && val ? new Date(String(val)).toISOString() : val]));
          if (canonicalJson(normalize(original)) !== canonicalJson(normalize(stored))) throw new Error(`Verification failed: ${table.id}/${row.$id}`);
          digest.update(canonicalJson(normalize(stored)) + "\n"); count++;
        }
        if (page.rows.length < 500) break;
        cursor = page.rows[page.rows.length - 1].$id;
      }
      const targetCount = Number((await client.query(`SELECT count(*) AS n FROM ifm.${quote(table.id)}`)).rows[0].n);
      if (targetCount !== count || count !== sourceCount) throw new Error(`Count mismatch: ${table.id}`);
      report[table.id] = { rows: count, sha256: digest.digest("hex") };
    }
    let cursor: string | undefined, count = 0, sourceFiles: number | undefined;
    const digest = createHash("sha256");
    for (;;) {
      const page = await source.storage.listFiles({ bucketId, queries: [Query.orderAsc("$id"), Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
      if (!Number.isSafeInteger(page.total) || page.total < 0) throw new Error("Invalid source asset count");
      sourceFiles ??= page.total;
      if (sourceFiles !== page.total) throw new Error("Source assets changed during migration");
      for (const file of page.files) {
        const content = Buffer.from(await source.storage.getFileDownload({ bucketId, fileId: file.$id }));
        if (content.length !== file.sizeOriginal) throw new Error(`Asset size mismatch: ${file.$id}`);
        await client.query("INSERT INTO ifm.assets (id,name,mime_type,content) VALUES ($1,$2,$3,$4)", [file.$id, file.name, file.mimeType, content]);
        const restored = (await client.query("SELECT content FROM ifm.assets WHERE id=$1", [file.$id])).rows[0].content as Buffer;
        if (!restored.equals(content)) throw new Error(`Asset verification failed: ${file.$id}`);
        digest.update(file.$id).update(content); count++;
      }
      if (page.files.length < 100) break;
      cursor = page.files[page.files.length - 1].$id;
    }
    if (count !== sourceFiles) throw new Error("Asset count mismatch");
    report.assets = { rows: count, sha256: digest.digest("hex") };
    // Reject broken menu relationships before committing the imported database.
    for (const table of ["categories", "items", "display_tokens", "staff_accounts", "staff_invites"]) {
      const invalid = await client.query(`SELECT 1 FROM ifm.${quote(table)} r LEFT JOIN ifm.venues v ON v."$id"=r."venueId" WHERE v."$id" IS NULL LIMIT 1`);
      if (invalid.rowCount) throw new Error(`Orphaned venue reference in ${table}`);
    }
    if ((await client.query('SELECT 1 FROM ifm.items i LEFT JOIN ifm.categories c ON c."$id"=i."categoryId" AND c."venueId"=i."venueId" WHERE c."$id" IS NULL LIMIT 1')).rowCount) throw new Error("Orphaned category reference");
    if ((await client.query('SELECT 1 FROM ifm.venues v LEFT JOIN ifm.assets a ON a.id=v."logoFileId" WHERE v."logoFileId" IS NOT NULL AND v."logoFileId" <> \'\' AND a.id IS NULL LIMIT 1')).rowCount) throw new Error("Missing venue logo");
    if ((await client.query('SELECT 1 FROM ifm.items i LEFT JOIN ifm.assets a ON a.id=i."imageFileId" WHERE i."imageFileId" IS NOT NULL AND i."imageFileId" <> \'\' AND a.id IS NULL LIMIT 1')).rowCount) throw new Error("Missing item image");
    await client.query("COMMIT");
    return report;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--source-frozen")) throw new Error("Stop ALL writers to Appwrite, back up the source, then pass --source-frozen. The target must be empty.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const config = loadConfig();
  if (!config.appwriteEndpoint || !config.appwriteApiKey) throw new Error("Run migration with DATABASE_PROVIDER=appwrite and valid Appwrite credentials");
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  try { console.log(JSON.stringify(await migrateAppwrite(createAppwriteServices(config), pool, config.appwriteDatabaseId, config.appwriteBucketId), null, 2)); }
  finally { await pool.end(); }
}
