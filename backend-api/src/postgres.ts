import { Pool, type PoolClient } from "pg";
import { AppwriteException, type Models } from "node-appwrite";
import type { InputFile } from "node-appwrite/file";
import { TABLES } from "./schema.js";
import type { BackendConfig } from "./config.js";
import type { AppwriteServices } from "./appwrite.js";
import { MenuEvents } from "./menuEvents.js";

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tableName = (id: string) => {
  if (!TABLES.some(table => table.id === id)) throw new Error("Unknown table");
  return `ifm.${ident(id)}`;
};
function column(table: string, key: string) {
  if (!["$id", "$createdAt", "$updatedAt", ...TABLES.find(t => t.id === table)!.columns.map(c => (c as { key: string }).key)].includes(key)) throw new Error("Unknown column");
  return ident(key);
}
function rowData(row: Record<string, unknown>, databaseId: string, tableId: string) {
  return { ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])), $databaseId: databaseId, $tableId: tableId, $permissions: [] } as unknown as Models.Row;
}
function dbError(error: unknown): never {
  if ((error as { code?: string }).code === "23505") throw new AppwriteException("Duplicate row", 409);
  throw error;
}
export async function ensurePostgresSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(18473291)");
    await client.query("CREATE SCHEMA IF NOT EXISTS ifm");
    for (const table of TABLES) {
      const columns = table.columns.map(definition => {
        const c = definition as { key: string; type: string; size?: number; required?: boolean; min?: number; max?: number; elements?: string[] };
        const key = ident(c.key);
        const type = c.type === "integer" ? "integer" : c.type === "boolean" ? "boolean" : c.type === "datetime" ? "timestamptz" : c.type === "varchar" ? `varchar(${c.size})` : "text";
        const constraints = [c.min === undefined ? "" : `CHECK (${key} >= ${c.min})`, c.max === undefined ? "" : `CHECK (${key} <= ${c.max})`, c.elements ? `CHECK (${key} IN (${c.elements.map(v => `'${v.replaceAll("'", "''")}'`).join(",")}))` : ""].join(" ");
        return `${key} ${type}${c.required ? " NOT NULL" : ""} ${constraints}`;
      });
      await client.query(`CREATE TABLE IF NOT EXISTS ${tableName(table.id)} ("$id" varchar(40) PRIMARY KEY, "$createdAt" timestamptz NOT NULL DEFAULT now(), "$updatedAt" timestamptz NOT NULL DEFAULT now(), ${columns.join(",")})`);
      for (const definition of table.indexes) {
        const index = definition as { key: string; type: string; attributes: string[] };
        await client.query(`CREATE ${index.type === "unique" ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${ident(index.key)} ON ${tableName(table.id)} (${index.attributes.map(ident).join(",")})`);
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ifm.assets (id varchar(40) PRIMARY KEY, name text NOT NULL, mime_type text NOT NULL, content bytea NOT NULL CHECK (octet_length(content) <= 10485760))`);
    // Notifications commit atomically with writes, including writes made outside this API.
    await client.query(`CREATE OR REPLACE FUNCTION ifm.menu_changed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v text; n jsonb := to_jsonb(NEW); o jsonb := to_jsonb(OLD);
      BEGIN
        IF TG_OP = 'UPDATE' AND (n - '$updatedAt') IS NOT DISTINCT FROM (o - '$updatedAt') THEN RETURN NEW; END IF;
        IF TG_TABLE_NAME = 'venues' THEN v := COALESCE(n->>'$id', o->>'$id');
        ELSE v := COALESCE(n->>'venueId', o->>'venueId'); END IF;
        IF TG_TABLE_NAME = 'display_tokens' AND TG_OP = 'UPDATE' THEN
          IF n->'active' IS NOT DISTINCT FROM o->'active' AND n->'venueId' IS NOT DISTINCT FROM o->'venueId' THEN RETURN NEW; END IF;
        END IF;
        PERFORM pg_notify('ifm_menu_changed', v);
        RETURN COALESCE(NEW, OLD);
      END $$`);
    for (const table of ["venues", "categories", "items", "display_tokens"]) {
      await client.query(`CREATE OR REPLACE TRIGGER menu_changed AFTER INSERT OR UPDATE OR DELETE ON ${tableName(table)} FOR EACH ROW EXECUTE FUNCTION ifm.menu_changed()`);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

type Args = { databaseId: string; tableId: string; rowId?: string; queries?: string[]; total?: boolean; data?: object; column?: string; value?: number; min?: number; max?: number };
export class PostgresTables {
  constructor(readonly pool: Pool, private events?: MenuEvents) {}
  private changed(tableId: string, row: Record<string, unknown>, data?: object) {
    if (!["venues", "categories", "items", "display_tokens"].includes(tableId)) return;
    if (tableId === "display_tokens" && data && !("active" in data)) return;
    this.events?.publish(String(tableId === "venues" ? row.$id : row.venueId));
  }
  async get(_args: { databaseId: string }) { await this.pool.query("SELECT 1"); return {}; }
  async getTable({ tableId }: { databaseId: string; tableId: string }) { await this.pool.query(`SELECT 1 FROM ${tableName(tableId)} LIMIT 0`); return {}; }
  async getRow<T extends Models.Row = Models.DefaultRow>(args: Args): Promise<T> {
    const result = await this.pool.query(`SELECT * FROM ${tableName(args.tableId)} WHERE "$id"=$1`, [args.rowId]);
    if (!result.rows[0]) throw new AppwriteException("Row not found", 404);
    return rowData(result.rows[0], args.databaseId, args.tableId) as T;
  }
  async listRows<T extends Models.Row = Models.DefaultRow>(args: Args): Promise<{ rows: T[]; total: number }> {
    const values: unknown[] = [];
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const filters: string[] = [];
    const order: { key: string; direction: string }[] = [];
    let limit = 25, offset = 0, cursor: string | undefined;
    for (const raw of args.queries ?? []) {
      const q = JSON.parse(raw) as { method: string; attribute: string; values: unknown[] };
      switch (q.method) {
        case "limit": limit = Number(q.values[0]); break;
        case "offset": offset = Number(q.values[0]); break;
        case "cursorAfter": cursor = String(q.values[0]); break;
        case "orderAsc": case "orderDesc": order.push({ key: q.attribute, direction: q.method === "orderAsc" ? "ASC" : "DESC" }); break;
        case "equal": filters.push(q.values.length ? `(${q.values.map(value => value === null ? `${column(args.tableId, q.attribute)} IS NULL` : `${column(args.tableId, q.attribute)} = ${bind(value)}`).join(" OR ")})` : "FALSE"); break;
        case "greaterThanEqual": case "lessThan": filters.push(`${column(args.tableId, q.attribute)} ${q.method === "lessThan" ? "<" : ">="} ${bind(q.values[0])}`); break;
        default: throw new Error(`Unsupported query: ${q.method}`);
      }
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid page size");
    if (!order.some(o => o.key === "$id")) order.push({ key: "$id", direction: "ASC" });
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const total = args.total === true ? Number((await this.pool.query(`SELECT count(*) AS total FROM ${tableName(args.tableId)} ${where}`, values)).rows[0].total) : 0;
    if (cursor) {
      const anchor = await this.getRow({ ...args, rowId: cursor });
      // Lexicographic keyset pagination, with a stable primary-key tie breaker.
      const terms = order.map((o, i) => {
        const equal = order.slice(0, i).map(p => `${column(args.tableId, p.key)} IS NOT DISTINCT FROM ${bind(anchor[p.key])}`);
        const key = column(args.tableId, o.key), value = anchor[o.key];
        const after = value == null ? "FALSE" : `(${key} ${o.direction === "ASC" ? ">" : "<"} ${bind(value)} OR ${key} IS NULL)`;
        return `(${[...equal, after].join(" AND ")})`;
      });
      filters.push(`(${terms.join(" OR ")})`);
    }
    const result = await this.pool.query(`SELECT * FROM ${tableName(args.tableId)} ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY ${order.map(o => `${column(args.tableId, o.key)} ${o.direction} NULLS LAST`).join(",")} LIMIT ${bind(limit)} OFFSET ${bind(offset)}`, values);
    return { rows: result.rows.map(row => rowData(row, args.databaseId, args.tableId) as T), total: args.total === true ? total : result.rows.length };
  }
  async createRow<T extends Models.Row = Models.DefaultRow>(args: Args): Promise<T> {
    const entries = Object.entries(args.data ?? {}).filter(([, v]) => v !== undefined);
    const keys = ["$id", ...entries.map(([k]) => k)];
    try {
      const result = await this.pool.query(`INSERT INTO ${tableName(args.tableId)} (${keys.map(k => column(args.tableId, k)).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, [args.rowId, ...entries.map(([, v]) => v)]);
      this.changed(args.tableId, result.rows[0], args.data);
      return rowData(result.rows[0], args.databaseId, args.tableId) as T;
    } catch (error) { return dbError(error); }
  }
  async updateRow<T extends Models.Row = Models.DefaultRow>(args: Args): Promise<T> {
    const entries = Object.entries(args.data ?? {}).filter(([, v]) => v !== undefined);
    if (!entries.length) return this.getRow<T>(args);
    try {
      const result = await this.pool.query(`UPDATE ${tableName(args.tableId)} SET ${entries.map(([k], i) => `${column(args.tableId, k)}=$${i + 2}`).join(",")}, "$updatedAt"=now() WHERE "$id"=$1 RETURNING *`, [args.rowId, ...entries.map(([, v]) => v)]);
      if (!result.rows[0]) throw new AppwriteException("Row not found", 404);
      this.changed(args.tableId, result.rows[0], args.data);
      return rowData(result.rows[0], args.databaseId, args.tableId) as T;
    } catch (error) { return dbError(error); }
  }
  async deleteRow(args: Args) {
    const result = await this.pool.query(`DELETE FROM ${tableName(args.tableId)} WHERE "$id"=$1 RETURNING *`, [args.rowId]);
    if (!result.rowCount) throw new AppwriteException("Row not found", 404);
    this.changed(args.tableId, result.rows[0]);
    return {};
  }
  async incrementRowColumn<T extends Models.Row = Models.DefaultRow>(args: Args): Promise<T> { return this.adjust<T>(args, 1); }
  async decrementRowColumn<T extends Models.Row = Models.DefaultRow>(args: Args): Promise<T> { return this.adjust<T>(args, -1); }
  private async adjust<T extends Models.Row>(args: Args, sign: number): Promise<T> {
    const key = column(args.tableId, args.column!);
    const result = await this.pool.query(`UPDATE ${tableName(args.tableId)} SET ${key}=COALESCE(${key},1)+$2, "$updatedAt"=now() WHERE "$id"=$1 AND COALESCE(${key},1)+$2 BETWEEN $3 AND $4 RETURNING *`, [args.rowId, sign * (args.value ?? 1), args.min ?? -2147483648, args.max ?? 2147483647]);
    if (!result.rows[0]) throw new AppwriteException("Counter bound exceeded or row missing", 409);
    this.changed(args.tableId, result.rows[0]);
    return rowData(result.rows[0], args.databaseId, args.tableId) as T;
  }
}

export class PostgresStorage {
  constructor(readonly pool: Pool) {}
  async getBucket(_args: { bucketId: string }) { await this.pool.query("SELECT 1 FROM ifm.assets LIMIT 0"); return {}; }
  async createFile({ fileId, file }: { bucketId: string; fileId: string; file: InputFile }) {
    const content = Buffer.from(await file.slice(0, await file.size()));
    const ext = file.filename.split(".").pop()?.toLowerCase();
    const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" } as Record<string, string>)[ext ?? ""] ?? "application/octet-stream";
    try { await this.pool.query("INSERT INTO ifm.assets (id,name,mime_type,content) VALUES ($1,$2,$3,$4)", [fileId, file.filename, mime, content]); }
    catch (error) { dbError(error); }
    return this.getFile({ bucketId: "", fileId });
  }
  async getFile({ fileId }: { bucketId: string; fileId: string }) {
    const result = await this.pool.query("SELECT id,name,mime_type,octet_length(content) AS size FROM ifm.assets WHERE id=$1", [fileId]);
    const file = result.rows[0]; if (!file) throw new AppwriteException("File not found", 404);
    return { $id: file.id, name: file.name, mimeType: file.mime_type, sizeOriginal: file.size };
  }
  async getFileDownload({ fileId }: { bucketId: string; fileId: string }) {
    const result = await this.pool.query("SELECT content FROM ifm.assets WHERE id=$1", [fileId]);
    if (!result.rows[0]) throw new AppwriteException("File not found", 404);
    return result.rows[0].content as Buffer;
  }
  async deleteFile({ fileId }: { bucketId: string; fileId: string }) { await this.pool.query("DELETE FROM ifm.assets WHERE id=$1", [fileId]); return {}; }
}

export async function createPostgresServices(config: BackendConfig): Promise<AppwriteServices> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: config.databasePoolSize ?? 10, connectionTimeoutMillis: 5000 });
  pool.on("error", () => console.error(JSON.stringify({ event: "postgres_connection_error" })));
  const events = new MenuEvents();
  let listener: PoolClient | undefined, retry: NodeJS.Timeout | undefined, closing = false;
  const connect = async () => {
    const client = await pool.connect();
    listener = client;
    client.on("notification", msg => { if (msg.channel === "ifm_menu_changed" && msg.payload) events.publish(msg.payload); });
    client.once("error", () => {
      if (listener !== client) return;
      listener = undefined; client.release(true); events.disconnect();
      if (!closing) retry = setTimeout(() => { void connect().catch(reconnect); }, 5000);
    });
    try { await client.query("LISTEN ifm_menu_changed"); events.available = true; events.publish("*"); }
    catch (error) { if (listener === client) { listener = undefined; client.release(true); } throw error; }
  };
  const reconnect = () => { if (!closing) retry = setTimeout(() => { void connect().catch(reconnect); }, 5000); };
  try { await connect(); } catch (error) { await pool.end(); throw error; }
  return {
    // The adapter implements the TablesDB subset consumed by existing routes.
    tables: new PostgresTables(pool, events) as unknown as AppwriteServices["tables"],
    storage: new PostgresStorage(pool) as unknown as AppwriteServices["storage"],
    client: undefined as unknown as AppwriteServices["client"],
    datastore: "postgres", events, pool,
    close: async () => { closing = true; clearTimeout(retry); events.disconnect(); listener?.release(true); listener = undefined; await pool.end(); },
  };
}
