import { createHash } from "node:crypto";
import { AppwriteException, ID, Query, type Models } from "node-appwrite";
import type { AppwriteServices } from "./appwrite.js";

type Row = Models.Row & Record<string, unknown>;
export const STATISTICS_TYPES = [
  "staff_login", "display_connected", "display_seen", "category_created", "category_updated",
  "category_deleted", "item_created", "item_updated", "item_deleted", "availability_changed",
  "stock_adjusted", "break_started", "break_stopped", "venue_updated", "display_link_created",
  "statistics_reset",
] as const;
export type StatisticsType = typeof STATISTICS_TYPES[number];
export const STATISTICS_GROUPS: Record<string, StatisticsType[]> = {
  menuChanges: ["category_created", "category_updated", "category_deleted", "item_created", "item_updated", "item_deleted", "venue_updated", "break_started", "break_stopped"],
  availabilityChanges: ["availability_changed"],
  stockChanges: ["stock_adjusted"],
  staffLogins: ["staff_login"],
  displayConnections: ["display_connected"],
  displayContactIntervals: ["display_seen"],
};

export async function recordStatisticsEvent(services: AppwriteServices, databaseId: string, venueId: string, eventType: StatisticsType, actor: string, resourceId?: string, rowId = ID.unique()) {
  return services.tables.createRow<Row>({ databaseId, tableId: "statistics_events", rowId,
    data: { venueId, eventType, actor, ...(resourceId ? { resourceId } : {}), createdAt: new Date().toISOString() } });
}

export async function recordDisplayContact(services: AppwriteServices, databaseId: string, venueId: string, tokenId: string) {
  // One observation per screen and 15-minute UTC bucket, even when many polls arrive.
  const bucket = Math.floor(Date.now() / 900_000);
  const rowId = createHash("sha256").update(`${venueId}:${tokenId}:${bucket}`).digest("hex").slice(0, 32);
  try { await recordStatisticsEvent(services, databaseId, venueId, "display_seen", "display", tokenId, rowId); }
  catch (error) { if (!(error instanceof AppwriteException && error.code === 409)) throw error; }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function moscowDay(value: string): number {
  if (!DATE.test(value)) throw new Error("invalid_date");
  const [year, month, day] = value.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day, -3);
  if (new Date(utc + 3 * 3600_000).toISOString().slice(0, 10) !== value) throw new Error("invalid_date");
  return utc;
}

export function moscowToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

async function listResets(services: AppwriteServices, databaseId: string, venueId: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await services.tables.listRows<Row>({ databaseId, tableId: "statistics_events",
      queries: [Query.equal("venueId", [venueId]), Query.equal("eventType", ["statistics_reset"]), Query.orderAsc("createdAt"), Query.limit(500), Query.offset(offset)] });
    rows.push(...result.rows);
    if (result.rows.length < 500) return rows;
  }
}

async function countRows(services: AppwriteServices, databaseId: string, tableId: string, venueId: string, start: string, end: string, eventType?: string) {
  const queries = [Query.equal("venueId", [venueId]), Query.greaterThanEqual("createdAt", start), Query.lessThan("createdAt", end), Query.limit(1)];
  if (eventType) queries.push(Query.equal(tableId === "client_logs" ? "level" : "eventType", [eventType]));
  const result = await services.tables.listRows<Row>({ databaseId, tableId, queries, total: true });
  return result.total;
}

export async function venueStatistics(services: AppwriteServices, databaseId: string, venueId: string, from?: string, to?: string, epochId?: string) {
  const today = moscowToday();
  const endDay = to ?? today;
  const startDay = from ?? new Date(moscowDay(endDay) - 29 * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const startMs = moscowDay(startDay);
  const endMs = moscowDay(endDay) + 86400_000;
  if (startMs >= endMs || (endMs - startMs) / 86400_000 > 366) throw new Error("invalid_period");

  const resets = await listResets(services, databaseId, venueId);
  const epochs = [{ id: "initial", startedAt: null as string | null, endedAt: resets[0] ? String(resets[0].createdAt) : null },
    ...resets.map((reset, index) => ({ id: reset.$id, startedAt: String(reset.createdAt), endedAt: resets[index + 1] ? String(resets[index + 1].createdAt) : null }))];
  const epoch = epochId ? epochs.find(item => item.id === epochId) : epochs[epochs.length - 1];
  if (!epoch) throw new Error("invalid_epoch");
  const start = new Date(Math.max(startMs, epoch.startedAt ? Date.parse(epoch.startedAt) : 0)).toISOString();
  const end = new Date(Math.min(endMs, epoch.endedAt ? Date.parse(epoch.endedAt) : Infinity)).toISOString();
  const counts: Record<string, number> = {};
  if (start < end) {
    await Promise.all(Object.entries(STATISTICS_GROUPS).map(async ([name, types]) => {
      const values = await Promise.all(types.map(type => countRows(services, databaseId, "statistics_events", venueId, start, end, type)));
      counts[name] = values.reduce((sum, value) => sum + value, 0);
    }));
    counts.errors = await countRows(services, databaseId, "client_logs", venueId, start, end, "error");
  } else {
    for (const name of Object.keys(STATISTICS_GROUPS)) counts[name] = 0;
    counts.errors = 0;
  }
  return { venueId, from: startDay, to: endDay, epochId: epoch.id, epochs, counts };
}

export function sanitizeDiagnostic(value: unknown): string {
  return String(value ?? "")
    .replace(/(pin|secret|token|password)\s*[:=]\s*[^\s&,;]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_-]{12,40}\.[A-Za-z0-9_-]{32,80}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b\d{6}\b/g, "[redacted]")
    .slice(0, 500);
}

export function safeDiagnosticDetails(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  const details = Object.entries(value).filter(([key, entry]) => /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) && !/(pin|secret|token|password|url|href)/i.test(key) && ["string", "number", "boolean"].includes(typeof entry)).slice(0, 12)
    .map(([key, entry]) => [key, typeof entry === "string" ? sanitizeDiagnostic(entry).slice(0, 200) : entry]);
  return JSON.stringify(Object.fromEntries(details));
}
