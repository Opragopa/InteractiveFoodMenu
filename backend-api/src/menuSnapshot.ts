import { Query, type Models } from "node-appwrite";
import type { AppwriteServices } from "./appwrite.js";
import { menuEtag } from "./menuHash.js";

type Row = Models.Row & Record<string, unknown>;
export function publicMenuRow(row: Row): Record<string, unknown> {
  const result: Record<string, unknown> = { id: row.$id };
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("$") && !["pinHash", "tokenHash", "passwordHash"].includes(key)) result[key] = value;
  }
  if (row.isAvailable !== undefined && row.stockQuantity !== undefined && row.stockQuantity !== null) result.isAvailable = Number(row.stockQuantity) > 0;
  return result;
}
export async function menuSnapshot(services: AppwriteServices, databaseId: string, venueId: string) {
  const load = async () => {
    const rows = async (tableId: string) => {
      const result: Row[] = []; let cursor: string | undefined;
      for (;;) {
        const page = await services.tables.listRows<Row>({ databaseId, tableId, queries: [Query.equal("venueId", [venueId]), Query.orderAsc(tableId === "categories" ? "sortOrder" : "$id"), Query.limit(5000), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
        result.push(...page.rows);
        if (page.rows.length < 5000) return result;
        cursor = page.rows[page.rows.length - 1].$id;
      }
    };
    const [venue, categories, items] = await Promise.all([services.tables.getRow<Row>({ databaseId, tableId: "venues", rowId: venueId }), rows("categories"), rows("items")]);
    const data = { venue: publicMenuRow(venue), categories: categories.map(publicMenuRow), items: items.map(publicMenuRow) };
    return { data, etag: menuEtag(data) };
  };
  // The bounded cache is invalidated by database notifications and local writes.
  // A lost LISTEN connection disables the cache until reconnection clears it.
  return services.datastore === "postgres" && services.events ? services.events.cached(venueId, load) : load();
}
