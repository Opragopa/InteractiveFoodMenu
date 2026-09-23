import { AppwriteException, Query, type Storage, type TablesDB } from "node-appwrite";
import type { BackendConfig } from "./config.js";
import type { AppwriteServices } from "./appwrite.js";

type TableDefinition = {
  id: string;
  name: string;
  columns: object[];
  indexes: object[];
};

const commonAuditColumns = [
  { key: "updatedAt", type: "datetime", required: true },
  { key: "updatedBy", type: "varchar", size: 80, required: true },
];

export const TABLES: TableDefinition[] = [
  {
    id: "venues",
    name: "Venues",
    columns: [
      { key: "name", type: "varchar", size: 160, required: true },
      { key: "code", type: "varchar", size: 32, required: true },
      { key: "pinHash", type: "text", required: true },
      { key: "currency", type: "varchar", size: 3, required: true },
      { key: "backgroundColor", type: "varchar", size: 7, required: true },
      { key: "accentColor", type: "varchar", size: 7, required: true },
      { key: "pageDurationSeconds", type: "integer", required: true, min: 5, max: 60 },
      { key: "logoFileId", type: "varchar", size: 36, required: false },
      { key: "logoPosition", type: "varchar", size: 16, required: false },
      { key: "displayScalePercent", type: "integer", required: true, min: 50, max: 160 },
      { key: "staffVersion", type: "integer", required: true },
      { key: "displayVersion", type: "integer", required: true },
      { key: "active", type: "boolean", required: true },
      ...commonAuditColumns,
    ],
    indexes: [
      { key: "venue_code_unique", type: "unique", attributes: ["code"] },
      { key: "venue_name", type: "key", attributes: ["name"] },
    ],
  },
  {
    id: "categories",
    name: "Categories",
    columns: [
      { key: "venueId", type: "varchar", size: 36, required: true },
      { key: "name", type: "varchar", size: 160, required: true },
      { key: "sortOrder", type: "integer", required: true },
      ...commonAuditColumns,
    ],
    indexes: [{ key: "categories_by_venue", type: "key", attributes: ["venueId", "sortOrder"] }],
  },
  {
    id: "items",
    name: "Menu items",
    columns: [
      { key: "venueId", type: "varchar", size: 36, required: true },
      { key: "categoryId", type: "varchar", size: 36, required: true },
      { key: "name", type: "varchar", size: 200, required: true },
      { key: "description", type: "mediumtext", required: false },
      { key: "priceMinor", type: "integer", required: true, min: 0 },
      { key: "sortOrder", type: "integer", required: true },
      { key: "isAvailable", type: "boolean", required: true },
      { key: "imageFileId", type: "varchar", size: 36, required: false },
      ...commonAuditColumns,
    ],
    indexes: [
      { key: "items_by_venue", type: "key", attributes: ["venueId"] },
      { key: "items_by_category", type: "key", attributes: ["categoryId", "sortOrder"] },
    ],
  },
  {
    id: "display_tokens",
    name: "Display tokens",
    columns: [
      { key: "venueId", type: "varchar", size: 36, required: true },
      { key: "tokenHash", type: "text", required: true },
      { key: "active", type: "boolean", required: true },
      { key: "createdAt", type: "datetime", required: true },
      { key: "revokedAt", type: "datetime", required: false },
    ],
    indexes: [{ key: "display_tokens_by_venue", type: "key", attributes: ["venueId", "active"] }],
  },
  {
    id: "display_pairings",
    name: "Display pairings",
    columns: [
      { key: "tokenHash", type: "text", required: true },
      { key: "venueId", type: "varchar", size: 36, required: false },
      { key: "status", type: "enum", elements: ["pending", "complete", "expired"], required: true },
      { key: "expiresAt", type: "datetime", required: true },
      { key: "createdAt", type: "datetime", required: true },
      { key: "displayUrl", type: "varchar", size: 500, required: false },
    ],
    indexes: [
      { key: "pairings_by_status", type: "key", attributes: ["status"] },
      { key: "pairings_by_expiry", type: "key", attributes: ["expiresAt"] },
    ],
  },
  {
    id: "client_logs",
    name: "Client diagnostics",
    columns: [
      { key: "venueId", type: "varchar", size: 36, required: false },
      { key: "client", type: "varchar", size: 40, required: true },
      { key: "level", type: "enum", elements: ["debug", "info", "warn", "error"], required: true },
      { key: "message", type: "mediumtext", required: true },
      { key: "contextJson", type: "longtext", required: false },
      { key: "createdAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "logs_by_venue", type: "key", attributes: ["venueId"] },
      { key: "logs_by_time", type: "key", attributes: ["createdAt"] },
    ],
  },
  {
    id: "admin_audit_logs",
    name: "Admin audit logs",
    columns: [
      { key: "venueId", type: "varchar", size: 36, required: false },
      { key: "action", type: "varchar", size: 80, required: true },
      { key: "actor", type: "varchar", size: 100, required: true },
      { key: "detailsJson", type: "longtext", required: false },
      { key: "createdAt", type: "datetime", required: true },
    ],
    indexes: [{ key: "audit_by_time", type: "key", attributes: ["createdAt"] }],
  },
];

function isConflict(error: unknown): boolean {
  return error instanceof AppwriteException && error.code === 409;
}

async function ensureDatabase(tables: TablesDB, config: BackendConfig) {
  try {
    await tables.create({ databaseId: config.appwriteDatabaseId, name: "Interactive Food Menu" });
    return "created";
  } catch (error) {
    if (isConflict(error)) return "exists";
    throw error;
  }
}

async function ensureTable(tables: TablesDB, databaseId: string, definition: TableDefinition) {
  try {
    await tables.createTable({
      databaseId,
      tableId: definition.id,
      name: definition.name,
      permissions: [],
      rowSecurity: false,
      columns: definition.columns,
      indexes: definition.indexes,
    });
    return "created";
  } catch (error) {
    if (isConflict(error)) return "exists";
    throw error;
  }
}

/**
 * Appwrite does not add columns when a table already exists.  Keep the small
 * set of additive migrations here, so `npm run bootstrap` is safe on both a
 * fresh installation and an installation upgraded from an earlier release.
 */
async function ensureAdditiveColumns(tables: TablesDB, databaseId: string) {
  const pairingColumns = await tables.listColumns({ databaseId, tableId: "display_pairings", queries: [Query.limit(100)] });
  if (!pairingColumns.columns.some(column => column.key === "displayUrl")) {
    await tables.createVarcharColumn({ databaseId, tableId: "display_pairings", key: "displayUrl", size: 500, required: false });
  }
  const venueColumns = await tables.listColumns({ databaseId, tableId: "venues", queries: [Query.limit(100)] });
  if (!venueColumns.columns.some(column => column.key === "logoPosition")) {
    await tables.createVarcharColumn({ databaseId, tableId: "venues", key: "logoPosition", size: 16, required: false });
  }
}

async function ensureBucket(storage: Storage, config: BackendConfig) {
  try {
    await storage.createBucket({
      bucketId: config.appwriteBucketId,
      name: "Venue assets",
      permissions: [],
      fileSecurity: false,
      maximumFileSize: 10 * 1024 * 1024,
      allowedFileExtensions: ["png", "jpg", "jpeg", "webp", "svg"],
      encryption: true,
      antivirus: true,
    });
    return "created";
  } catch (error) {
    if (isConflict(error)) return "exists";
    throw error;
  }
}

export async function ensureSchema(services: AppwriteServices, config: BackendConfig) {
  const database = await ensureDatabase(services.tables, config);
  const tables: Record<string, string> = {};
  for (const definition of TABLES) {
    tables[definition.id] = await ensureTable(services.tables, config.appwriteDatabaseId, definition);
  }
  await ensureAdditiveColumns(services.tables, config.appwriteDatabaseId);
  const bucket = await ensureBucket(services.storage, config);
  return { database, tables, bucket };
}
