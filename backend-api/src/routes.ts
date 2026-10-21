import { createHash, createHmac } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { AppwriteException, ID, Query, type Models } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { menuStream } from "./menuEvents.js";
import { menuSnapshot, publicMenuRow } from "./menuSnapshot.js";
import QRCode from "qrcode";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { hashSecret, opaqueToken, signSession, verifySecret, verifySession, type SessionClaims, type SessionRole } from "./security.js";
import { renderLegacyDisplay } from "./legacyDisplay.js";
import { authToken, setAccountCookie } from "./accountRoutes.js";
import { recordDisplayContact, recordStatisticsEvent, safeDiagnosticDetails, sanitizeDiagnostic, venueStatistics, type StatisticsType } from "./statistics.js";

const VENUE_CODE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const PIN = /^\d{6}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const LOGO_POSITIONS = new Set(["top-right", "top-left", "bottom-right", "bottom-left"]);
const LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type RowData = Models.Row & Record<string, unknown>;
const ROW_PAGE_SIZE = 5000;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(next);
}

function bearer(request: Request): string {
  const match = /^Bearer\s+(.+)$/i.exec(request.header("authorization") ?? "");
  if (!match) throw new ApiError(401, "unauthenticated", "Требуется вход.");
  return match[1];
}

function session(request: Request, config: BackendConfig): SessionClaims {
  try {
    return verifySession(authToken(request), config.sessionSecret);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "unauthenticated", "Сессия недействительна или истекла.");
  }
}

function requireRole(request: Request, config: BackendConfig, roles: SessionRole[]): SessionClaims {
  const claims = session(request, config);
  if (!roles.includes(claims.role)) throw new ApiError(403, "forbidden", "Недостаточно прав.");
  return claims;
}

function text(value: unknown, maxLength: number): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > maxLength) throw new ApiError(400, "invalid_argument", "Некорректное текстовое поле.");
  return result;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new ApiError(400, "invalid_argument", "Некорректное числовое поле.");
  }
  return result;
}

function stockQuantity(value: unknown): number {
  if (typeof value !== "number") throw new ApiError(400, "invalid_argument", "Количество должно быть целым числом от 0 до 2000000000.");
  return integer(value, 0, 2_000_000_000);
}

export function normalizeBulkAvailabilityIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_argument", "Нужен массив позиций.");
  const ids = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!ids.length) throw new ApiError(400, "invalid_argument", "Выберите хотя бы одну позицию.");
  if (ids.length > 500) throw new ApiError(400, "invalid_argument", "За одну операцию можно изменить не более 500 позиций.");
  return ids;
}

function routeId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function logoPosition(value: unknown): string {
  const result = String(value ?? "");
  if (!LOGO_POSITIONS.has(result)) throw new ApiError(400, "invalid_argument", "Некорректное расположение логотипа.");
  return result;
}

const publicRow = publicMenuRow;

function trackedStock(row: RowData): boolean {
  return row.stockQuantity !== undefined && row.stockQuantity !== null;
}
function available(row: RowData): boolean {
  return trackedStock(row) ? Number(row.stockQuantity) > 0 : row.isAvailable !== false;
}

async function venueByCode(services: AppwriteServices, config: BackendConfig, code: string): Promise<RowData | null> {
  const result = await services.tables.listRows<RowData>({
    databaseId: config.appwriteDatabaseId,
    tableId: "venues",
    queries: [Query.equal("code", [code]), Query.limit(1)],
  });
  return result.rows[0] ?? null;
}

async function listAllRows(services: AppwriteServices, databaseId: string, tableId: string, filters: string[] = []): Promise<RowData[]> {
  const rows: RowData[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await services.tables.listRows<RowData>({
      databaseId,
      tableId,
      queries: [...filters, Query.limit(ROW_PAGE_SIZE), ...(cursor ? [Query.cursorAfter(cursor)] : [])],
    });
    rows.push(...page.rows);
    if (page.rows.length < ROW_PAGE_SIZE) return rows;
    cursor = page.rows[page.rows.length - 1].$id;
  }
}

async function ownedRow(services: AppwriteServices, config: BackendConfig, tableId: string, rowId: string, venueId: string): Promise<RowData> {
  const row = await services.tables.getRow<RowData>({ databaseId: config.appwriteDatabaseId, tableId, rowId }).catch(error => {
    if (error instanceof AppwriteException && error.code === 404) throw new ApiError(404, "not_found", "Запись не найдена.");
    throw error;
  });
  if (row.venueId !== venueId) throw new ApiError(404, "not_found", "Запись не найдена.");
  return row;
}

function displayUrl(config: BackendConfig, tokenId: string, secret: string) {
  return `${config.displayBaseUrl}/#${tokenId}.${secret}`;
}

async function createDisplayToken(services: AppwriteServices, config: BackendConfig, venueId: string) {
  const tokenId = ID.unique();
  const secret = opaqueToken();
  await services.tables.createRow({
    databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: tokenId,
    data: { venueId, tokenHash: await hashSecret(secret), active: true, label: `Экран ${tokenId.slice(-4)}`, createdAt: new Date().toISOString() },
  });
  return { tokenId, secret, url: displayUrl(config, tokenId, secret) };
}

async function claimPairingDisplay(services: AppwriteServices, config: BackendConfig, pairingId: string, pairingSecret: string, venueId: string) {
  // The unique row ID is the cross-process claim. Stable credentials also let a
  // retry finish a pairing after the token write succeeded but the reply failed.
  const tokenId = createHash("sha256").update(`pairing:${pairingId}`).digest("hex").slice(0, 32);
  const secret = createHmac("sha256", config.sessionSecret).update(`pairing-display:${pairingId}:${pairingSecret}`).digest("base64url");
  try {
    await services.tables.createRow({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: tokenId,
      data: { venueId, tokenHash: await hashSecret(secret), active: true, label: `Экран ${tokenId.slice(-4)}`, createdAt: new Date().toISOString() } });
  } catch (error) {
    if (!(error instanceof AppwriteException && error.code === 409)) throw error;
    const existing = await services.tables.getRow<RowData>({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: tokenId });
    if (existing.venueId !== venueId || existing.active !== true || !(await verifySecret(secret, String(existing.tokenHash ?? "")))) {
      throw new ApiError(409, "pairing_used", "Этот QR-код уже использован или экран отозван.");
    }
  }
  return { tokenId, secret, url: displayUrl(config, tokenId, secret) };
}

async function revokeDisplayTokens(services: AppwriteServices, databaseId: string, venueId: string, revokedAt: string) {
  let revoked = 0;
  for (;;) {
    const page = await services.tables.listRows<RowData>({ databaseId, tableId: "display_tokens",
      queries: [Query.equal("venueId", [venueId]), Query.equal("active", [true]), Query.limit(100)] });
    if (!page.rows.length) return revoked;
    // Mutating the filter shrinks the set, so always read its first page.
    for (let start = 0; start < page.rows.length; start += 10) {
      await Promise.all(page.rows.slice(start, start + 10).map(row => services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: row.$id, data: { active: false, revokedAt } })));
    }
    revoked += page.rows.length;
  }
}

function hubActor(request: Request, config: BackendConfig): string {
  try { const claims = verifySession(authToken(request), config.sessionSecret); return claims.accountId ? `operator:${claims.accountId}` : "emergency-key"; }
  catch { return "unknown"; }
}

function staffActor(claims: SessionClaims): string { return claims.accountId ? "personal-staff" : "legacy-android"; }
function staffUpdatedBy(claims: SessionClaims): string { return claims.accountId ? `staff:${claims.accountId}` : "legacy-android"; }

async function audit(services: AppwriteServices, config: BackendConfig, action: string, venueId: string | undefined, details: Record<string, unknown> = {}, actor = "backend-hub") {
  await services.tables.createRow({
    databaseId: config.appwriteDatabaseId, tableId: "admin_audit_logs", rowId: ID.unique(),
    data: { venueId, action, actor, detailsJson: JSON.stringify(details), createdAt: new Date().toISOString() },
  });
}

const pendingMenuVersionUpdates = new Map<string, Promise<void>>();

async function bumpMenuVersion(services: AppwriteServices, databaseId: string, venueId: string) {
  if (services.datastore === "postgres") {
    await services.tables.incrementRowColumn({ databaseId, tableId: "venues", rowId: venueId, column: "menuVersion", value: 1 });
    return;
  }
  // The self-hosted increment endpoint has acknowledged updates without
  // changing the value used by display polling. Serialize the read/write
  // fallback so rapid stock changes cannot publish the same version twice.
  const key = `${databaseId}:${venueId}`;
  const previous = pendingMenuVersionUpdates.get(key) ?? Promise.resolve();
  const update = previous.catch(() => undefined).then(async () => {
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId });
    await services.tables.updateRow({
      databaseId,
      tableId: "venues",
      rowId: venueId,
      data: { menuVersion: Number(venue.menuVersion ?? 1) + 1 },
    });
  });
  pendingMenuVersionUpdates.set(key, update);
  try { await update; }
  finally { if (pendingMenuVersionUpdates.get(key) === update) pendingMenuVersionUpdates.delete(key); }
}

async function deleteVenueRows(services: AppwriteServices, databaseId: string, tableId: string, venueId: string, onRow?: (row: RowData) => void) {
  // The project schema scopes every dependent row by venueId. Read the page
  // before deleting it, then repeat: deleting while using an offset may skip
  // rows as the remaining set shifts.
  while (true) {
    const rows = await services.tables.listRows<RowData>({
      databaseId, tableId, queries: [Query.equal("venueId", [venueId]), Query.limit(100)],
    });
    if (!rows.rows.length) return;
    rows.rows.forEach(row => onRow?.(row));
    await Promise.all(rows.rows.map(row => services.tables.deleteRow({ databaseId, tableId, rowId: row.$id })));
  }
}

export function createApiRouter(services: AppwriteServices, config: BackendConfig): Router {
  const router = Router();
  // This queue coordinates all writes to an existing item in this API process.
  // Appwrite atomic increments still enforce bounds independently of the queue.
  const itemQueues = new Map<string, Promise<void>>();
  const withItems = async (ids: string[], operation: () => Promise<void>) => {
    const releaseLocks: Array<() => void> = [];
    try {
      for (const id of [...new Set(ids)].sort()) {
        const previous = itemQueues.get(id) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const tail = previous.then(() => gate);
        itemQueues.set(id, tail);
        await previous;
        releaseLocks.push(() => { release(); if (itemQueues.get(id) === tail) itemQueues.delete(id); });
      }
      await operation();
    } finally { for (const release of releaseLocks.reverse()) release(); }
  };
  const track = async (venueId: string, eventType: StatisticsType, actor: string, resourceId?: string) => {
    try { await recordStatisticsEvent(services, config.appwriteDatabaseId, venueId, eventType, actor, resourceId); }
    catch { console.error(JSON.stringify({ event: "statistics_write_failed", venueId, eventType })); }
  };
  const contact = async (venueId: string, tokenId: string) => {
    try { await recordDisplayContact(services, config.appwriteDatabaseId, venueId, tokenId); }
    catch { console.error(JSON.stringify({ event: "display_contact_write_failed", venueId })); }
  };

  router.get("/display/legacy/:credentials", asyncRoute(async (request, response) => {
    const match = /^([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})$/.exec(routeId(request.params.credentials));
    if (!match) throw new ApiError(404, "not_found", "Ссылка экрана недействительна.");
    const token = await services.tables.getRow<RowData>({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: match[1] }).catch(() => null);
    if (!token || token.active !== true || !(await verifySecret(match[2], String(token.tokenHash ?? "")))) throw new ApiError(401, "unauthenticated", "Ссылка экрана недействительна или отозвана.");
    const venue = await services.tables.getRow<RowData>({ databaseId: config.appwriteDatabaseId, tableId: "venues", rowId: String(token.venueId) });
    if (venue.active === false) throw new ApiError(403, "forbidden", "Точка отключена.");
    if (request.query.events === "1") {
      if (!services.events) throw new ApiError(503, "events_unavailable", "Уведомления недоступны.");
      menuStream(request, response, services.events, String(token.venueId), async () => {
        const [current, place] = await Promise.all([
          services.tables.getRow<RowData>({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: token.$id }),
          services.tables.getRow<RowData>({ databaseId: config.appwriteDatabaseId, tableId: "venues", rowId: String(token.venueId) }),
        ]);
        if (current.active !== true || place.active === false || current.venueId !== token.venueId) return { revoked: true };
        return { version: Number(place.menuVersion ?? 1), hash: (await menuSnapshot(services, config.appwriteDatabaseId, String(token.venueId))).etag, breakActive: place.breakActive === true, breakEndsAt: place.breakEndsAt ?? null };
      });
      return;
    }
    await services.tables.updateRow({ databaseId: config.appwriteDatabaseId, tableId: "display_tokens", rowId: token.$id, data: { lastSeenAt: new Date().toISOString() } });
    await contact(String(token.venueId), token.$id);
    response.set("Cache-Control", "no-store, no-cache, must-revalidate");
    if (request.query.state === "1") {
      response.json({ version: Number(venue.menuVersion ?? 1), breakActive: venue.breakActive === true, breakEndsAt: venue.breakEndsAt ?? null });
      return;
    }
    const { data: menu } = await menuSnapshot(services, config.appwriteDatabaseId, String(token.venueId));
    const width = Math.max(480, Math.min(7680, Number(request.query.w) || 1920));
    const height = Math.max(360, Math.min(4320, Number(request.query.h) || 1080));
    response.status(200).type("html").set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'").set("Referrer-Policy", "no-referrer").send(renderLegacyDisplay(menu.venue, menu.categories as never, menu.items as never, width, height, `${match[1]}.${match[2]}`));
  }));
  const databaseId = config.appwriteDatabaseId;

  router.post("/hub/login", asyncRoute(async (request, response) => {
    const accessKey = String(request.body?.accessKey ?? "");
    const valid = Buffer.byteLength(accessKey) === Buffer.byteLength(config.hubAccessKey)
      && await import("node:crypto").then(({ timingSafeEqual }) => timingSafeEqual(Buffer.from(accessKey), Buffer.from(config.hubAccessKey)));
    if (!valid) throw new ApiError(401, "unauthenticated", "Неверный ключ хаба.");
    await audit(services, config, "hub_login_emergency", undefined, {}, "emergency-key");
    setAccountCookie(request, response, signSession({ role: "hub", authType: "emergency" }, config.sessionSecret, "4h"), 4 * 3600, "hub");
    response.json({ role: "hub" });
  }));

  router.get("/hub/overview", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const [venues, categories, items, displays, logs, auditLogs] = await Promise.all([
      listAllRows(services, databaseId, "venues", [Query.orderAsc("name")]),
      services.tables.listRows<RowData>({ databaseId, tableId: "categories", queries: [Query.limit(1)], total: true }),
      services.tables.listRows<RowData>({ databaseId, tableId: "items", queries: [Query.limit(1)], total: true }),
      services.tables.listRows<RowData>({ databaseId, tableId: "display_tokens", queries: [Query.equal("active", [true]), Query.limit(1)], total: true }),
      services.tables.listRows<RowData>({ databaseId, tableId: "client_logs", queries: [Query.orderDesc("createdAt"), Query.limit(30)] }),
      services.tables.listRows<RowData>({ databaseId, tableId: "admin_audit_logs", queries: [Query.orderDesc("createdAt"), Query.limit(20)] }),
    ]);
    response.json({
      generatedAt: new Date().toISOString(),
      totals: { venues: venues.length, categories: categories.total, items: items.total, activeDisplays: displays.total },
      venues: venues.map(publicRow),
      functions: [
        { name: "auth/staff", area: "Доступ", access: "Публичная", purpose: "Вход сотрудника по коду точки и PIN" },
        { name: "display/pairings", area: "Экраны", access: "Публичная", purpose: "Одноразовое подключение ТВ через QR-код" },
        { name: "menu", area: "Меню", access: "Сессия", purpose: "Выдача актуального меню клиентам" },
      ],
      clientLogs: logs.rows.map(row => ({ ...publicRow(row), event: row.message, role: row.client })),
      auditLogs: auditLogs.rows.map(publicRow),
    });
  }));

  router.get("/hub/venues/:id/statistics", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    try {
      response.json(await venueStatistics(services, databaseId, venueId,
        typeof request.query.from === "string" ? request.query.from : undefined,
        typeof request.query.to === "string" ? request.query.to : undefined,
        typeof request.query.epochId === "string" ? request.query.epochId : undefined));
    } catch (error) {
      if (error instanceof Error && ["invalid_date", "invalid_period", "invalid_epoch"].includes(error.message)) throw new ApiError(400, "invalid_argument", "Некорректный период статистики.");
      throw error;
    }
  }));

  router.post("/hub/venues/:id/statistics/reset", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    const reset = await recordStatisticsEvent(services, databaseId, venueId, "statistics_reset", "hub");
    await audit(services, config, "statistics_reset", venueId, { epochId: reset.$id }, hubActor(request, config));
    response.status(201).json({ epochId: reset.$id, startedAt: reset.createdAt });
  }));

  router.post("/hub/venues", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const name = text(request.body?.name, 160);
    const code = String(request.body?.code ?? "").trim().toLowerCase();
    const pin = String(request.body?.pin ?? "");
    if (!VENUE_CODE.test(code) || !PIN.test(pin)) throw new ApiError(400, "invalid_argument", "Проверьте код точки и шестизначный PIN.");
    if (await venueByCode(services, config, code)) throw new ApiError(409, "already_exists", "Этот код точки уже занят.");
    const now = new Date().toISOString();
    const row = await services.tables.createRow<RowData>({
      databaseId,
      tableId: "venues",
      rowId: ID.unique(),
      data: {
        name, code, pinHash: await hashSecret(pin), currency: "RUB",
        backgroundColor: "#56965B", accentColor: "#FFFFFF", pageDurationSeconds: 10, logoPosition: "top-right", logoInsetPercent: 3, logoScalePercent: 100, logoVisible: true,
        displayScalePercent: 100, displayScaleMode: "auto", columnScale1Percent: 100, columnScale2Percent: 100, columnScale3Percent: 100, breakActive: false, breakDurationMinutes: 10, breakFontSizePercent: 100,
        breakPanelWidthPercent: 36, breakMenuDimPercent: 45, menuItemFontSizePx: 34, menuItemGapPx: 12,
        showServingSize: false, showCalories: false,
        breakTransitionMs: 600, displayPreset: "balanced", breakExpiredText: "Скоро буду",
        staffVersion: 1, displayVersion: 1, menuVersion: 1, menuRefreshSeconds: 15, active: true,
        updatedAt: now, updatedBy: "backend-hub",
      },
    });
    const screen = await createDisplayToken(services, config, row.$id);
    await audit(services, config, "venue_created", row.$id, { code }, hubActor(request, config));
    await track(row.$id, "display_link_created", "hub", screen.tokenId);
    response.status(201).json({ venue: publicRow(row), venueId: row.$id, displayUrl: screen.url });
  }));

  router.patch("/hub/venues/:id/access", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    const code = String(request.body?.venueCode ?? "").trim().toLowerCase();
    const pin = String(request.body?.pin ?? "");
    if (!VENUE_CODE.test(code) || !PIN.test(pin)) throw new ApiError(400, "invalid_argument", "Проверьте код точки и шестизначный PIN.");
    const taken = await venueByCode(services, config, code);
    if (taken && taken.$id !== venueId) throw new ApiError(409, "already_exists", "Этот код точки уже занят.");
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: venueId, data: {
      code, pinHash: await hashSecret(pin), staffVersion: Number(venue.staffVersion ?? 0) + 1,
      updatedAt: new Date().toISOString(), updatedBy: "backend-hub",
    } });
    await audit(services, config, "venue_pin_rotated", venueId, { code }, hubActor(request, config));
    response.json({ updated: true, venue: publicRow(row) });
  }));

  router.post("/hub/venues/:id/display", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    const screen = await createDisplayToken(services, config, venueId);
    await audit(services, config, "display_link_created", venueId, { tokenId: screen.tokenId }, hubActor(request, config));
    await track(venueId, "display_link_created", "hub", screen.tokenId);
    response.status(201).json({ displayUrl: screen.url });
  }));

  router.patch("/hub/venues/:id", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    const data: Record<string, unknown> = {};
    if (request.body?.name !== undefined) data.name = text(request.body.name, 160);
    for (const field of ["backgroundColor", "accentColor"] as const) {
      if (request.body?.[field] !== undefined) {
        const value = String(request.body[field]).toUpperCase();
        if (!HEX_COLOR.test(value)) throw new ApiError(400, "invalid_argument", "Цвет должен быть в формате #RRGGBB.");
        data[field] = value;
      }
    }
    if (request.body?.pageDurationSeconds !== undefined) data.pageDurationSeconds = integer(request.body.pageDurationSeconds, 5, 30);
    if (request.body?.displayScalePercent !== undefined) data.displayScalePercent = integer(request.body.displayScalePercent, 50, 160);
    for (const field of ["columnScale1Percent", "columnScale2Percent", "columnScale3Percent"] as const) if (request.body?.[field] !== undefined) data[field] = integer(request.body[field], 50, 160);
    if (request.body?.displayScaleMode !== undefined) {
      const mode = String(request.body.displayScaleMode);
      if (mode !== "auto" && mode !== "manual") throw new ApiError(400, "invalid_argument", "Некорректный режим масштаба.");
      data.displayScaleMode = mode;
    }
    if (request.body?.logoPosition !== undefined) data.logoPosition = logoPosition(request.body.logoPosition);
    if (request.body?.logoInsetPercent !== undefined) data.logoInsetPercent = integer(request.body.logoInsetPercent, 0, 20);
    if (request.body?.logoScalePercent !== undefined) data.logoScalePercent = integer(request.body.logoScalePercent, 50, 200);
    if (request.body?.logoVisible !== undefined) data.logoVisible = Boolean(request.body.logoVisible);
    if (request.body?.menuRefreshSeconds !== undefined) data.menuRefreshSeconds = integer(request.body.menuRefreshSeconds, 5, 300);
    if (request.body?.breakFontSizePercent !== undefined) data.breakFontSizePercent = integer(request.body.breakFontSizePercent, 50, 200);
    if (request.body?.breakPanelWidthPercent !== undefined) data.breakPanelWidthPercent = integer(request.body.breakPanelWidthPercent, 30, 50);
    if (request.body?.breakMenuDimPercent !== undefined) data.breakMenuDimPercent = integer(request.body.breakMenuDimPercent, 25, 75);
    if (request.body?.menuItemFontSizePx !== undefined) data.menuItemFontSizePx = integer(request.body.menuItemFontSizePx, 22, 54);
    if (request.body?.menuItemGapPx !== undefined) data.menuItemGapPx = integer(request.body.menuItemGapPx, 4, 28);
    if (request.body?.breakTransitionMs !== undefined) data.breakTransitionMs = integer(request.body.breakTransitionMs, 200, 1200);
    if (request.body?.displayPreset !== undefined) {
      const preset = String(request.body.displayPreset);
      if (!["compact", "balanced", "large"].includes(preset)) throw new ApiError(400, "invalid_argument", "Некорректный пресет отображения.");
      data.displayPreset = preset;
    }
    if (request.body?.breakExpiredText !== undefined) data.breakExpiredText = text(request.body.breakExpiredText, 80);
    for (const field of ["showServingSize", "showCalories"] as const) if (request.body?.[field] !== undefined) {
      if (typeof request.body[field] !== "boolean") throw new ApiError(400, "invalid_argument", `${field} должно быть логическим.`);
      data[field] = request.body[field];
    }
    const removeLogoFileId = request.body?.logoFileId === null && typeof venue.logoFileId === "string" ? venue.logoFileId : "";
    if (request.body?.logoFileId === null) data.logoFileId = null;
    data.updatedAt = new Date().toISOString();
    data.updatedBy = "backend-hub";
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: venueId, data });
    await bumpMenuVersion(services, databaseId, venueId);
    if (removeLogoFileId) await services.storage.deleteFile({ bucketId: config.appwriteBucketId, fileId: removeLogoFileId }).catch(() => undefined);
    await audit(services, config, "venue_settings_updated", venueId, data, hubActor(request, config));
    await track(venueId, "venue_updated", "hub");
    response.json({ venue: publicRow(row) });
  }));

  router.post("/hub/venues/:id/logo", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    const mimeType = String(request.body?.mimeType ?? "").toLowerCase();
    const name = String(request.body?.name ?? "logo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const contentBase64 = String(request.body?.contentBase64 ?? "");
    if (!LOGO_MIME_TYPES.has(mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
      throw new ApiError(400, "invalid_argument", "Загрузите логотип в PNG, JPEG или WebP.");
    }
    const content = Buffer.from(contentBase64, "base64");
    if (!content.length || content.length > 5 * 1024 * 1024) throw new ApiError(400, "invalid_argument", "Размер логотипа должен быть не больше 5 МБ.");
    const file = await services.storage.createFile({
      bucketId: config.appwriteBucketId, fileId: ID.unique(), file: InputFile.fromBuffer(content, name), permissions: [],
    });
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: venueId, data: {
      logoFileId: file.$id, updatedAt: new Date().toISOString(), updatedBy: "backend-hub",
    } });
    await bumpMenuVersion(services, databaseId, venueId);
    if (typeof venue.logoFileId === "string" && venue.logoFileId) await services.storage.deleteFile({ bucketId: config.appwriteBucketId, fileId: venue.logoFileId }).catch(() => undefined);
    await audit(services, config, "venue_logo_uploaded", venueId, { fileId: file.$id, mimeType }, hubActor(request, config));
    response.status(201).json({ venue: publicRow(row) });
  }));

  router.get("/venue-assets/:id", asyncRoute(async (request, response) => {
    const fileId = routeId(request.params.id);
    const file = await services.storage.getFile({ bucketId: config.appwriteBucketId, fileId });
    const content = await services.storage.getFileDownload({ bucketId: config.appwriteBucketId, fileId });
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.type(file.mimeType || "application/octet-stream").send(Buffer.from(content));
  }));

  router.post("/hub/venues/:id/revoke", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    const now = new Date().toISOString();
    await revokeDisplayTokens(services, databaseId, venueId, now);
    await services.tables.updateRow({ databaseId, tableId: "venues", rowId: venueId, data: { staffVersion: Number(venue.staffVersion ?? 0) + 1, displayVersion: Number(venue.displayVersion ?? 0) + 1, updatedAt: now, updatedBy: "backend-hub" } });
    await audit(services, config, "venue_sessions_revoked", venueId, { scope: "all" }, hubActor(request, config));
    response.json({ revoked: true });
  }));

  router.get("/hub/venues/:id/displays", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const displays = await listAllRows(services, databaseId, "display_tokens", [Query.equal("venueId", [venueId]), Query.equal("active", [true]), Query.orderDesc("createdAt")]);
    response.json({ displays: displays.map(publicRow) });
  }));
  router.patch("/hub/venues/:id/displays/:tokenId", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id); const tokenId = routeId(request.params.tokenId);
    await ownedRow(services, config, "display_tokens", tokenId, venueId);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "display_tokens", rowId: tokenId, data: { label: text(request.body?.label, 80) } });
    response.json({ display: publicRow(row) });
  }));
  router.post("/hub/venues/:id/displays/:tokenId/revoke", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id); const tokenId = routeId(request.params.tokenId);
    await ownedRow(services, config, "display_tokens", tokenId, venueId);
    await services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: tokenId, data: { active: false, revokedAt: new Date().toISOString() } });
    await audit(services, config, "display_session_revoked", venueId, { tokenId }, hubActor(request, config));
    response.json({ revoked: true });
  }));
  router.post("/hub/venues/:id/displays/revoke-all", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id); const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId });
    const now = new Date().toISOString();
    const revoked = await revokeDisplayTokens(services, databaseId, venueId, now);
    await services.tables.updateRow({ databaseId, tableId: "venues", rowId: venueId, data: { displayVersion: Number(venue.displayVersion ?? 0) + 1, updatedAt: now, updatedBy: "backend-hub" } });
    response.json({ revoked });
  }));

  router.delete("/hub/venues/:id", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    const assetIds = new Set<string>();
    if (typeof venue.logoFileId === "string" && venue.logoFileId) assetIds.add(venue.logoFileId);

    // Child data must be removed before its parent so a deleted venue cannot
    // leave usable display links, menu rows, or diagnostic data behind.
    for (const tableId of ["items", "categories", "display_tokens", "display_pairings", "client_logs", "admin_audit_logs", "statistics_events", "staff_invites", "staff_accounts"]) {
      await deleteVenueRows(services, databaseId, tableId, venueId, row => {
        if (tableId === "items" && typeof row.imageFileId === "string" && row.imageFileId) assetIds.add(row.imageFileId);
      });
    }
    await services.tables.deleteRow({ databaseId, tableId: "venues", rowId: venueId });
    await Promise.all([...assetIds].map(fileId => services.storage.deleteFile({ bucketId: config.appwriteBucketId, fileId }).catch(() => undefined)));
    response.status(204).end();
  }));

  router.post("/auth/staff", asyncRoute(async (request, response) => {
    if (config.legacyStaffPinEnabled === false) throw new ApiError(410, "legacy_login_disabled", "Вход по общему PIN отключён.");
    const code = String(request.body?.venueCode ?? "").trim().toLowerCase();
    const pin = String(request.body?.pin ?? "");
    if (!VENUE_CODE.test(code) || !PIN.test(pin)) throw new ApiError(400, "invalid_argument", "Проверьте код точки и шестизначный PIN.");
    const venue = await venueByCode(services, config, code);
    if (!venue || venue.active === false || !(await verifySecret(pin, String(venue.pinHash ?? "")))) {
      throw new ApiError(401, "unauthenticated", "Неверный код точки или PIN.");
    }
    await track(venue.$id, "staff_login", "legacy-android");
    response.json({ token: signSession({ role: "staff", venueId: venue.$id, version: Number(venue.staffVersion ?? 1), authType: "legacy" }, config.sessionSecret), venueId: venue.$id });
  }));

  router.post("/auth/display", asyncRoute(async (request, response) => {
    const tokenId = String(request.body?.tokenId ?? "");
    const secret = String(request.body?.secret ?? "");
    const token = await services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: tokenId }).catch(() => null);
    if (!token || token.active !== true || !(await verifySecret(secret, String(token.tokenHash ?? "")))) {
      throw new ApiError(401, "unauthenticated", "Ссылка экрана недействительна.");
    }
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: String(token.venueId) });
    await track(String(token.venueId), "display_connected", "display", token.$id);
    response.json({ token: signSession({ role: "display", venueId: String(token.venueId), displayTokenId: token.$id, version: Number(venue.displayVersion ?? 1) }, config.sessionSecret, "30d"), venueId: token.venueId });
  }));

  router.get("/menu", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff", "display"]);
    if (!claims.venueId) throw new ApiError(403, "forbidden", "Сессия не привязана к точке.");
    if (claims.role === "display" && claims.displayTokenId) {
      const token = await services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId }).catch(() => null);
      if (!token || token.active !== true || token.venueId !== claims.venueId) throw new ApiError(401, "session_revoked", "Сессия экрана отозвана.");
      await services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId, data: { lastSeenAt: new Date().toISOString() } });
      await contact(claims.venueId, claims.displayTokenId);
    }
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId });
    const expectedVersion = claims.role === "staff" ? venue.staffVersion : venue.displayVersion;
    if (claims.version !== Number(expectedVersion ?? 1)) throw new ApiError(401, "session_revoked", "Сессия отозвана. Выполните вход заново.");
    if (venue.active === false) throw new ApiError(401, "session_revoked", "Точка отключена.");
    const { data: menu, etag } = await menuSnapshot(services, databaseId, claims.venueId);
    response.set({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Authorization, Cookie" });
    if (request.header("if-none-match")?.split(/,\s*/).some(tag => tag.replace(/^W\//, "") === etag)) { response.status(304).end(); return; }
    response.json(menu);
  }));

  router.get("/menu/events", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["display"]);
    if (!claims.venueId || !claims.displayTokenId) throw new ApiError(403, "forbidden", "Сессия не привязана к экрану.");
    if (!services.events) throw new ApiError(503, "events_unavailable", "Уведомления недоступны.");
    const state = async () => {
      // Revalidate JWT expiry and revocation on connect/change, never on a timer.
      session(request, config);
      const [venue, token] = await Promise.all([
        services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId! }).catch(error => { if (error?.code === 404) return null; throw error; }),
        services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId! }).catch(() => null),
      ]);
      if (!venue || !token || token.active !== true || token.venueId !== claims.venueId || venue.active === false || claims.version !== Number(venue.displayVersion ?? 1)) return { revoked: true };
      return { version: Number(venue.menuVersion ?? 1), hash: (await menuSnapshot(services, databaseId, claims.venueId!)).etag };
    };
    const initial = await state();
    if ("revoked" in initial) throw new ApiError(401, "session_revoked", "Экран отключён.");
    menuStream(request, response, services.events, claims.venueId, state);
  }));

  router.get("/menu/version", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff", "display"]);
    if (!claims.venueId) throw new ApiError(403, "forbidden", "Сессия не привязана к точке.");
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId });
    if (claims.role === "display" && claims.displayTokenId) {
      const token = await services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId }).catch(() => null);
      if (!token || token.active !== true) throw new ApiError(401, "session_revoked", "Сессия экрана отозвана.");
      await services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId, data: { lastSeenAt: new Date().toISOString() } });
      await contact(claims.venueId, claims.displayTokenId);
    }
    if (venue.active === false || claims.version !== Number((claims.role === "staff" ? venue.staffVersion : venue.displayVersion) ?? 1)) throw new ApiError(401, "session_revoked", "Сессия отозвана. Выполните подключение заново.");
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    response.json({ version: Number(venue.menuVersion ?? 1), refreshSeconds: integer(venue.menuRefreshSeconds ?? 15, 5, 300) });
  }));

  router.patch("/venue", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const data: Record<string, unknown> = {};
    if (request.body?.name !== undefined) data.name = text(request.body.name, 160);
    for (const field of ["backgroundColor", "accentColor"] as const) {
      if (request.body?.[field] !== undefined) {
        const value = String(request.body[field]).toUpperCase();
        if (!HEX_COLOR.test(value)) throw new ApiError(400, "invalid_argument", "Цвет должен быть в формате #RRGGBB.");
        data[field] = value;
      }
    }
    if (request.body?.pageDurationSeconds !== undefined) data.pageDurationSeconds = integer(request.body.pageDurationSeconds, 5, 30);
    if (request.body?.displayScalePercent !== undefined) data.displayScalePercent = integer(request.body.displayScalePercent, 50, 160);
    for (const field of ["columnScale1Percent", "columnScale2Percent", "columnScale3Percent"] as const) if (request.body?.[field] !== undefined) data[field] = integer(request.body[field], 50, 160);
    if (request.body?.displayScaleMode !== undefined) {
      const mode = String(request.body.displayScaleMode);
      if (mode !== "auto" && mode !== "manual") throw new ApiError(400, "invalid_argument", "Некорректный режим масштаба.");
      data.displayScaleMode = mode;
    }
    if (request.body?.logoInsetPercent !== undefined) data.logoInsetPercent = integer(request.body.logoInsetPercent, 0, 20);
    if (request.body?.logoScalePercent !== undefined) data.logoScalePercent = integer(request.body.logoScalePercent, 50, 200);
    if (request.body?.breakPanelWidthPercent !== undefined) data.breakPanelWidthPercent = integer(request.body.breakPanelWidthPercent, 30, 50);
    if (request.body?.breakMenuDimPercent !== undefined) data.breakMenuDimPercent = integer(request.body.breakMenuDimPercent, 25, 75);
    if (request.body?.menuItemFontSizePx !== undefined) data.menuItemFontSizePx = integer(request.body.menuItemFontSizePx, 22, 54);
    if (request.body?.menuItemGapPx !== undefined) data.menuItemGapPx = integer(request.body.menuItemGapPx, 4, 28);
    if (request.body?.breakTransitionMs !== undefined) data.breakTransitionMs = integer(request.body.breakTransitionMs, 200, 1200);
    if (request.body?.displayPreset !== undefined) {
      const preset = String(request.body.displayPreset);
      if (!["compact", "balanced", "large"].includes(preset)) throw new ApiError(400, "invalid_argument", "Некорректный пресет отображения.");
      data.displayPreset = preset;
    }
    if (request.body?.breakExpiredText !== undefined) data.breakExpiredText = text(request.body.breakExpiredText, 80);
    for (const field of ["showServingSize", "showCalories"] as const) if (request.body?.[field] !== undefined) {
      if (typeof request.body[field] !== "boolean") throw new ApiError(400, "invalid_argument", `${field} должно быть логическим.`);
      data[field] = request.body[field];
    }
    data.updatedAt = new Date().toISOString();
    data.updatedBy = staffUpdatedBy(claims);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId!, data });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    await track(claims.venueId!, "venue_updated", staffActor(claims));
    response.json({ venue: publicRow(row) });
  }));

  router.post("/venue/break/start", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const duration = integer(request.body?.durationMinutes ?? 10, 1, 60);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId!, data: { breakActive: true, breakDurationMinutes: duration, breakEndsAt: new Date(Date.now() + duration * 60_000).toISOString(), updatedAt: new Date().toISOString(), updatedBy: staffUpdatedBy(claims) } });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    await track(claims.venueId!, "break_started", staffActor(claims));
    response.json({ venue: publicRow(row) });
  }));
  router.post("/venue/break/stop", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId!, data: { breakActive: false, breakEndsAt: null, updatedAt: new Date().toISOString(), updatedBy: staffUpdatedBy(claims) } });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    await track(claims.venueId!, "break_stopped", staffActor(claims));
    response.json({ venue: publicRow(row) });
  }));

  router.post("/categories", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const row = await services.tables.createRow<RowData>({
      databaseId, tableId: "categories", rowId: ID.unique(),
      data: { venueId: claims.venueId, name: text(request.body?.name, 160), sortOrder: integer(request.body?.sortOrder ?? 0, 0, 100000), updatedAt: new Date().toISOString(), updatedBy: staffUpdatedBy(claims) },
    });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    await track(claims.venueId!, "category_created", staffActor(claims), row.$id);
    response.status(201).json({ category: publicRow(row) });
  }));

  router.patch("/categories/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await ownedRow(services, config, "categories", rowId, claims.venueId!);
    const data: Record<string, unknown> = { updatedAt: new Date().toISOString(), updatedBy: staffUpdatedBy(claims) };
    if (request.body?.name !== undefined) data.name = text(request.body.name, 160);
    if (request.body?.sortOrder !== undefined) data.sortOrder = integer(request.body.sortOrder, 0, 100000);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "categories", rowId, data });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    await track(claims.venueId!, "category_updated", staffActor(claims), rowId);
    response.json({ category: publicRow(row) });
  }));

  router.delete("/categories/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await ownedRow(services, config, "categories", rowId, claims.venueId!);
    const children = await services.tables.listRows<RowData>({ databaseId, tableId: "items", queries: [Query.equal("categoryId", [rowId]), Query.limit(1)] });
    if (children.rows.length) throw new ApiError(409, "not_empty", "Сначала удалите позиции этой категории.");
    await services.tables.deleteRow({ databaseId, tableId: "categories", rowId });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    await track(claims.venueId!, "category_deleted", staffActor(claims), rowId);
    response.status(204).end();
  }));

  router.post("/items", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const categoryId = text(request.body?.categoryId, 36);
    await ownedRow(services, config, "categories", categoryId, claims.venueId!);
    const initialStock = request.body?.stockQuantity === undefined ? null : stockQuantity(request.body.stockQuantity);
    if (initialStock !== null && request.body?.isAvailable !== undefined && request.body.isAvailable !== (initialStock > 0)) {
      throw new ApiError(400, "invalid_argument", "Наличие определяется количеством штук.");
    }
    const row = await services.tables.createRow<RowData>({
      databaseId, tableId: "items", rowId: ID.unique(),
      data: {
        venueId: claims.venueId, categoryId, name: text(request.body?.name, 200),
        priceMinor: integer(request.body?.priceMinor, 0, 2_000_000_000), sortOrder: integer(request.body?.sortOrder ?? 0, 0, 100000),
        ...(request.body?.servingSize !== undefined && request.body.servingSize !== null && request.body.servingSize !== "" ? { servingSize: text(request.body.servingSize, 40) } : {}),
        ...(request.body?.caloriesKcal !== undefined && request.body.caloriesKcal !== null && request.body.caloriesKcal !== "" ? { caloriesKcal: integer(request.body.caloriesKcal, 0, 100000) } : {}),
        ...(initialStock === null ? {} : { stockQuantity: initialStock }),
        isAvailable: initialStock === null ? request.body?.isAvailable !== false : initialStock > 0,
        updatedAt: new Date().toISOString(), updatedBy: staffUpdatedBy(claims),
      },
    });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    await track(claims.venueId!, "item_created", staffActor(claims), row.$id);
    response.status(201).json({ item: publicRow(row) });
  }));

  router.patch("/items/bulk-availability", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const itemIds = normalizeBulkAvailabilityIds(request.body?.itemIds);
    if (typeof request.body?.isAvailable !== "boolean") {
      throw new ApiError(400, "invalid_argument", "Поле isAvailable должно быть логическим.");
    }
    const isAvailable = request.body.isAvailable;
    await withItems(itemIds, async () => {
      const existing = await Promise.all(itemIds.map((itemId) => ownedRow(services, config, "items", itemId, claims.venueId!)));
      if (existing.some(trackedStock)) throw new ApiError(409, "stock_managed", "Для позиции с остатком измените количество штук.");
      const now = new Date().toISOString();
      const updated = await Promise.all(existing.map((item) => services.tables.updateRow<RowData>({
        databaseId, tableId: "items", rowId: item.$id,
        data: { isAvailable, updatedAt: now, updatedBy: staffUpdatedBy(claims) },
      })));
      await bumpMenuVersion(services, databaseId, claims.venueId!);
      if (existing.some(item => item.isAvailable !== isAvailable)) await track(claims.venueId!, "availability_changed", staffActor(claims));
      const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId! });
      response.json({ updatedCount: updated.length, items: updated.map(publicRow), menuVersion: Number(venue.menuVersion ?? 1) });
    });
  }));

  router.post("/items/:id/stock/adjust", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await withItems([rowId], async () => {
      const current = await ownedRow(services, config, "items", rowId, claims.venueId!);
      if (!trackedStock(current)) throw new ApiError(409, "stock_unset", "Сначала задайте количество штук.");
      const delta = Number(request.body?.delta);
      if (delta !== 1 && delta !== -1) throw new ApiError(400, "invalid_argument", "Изменение количества должно быть +1 или −1.");
      if (delta < 0 && Number(current.stockQuantity) === 0) throw new ApiError(409, "stock_empty", "Остаток уже равен нулю.");
      const args = { databaseId, tableId: "items", rowId, column: "stockQuantity", value: 1 };
      let row: RowData;
      try {
        row = delta < 0
          ? await services.tables.decrementRowColumn<RowData>({ ...args, min: 0 })
          : await services.tables.incrementRowColumn<RowData>({ ...args, max: 2_000_000_000 });
      } catch (cause) {
        const latest = await services.tables.getRow<RowData>({ databaseId, tableId: "items", rowId }).catch(() => null);
        if (latest && ((delta < 0 && Number(latest.stockQuantity) === 0) || (delta > 0 && Number(latest.stockQuantity) >= 2_000_000_000))) {
          throw new ApiError(409, "stock_limit", delta < 0 ? "Остаток уже равен нулю." : "Достигнут предел количества штук.");
        }
        throw cause;
      }
      await bumpMenuVersion(services, databaseId, claims.venueId!);
      await track(claims.venueId!, "stock_adjusted", staffActor(claims), rowId);
      if ((delta === 1 && Number(row.stockQuantity) === 1) || (delta === -1 && Number(row.stockQuantity) === 0)) await track(claims.venueId!, "availability_changed", staffActor(claims), rowId);
      response.json({ item: publicRow(row) });
    });
  }));

  router.patch("/items/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await withItems([rowId], async () => {
      const current = await ownedRow(services, config, "items", rowId, claims.venueId!);
      const data: Record<string, unknown> = { updatedAt: new Date().toISOString(), updatedBy: staffUpdatedBy(claims) };
      if (request.body?.isAvailable !== undefined) {
        if (trackedStock(current) || request.body?.stockQuantity !== undefined) throw new ApiError(409, "stock_managed", "Для позиции с остатком измените количество штук.");
        if (typeof request.body.isAvailable !== "boolean") throw new ApiError(400, "invalid_argument", "Поле isAvailable должно быть логическим.");
        data.isAvailable = request.body.isAvailable;
      }
      if (request.body?.stockQuantity !== undefined) data.stockQuantity = stockQuantity(request.body.stockQuantity);
      if (request.body?.name !== undefined) data.name = text(request.body.name, 200);
      if (request.body?.priceMinor !== undefined) data.priceMinor = integer(request.body.priceMinor, 0, 2_000_000_000);
      if (request.body?.servingSize !== undefined) data.servingSize = request.body.servingSize === null || request.body.servingSize === "" ? null : text(request.body.servingSize, 40);
      if (request.body?.caloriesKcal !== undefined) data.caloriesKcal = request.body.caloriesKcal === null || request.body.caloriesKcal === "" ? null : integer(request.body.caloriesKcal, 0, 100000);
      if (request.body?.sortOrder !== undefined) data.sortOrder = integer(request.body.sortOrder, 0, 100000);
      const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "items", rowId, data });
      await bumpMenuVersion(services, databaseId, claims.venueId!);
      await track(claims.venueId!, "item_updated", staffActor(claims), rowId);
      if (data.stockQuantity !== undefined && data.stockQuantity !== current.stockQuantity) await track(claims.venueId!, "stock_adjusted", staffActor(claims), rowId);
      if (available(current) !== available(row)) await track(claims.venueId!, "availability_changed", staffActor(claims), rowId);
      response.json({ item: publicRow(row) });
    });
  }));

  router.delete("/items/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await withItems([rowId], async () => {
      await ownedRow(services, config, "items", rowId, claims.venueId!);
      await services.tables.deleteRow({ databaseId, tableId: "items", rowId });
      await bumpMenuVersion(services, databaseId, claims.venueId!);
      await track(claims.venueId!, "item_deleted", staffActor(claims), rowId);
      response.status(204).end();
    });
  }));

  router.post("/display/rotate", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    await revokeDisplayTokens(services, databaseId, claims.venueId!, new Date().toISOString());
    const next = await createDisplayToken(services, config, claims.venueId!);
    await track(claims.venueId!, "display_link_created", staffActor(claims), next.tokenId);
    response.status(201).json({ displayUrl: next.url });
  }));

  router.post("/display/pairings", asyncRoute(async (_request, response) => {
    const tokenId = ID.unique();
    const secret = opaqueToken();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await services.tables.createRow({ databaseId, tableId: "display_pairings", rowId: tokenId, data: { tokenHash: await hashSecret(secret), status: "pending", expiresAt, createdAt: new Date().toISOString() } });
    const pairingToken = `${tokenId}.${secret}`;
    const pairingUrl = `${config.displayBaseUrl}/pair#${pairingToken}`;
    const qrSvg = await QRCode.toString(pairingUrl, { type: "svg", width: 360, margin: 2, errorCorrectionLevel: "M" });
    response.status(201).json({ pairingToken, displayBaseUrl: config.displayBaseUrl, expiresInSeconds: 300, qrSvg });
  }));

  router.post("/display/pairings/complete", asyncRoute(async (request, response) => {
    const match = /^([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})$/.exec(String(request.body?.pairingToken ?? ""));
    const code = String(request.body?.venueCode ?? "").trim().toLowerCase();
    const pin = String(request.body?.pin ?? "");
    if (!match || !VENUE_CODE.test(code) || !PIN.test(pin)) throw new ApiError(400, "invalid_argument", "Некорректные данные подключения.");
    const pairing = await services.tables.getRow<RowData>({ databaseId, tableId: "display_pairings", rowId: match[1] }).catch(() => null);
    if (!pairing || !["pending", "complete"].includes(String(pairing.status)) || new Date(String(pairing.expiresAt)).getTime() < Date.now() || !(await verifySecret(match[2], String(pairing.tokenHash ?? "")))) throw new ApiError(401, "unauthenticated", "QR-код подключения недействителен или истёк.");
    const venue = await venueByCode(services, config, code);
    if (!venue || venue.active === false || !(await verifySecret(pin, String(venue.pinHash ?? "")))) throw new ApiError(401, "unauthenticated", "Неверный код заведения или PIN.");
    if (pairing.status === "complete") {
      const credentials = /^([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})$/.exec(String(pairing.displayUrl ?? "").split("#")[1] ?? "");
      const token = credentials ? await services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: credentials[1] }).catch(() => null) : null;
      if (!credentials || pairing.venueId !== venue.$id || !token || token.venueId !== venue.$id || token.active !== true || !(await verifySecret(credentials[2], String(token.tokenHash ?? "")))) throw new ApiError(409, "pairing_used", "Этот QR-код уже использован или экран отозван.");
      response.json({ displayUrl: pairing.displayUrl, venueId: venue.$id });
      return;
    }
    const screen = await claimPairingDisplay(services, config, pairing.$id, match[2], venue.$id);
    await services.tables.updateRow({ databaseId, tableId: "display_pairings", rowId: pairing.$id, data: { status: "complete", venueId: venue.$id, displayUrl: screen.url } });
    response.json({ displayUrl: screen.url, venueId: venue.$id });
  }));

  router.get("/display/pairings/:id", asyncRoute(async (request, response) => {
    const secret = String(request.query.secret ?? "");
    const pairing = await services.tables.getRow<RowData>({ databaseId, tableId: "display_pairings", rowId: routeId(request.params.id) }).catch(() => null);
    if (!pairing || !(await verifySecret(secret, String(pairing.tokenHash ?? "")))) throw new ApiError(401, "unauthenticated", "QR-код подключения недействителен.");
    if (pairing.status === "pending" && new Date(String(pairing.expiresAt)).getTime() < Date.now()) {
      response.json({ status: "expired", displayUrl: null });
      return;
    }
    response.json({ status: pairing.status, displayUrl: pairing.displayUrl ?? null });
  }));

  router.post("/client-logs", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff", "display"]);
    const level = String(request.body?.level ?? "error");
    if (!["debug", "info", "warn", "error"].includes(level)) throw new ApiError(400, "invalid_argument", "Некорректный уровень журнала.");
    await services.tables.createRow({ databaseId, tableId: "client_logs", rowId: ID.unique(), data: { venueId: claims.venueId, client: claims.role, level, message: sanitizeDiagnostic(text(request.body?.message, 2000)), contextJson: safeDiagnosticDetails(request.body?.details), createdAt: new Date().toISOString() } });
    response.status(202).json({ accepted: true });
  }));

  return router;
}
