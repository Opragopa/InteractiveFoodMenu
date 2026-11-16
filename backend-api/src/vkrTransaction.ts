import type { AppwriteServices } from "./appwrite.js";
import type { Pool } from "pg";
import { PostgresTables } from "./postgres.js";
export async function transaction<T>(
  s: AppwriteServices,
  key: string,
  fn: (scoped: AppwriteServices) => Promise<T>,
): Promise<T> {
  if (s.pool) {
    const client = await s.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const result = await fn({
        ...s,
        pool: undefined,
        tables: new PostgresTables(
          client as unknown as Pool,
        ) as unknown as AppwriteServices["tables"],
      });
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  const tx = await s.tables.createTransaction({ ttl: 60 });
  const tables = new Proxy(s.tables, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== "function") return method;
      return (arg: object) =>
        method.call(target, { ...arg, transactionId: tx.$id });
    },
  });
  try {
    const result = await fn({ ...s, tables });
    await s.tables.updateTransaction({ transactionId: tx.$id, commit: true });
    return result;
  } catch (e) {
    await s.tables
      .updateTransaction({ transactionId: tx.$id, rollback: true })
      .catch(() => undefined);
    throw e;
  }
}
