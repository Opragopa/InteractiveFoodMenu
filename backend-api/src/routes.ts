import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { ID, Query, type Models } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import QRCode from "qrcode";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { hashSecret, opaqueToken, signSession, verifySecret, verifySession, type SessionClaims, type SessionRole } from "./security.js";

const VENUE_CODE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const PIN = /^\d{6}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const LOGO_POSITIONS = new Set(["top-right", "top-left", "bottom-right", "bottom-left"]);
const LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type RowData = Models.Row & Record<string, unknown>;

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
    return verifySession(bearer(request), config.sessionSecret);
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

function routeId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function logoPosition(value: unknown): string {
  const result = String(value ?? "");
  if (!LOGO_POSITIONS.has(result)) throw new ApiError(400, "invalid_argument", "Некорректное расположение логотипа.");
  return result;
}

function publicRow(row: RowData): Record<string, unknown> {
  const result: Record<string, unknown> = { id: row.$id };
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("$") && !["pinHash", "tokenHash"].includes(key)) result[key] = value;
  }
  return result;
}

async function venueByCode(services: AppwriteServices, config: BackendConfig, code: string): Promise<RowData | null> {
  const result = await services.tables.listRows<RowData>({
    databaseId: config.appwriteDatabaseId,
    tableId: "venues",
    queries: [Query.equal("code", [code]), Query.limit(1)],
  });
  return result.rows[0] ?? null;
}

async function ownedRow(services: AppwriteServices, config: BackendConfig, tableId: string, rowId: string, venueId: string): Promise<RowData> {
  const row = await services.tables.getRow<RowData>({ databaseId: config.appwriteDatabaseId, tableId, rowId });
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

async function audit(services: AppwriteServices, config: BackendConfig, action: string, venueId: string | undefined, details: Record<string, unknown> = {}) {
  await services.tables.createRow({
    databaseId: config.appwriteDatabaseId, tableId: "admin_audit_logs", rowId: ID.unique(),
    data: { venueId, action, actor: "backend-hub", detailsJson: JSON.stringify(details), createdAt: new Date().toISOString() },
  });
}

async function bumpMenuVersion(services: AppwriteServices, databaseId: string, venueId: string) {
  // Keep this compatible with self-hosted Appwrite versions where the
  // increment endpoint can acknowledge the request without updating the
  // row used by display polling.
  const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId });
  await services.tables.updateRow({
    databaseId,
    tableId: "venues",
    rowId: venueId,
    data: { menuVersion: Number(venue.menuVersion ?? 1) + 1 },
  });
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
  const databaseId = config.appwriteDatabaseId;

  router.post("/hub/login", asyncRoute(async (request, response) => {
    const accessKey = String(request.body?.accessKey ?? "");
    const valid = Buffer.byteLength(accessKey) === Buffer.byteLength(config.hubAccessKey)
      && await import("node:crypto").then(({ timingSafeEqual }) => timingSafeEqual(Buffer.from(accessKey), Buffer.from(config.hubAccessKey)));
    if (!valid) throw new ApiError(401, "unauthenticated", "Неверный ключ Backend Hub.");
    response.json({ token: signSession({ role: "hub" }, config.sessionSecret, "4h") });
  }));

  router.get("/hub/overview", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const [venues, categories, items, displays, logs, auditLogs] = await Promise.all([
      services.tables.listRows<RowData>({ databaseId, tableId: "venues", queries: [Query.orderAsc("name"), Query.limit(200)] }),
      services.tables.listRows<RowData>({ databaseId, tableId: "categories", queries: [Query.limit(1)], total: true }),
      services.tables.listRows<RowData>({ databaseId, tableId: "items", queries: [Query.limit(1)], total: true }),
      services.tables.listRows<RowData>({ databaseId, tableId: "display_tokens", queries: [Query.equal("active", [true]), Query.limit(1)], total: true }),
      services.tables.listRows<RowData>({ databaseId, tableId: "client_logs", queries: [Query.orderDesc("createdAt"), Query.limit(30)] }),
      services.tables.listRows<RowData>({ databaseId, tableId: "admin_audit_logs", queries: [Query.orderDesc("createdAt"), Query.limit(20)] }),
    ]);
    response.json({
      generatedAt: new Date().toISOString(),
      totals: { venues: venues.total, categories: categories.total, items: items.total, activeDisplays: displays.total },
      venues: venues.rows.map(publicRow),
      functions: [
        { name: "auth/staff", area: "Доступ", access: "Публичная", purpose: "Вход сотрудника по коду точки и PIN" },
        { name: "display/pairings", area: "Экраны", access: "Публичная", purpose: "Одноразовое подключение ТВ через QR-код" },
        { name: "menu", area: "Меню", access: "Сессия", purpose: "Выдача актуального меню клиентам" },
      ],
      clientLogs: logs.rows.map(row => ({ ...publicRow(row), event: row.message, role: row.client })),
      auditLogs: auditLogs.rows.map(publicRow),
    });
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
        displayScalePercent: 100, displayScaleMode: "auto", breakActive: false, breakDurationMinutes: 10, breakFontSizePercent: 100, staffVersion: 1, displayVersion: 1, menuVersion: 1, menuRefreshSeconds: 15, active: true,
        updatedAt: now, updatedBy: "backend-hub",
      },
    });
    const screen = await createDisplayToken(services, config, row.$id);
    await audit(services, config, "venue_created", row.$id, { code });
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
    await audit(services, config, "venue_pin_rotated", venueId, { code });
    response.json({ updated: true, venue: publicRow(row) });
  }));

  router.post("/hub/venues/:id/display", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!venue) throw new ApiError(404, "not_found", "Точка не найдена.");
    const screen = await createDisplayToken(services, config, venueId);
    await audit(services, config, "display_link_created", venueId, { tokenId: screen.tokenId });
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
    if (request.body?.pageDurationSeconds !== undefined) data.pageDurationSeconds = integer(request.body.pageDurationSeconds, 5, 60);
    if (request.body?.displayScalePercent !== undefined) data.displayScalePercent = integer(request.body.displayScalePercent, 50, 160);
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
    const removeLogoFileId = request.body?.logoFileId === null && typeof venue.logoFileId === "string" ? venue.logoFileId : "";
    if (request.body?.logoFileId === null) data.logoFileId = null;
    data.updatedAt = new Date().toISOString();
    data.updatedBy = "backend-hub";
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: venueId, data });
    await bumpMenuVersion(services, databaseId, venueId);
    if (removeLogoFileId) await services.storage.deleteFile({ bucketId: config.appwriteBucketId, fileId: removeLogoFileId }).catch(() => undefined);
    await audit(services, config, "venue_settings_updated", venueId, data);
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
    await audit(services, config, "venue_logo_uploaded", venueId, { fileId: file.$id, mimeType });
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
    const existing = await services.tables.listRows<RowData>({ databaseId, tableId: "display_tokens", queries: [Query.equal("venueId", [venueId]), Query.equal("active", [true]), Query.limit(100)] });
    await Promise.all(existing.rows.map(row => services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: row.$id, data: { active: false, revokedAt: now } })));
    await services.tables.updateRow({ databaseId, tableId: "venues", rowId: venueId, data: { staffVersion: Number(venue.staffVersion ?? 0) + 1, displayVersion: Number(venue.displayVersion ?? 0) + 1, updatedAt: now, updatedBy: "backend-hub" } });
    await audit(services, config, "venue_sessions_revoked", venueId, { scope: "all" });
    response.json({ revoked: true });
  }));

  router.get("/hub/venues/:id/displays", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id);
    const result = await services.tables.listRows<RowData>({ databaseId, tableId: "display_tokens", queries: [Query.equal("venueId", [venueId]), Query.orderDesc("createdAt"), Query.limit(200)] });
    response.json({ displays: result.rows.map(publicRow) });
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
    await audit(services, config, "display_session_revoked", venueId, { tokenId });
    response.json({ revoked: true });
  }));
  router.post("/hub/venues/:id/displays/revoke-all", asyncRoute(async (request, response) => {
    requireRole(request, config, ["hub"]);
    const venueId = routeId(request.params.id); const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: venueId });
    const now = new Date().toISOString();
    const active = await services.tables.listRows<RowData>({ databaseId, tableId: "display_tokens", queries: [Query.equal("venueId", [venueId]), Query.equal("active", [true]), Query.limit(200)] });
    await Promise.all(active.rows.map(row => services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: row.$id, data: { active: false, revokedAt: now } })));
    await services.tables.updateRow({ databaseId, tableId: "venues", rowId: venueId, data: { displayVersion: Number(venue.displayVersion ?? 0) + 1, updatedAt: now, updatedBy: "backend-hub" } });
    response.json({ revoked: active.rows.length });
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
    for (const tableId of ["items", "categories", "display_tokens", "display_pairings", "client_logs", "admin_audit_logs"]) {
      await deleteVenueRows(services, databaseId, tableId, venueId, row => {
        if (tableId === "items" && typeof row.imageFileId === "string" && row.imageFileId) assetIds.add(row.imageFileId);
      });
    }
    await services.tables.deleteRow({ databaseId, tableId: "venues", rowId: venueId });
    await Promise.all([...assetIds].map(fileId => services.storage.deleteFile({ bucketId: config.appwriteBucketId, fileId }).catch(() => undefined)));
    response.status(204).end();
  }));

  router.post("/auth/staff", asyncRoute(async (request, response) => {
    const code = String(request.body?.venueCode ?? "").trim().toLowerCase();
    const pin = String(request.body?.pin ?? "");
    if (!VENUE_CODE.test(code) || !PIN.test(pin)) throw new ApiError(400, "invalid_argument", "Проверьте код точки и шестизначный PIN.");
    const venue = await venueByCode(services, config, code);
    if (!venue || venue.active === false || !(await verifySecret(pin, String(venue.pinHash ?? "")))) {
      throw new ApiError(401, "unauthenticated", "Неверный код точки или PIN.");
    }
    response.json({ token: signSession({ role: "staff", venueId: venue.$id, version: Number(venue.staffVersion ?? 1) }, config.sessionSecret), venueId: venue.$id });
  }));

  router.post("/auth/display", asyncRoute(async (request, response) => {
    const tokenId = String(request.body?.tokenId ?? "");
    const secret = String(request.body?.secret ?? "");
    const token = await services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: tokenId }).catch(() => null);
    if (!token || token.active !== true || !(await verifySecret(secret, String(token.tokenHash ?? "")))) {
      throw new ApiError(401, "unauthenticated", "Ссылка экрана недействительна.");
    }
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: String(token.venueId) });
    response.json({ token: signSession({ role: "display", venueId: String(token.venueId), displayTokenId: token.$id, version: Number(venue.displayVersion ?? 1) }, config.sessionSecret, "30d"), venueId: token.venueId });
  }));

  router.get("/menu", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff", "display"]);
    if (!claims.venueId) throw new ApiError(403, "forbidden", "Сессия не привязана к точке.");
    if (claims.role === "display" && claims.displayTokenId) {
      const token = await services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId }).catch(() => null);
      if (!token || token.active !== true || token.venueId !== claims.venueId) throw new ApiError(401, "session_revoked", "Сессия экрана отозвана.");
      await services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId, data: { lastSeenAt: new Date().toISOString() } });
    }
    const [venue, categories, items] = await Promise.all([
      services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId }),
      services.tables.listRows<RowData>({ databaseId, tableId: "categories", queries: [Query.equal("venueId", [claims.venueId]), Query.orderAsc("sortOrder"), Query.limit(500)] }),
      services.tables.listRows<RowData>({ databaseId, tableId: "items", queries: [Query.equal("venueId", [claims.venueId]), Query.limit(5000)] }),
    ]);
    const expectedVersion = claims.role === "staff" ? venue.staffVersion : venue.displayVersion;
    if (claims.version !== Number(expectedVersion ?? 1)) throw new ApiError(401, "session_revoked", "Сессия отозвана. Выполните вход заново.");
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    const expiredBreak = venue.breakActive === true && venue.breakEndsAt && new Date(String(venue.breakEndsAt)).getTime() <= Date.now();
    if (expiredBreak) {
      await services.tables.updateRow({ databaseId, tableId: "venues", rowId: claims.venueId, data: { breakActive: false, breakEndsAt: null } });
      venue.breakActive = false; venue.breakEndsAt = null;
    }
    response.json({ venue: publicRow(venue), categories: categories.rows.map(publicRow), items: items.rows.map(publicRow) });
  }));

  router.get("/menu/version", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["display"]);
    if (!claims.venueId) throw new ApiError(403, "forbidden", "Сессия не привязана к точке.");
    const venue = await services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId });
    if (claims.displayTokenId) {
      const token = await services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId }).catch(() => null);
      if (!token || token.active !== true) throw new ApiError(401, "session_revoked", "Сессия экрана отозвана.");
      await services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: claims.displayTokenId, data: { lastSeenAt: new Date().toISOString() } });
    }
    if (claims.version !== Number(venue.displayVersion ?? 1)) throw new ApiError(401, "session_revoked", "Сессия отозвана. Выполните подключение заново.");
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
    if (request.body?.pageDurationSeconds !== undefined) data.pageDurationSeconds = integer(request.body.pageDurationSeconds, 5, 60);
    if (request.body?.displayScalePercent !== undefined) data.displayScalePercent = integer(request.body.displayScalePercent, 50, 160);
    if (request.body?.logoInsetPercent !== undefined) data.logoInsetPercent = integer(request.body.logoInsetPercent, 0, 20);
    if (request.body?.logoScalePercent !== undefined) data.logoScalePercent = integer(request.body.logoScalePercent, 50, 200);
    data.updatedAt = new Date().toISOString();
    data.updatedBy = "staff-api";
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId!, data });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    response.json({ venue: publicRow(row) });
  }));

  router.post("/venue/break/start", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const duration = integer(request.body?.durationMinutes ?? 10, 1, 60);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId!, data: { breakActive: true, breakDurationMinutes: duration, breakEndsAt: new Date(Date.now() + duration * 60_000).toISOString(), updatedAt: new Date().toISOString(), updatedBy: "staff-api" } });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    response.json({ venue: publicRow(row) });
  }));
  router.post("/venue/break/stop", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId!, data: { breakActive: false, breakEndsAt: null, updatedAt: new Date().toISOString(), updatedBy: "staff-api" } });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    response.json({ venue: publicRow(row) });
  }));

  router.post("/categories", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const row = await services.tables.createRow<RowData>({
      databaseId, tableId: "categories", rowId: ID.unique(),
      data: { venueId: claims.venueId, name: text(request.body?.name, 160), sortOrder: integer(request.body?.sortOrder ?? 0, 0, 100000), updatedAt: new Date().toISOString(), updatedBy: "staff-api" },
    });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    response.status(201).json({ category: publicRow(row) });
  }));

  router.patch("/categories/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await ownedRow(services, config, "categories", rowId, claims.venueId!);
    const data: Record<string, unknown> = { updatedAt: new Date().toISOString(), updatedBy: "staff-api" };
    if (request.body?.name !== undefined) data.name = text(request.body.name, 160);
    if (request.body?.sortOrder !== undefined) data.sortOrder = integer(request.body.sortOrder, 0, 100000);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "categories", rowId, data });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
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
    response.status(204).end();
  }));

  router.post("/items", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const categoryId = text(request.body?.categoryId, 36);
    await ownedRow(services, config, "categories", categoryId, claims.venueId!);
    const row = await services.tables.createRow<RowData>({
      databaseId, tableId: "items", rowId: ID.unique(),
      data: {
        venueId: claims.venueId, categoryId, name: text(request.body?.name, 200),
        priceMinor: integer(request.body?.priceMinor, 0, 2_000_000_000), sortOrder: integer(request.body?.sortOrder ?? 0, 0, 100000),
        isAvailable: request.body?.isAvailable !== false, updatedAt: new Date().toISOString(), updatedBy: "staff-api",
      },
    });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    response.status(201).json({ item: publicRow(row) });
  }));

  router.patch("/items/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await ownedRow(services, config, "items", rowId, claims.venueId!);
    const data: Record<string, unknown> = { updatedAt: new Date().toISOString(), updatedBy: "staff-api" };
    if (request.body?.isAvailable !== undefined) data.isAvailable = Boolean(request.body.isAvailable);
    if (request.body?.name !== undefined) data.name = text(request.body.name, 200);
    if (request.body?.priceMinor !== undefined) data.priceMinor = integer(request.body.priceMinor, 0, 2_000_000_000);
    if (request.body?.sortOrder !== undefined) data.sortOrder = integer(request.body.sortOrder, 0, 100000);
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "items", rowId, data });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    response.json({ item: publicRow(row) });
  }));

  router.delete("/items/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await ownedRow(services, config, "items", rowId, claims.venueId!);
    await services.tables.deleteRow({ databaseId, tableId: "items", rowId });
    await bumpMenuVersion(services, databaseId, claims.venueId!);
    response.status(204).end();
  }));

  router.post("/display/rotate", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const existing = await services.tables.listRows<RowData>({ databaseId, tableId: "display_tokens", queries: [Query.equal("venueId", [claims.venueId!]), Query.equal("active", [true]), Query.limit(100)] });
    await Promise.all(existing.rows.map(row => services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: row.$id, data: { active: false, revokedAt: new Date().toISOString() } })));
    const next = await createDisplayToken(services, config, claims.venueId!);
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
    if (!pairing || pairing.status !== "pending" || new Date(String(pairing.expiresAt)).getTime() < Date.now() || !(await verifySecret(match[2], String(pairing.tokenHash ?? "")))) throw new ApiError(401, "unauthenticated", "QR-код подключения недействителен или истёк.");
    const venue = await venueByCode(services, config, code);
    if (!venue || !(await verifySecret(pin, String(venue.pinHash ?? "")))) throw new ApiError(401, "unauthenticated", "Неверный код заведения или PIN.");
    const screen = await createDisplayToken(services, config, venue.$id);
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
    await services.tables.createRow({ databaseId, tableId: "client_logs", rowId: ID.unique(), data: { venueId: claims.venueId, client: claims.role, level, message: text(request.body?.message, 2000), contextJson: JSON.stringify(request.body?.details ?? {}).slice(0, 10000), createdAt: new Date().toISOString() } });
    response.status(202).json({ accepted: true });
  }));

  return router;
}
