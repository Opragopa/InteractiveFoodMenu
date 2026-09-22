import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { ID, Query, type Models } from "node-appwrite";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { hashSecret, opaqueToken, signSession, verifySecret, verifySession, type SessionClaims, type SessionRole } from "./security.js";

const VENUE_CODE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const PIN = /^\d{6}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
    const [venues, categories, items, logs] = await Promise.all([
      services.tables.listRows<RowData>({ databaseId, tableId: "venues", queries: [Query.orderAsc("name"), Query.limit(200)] }),
      services.tables.listRows<RowData>({ databaseId, tableId: "categories", queries: [Query.limit(1)], total: true }),
      services.tables.listRows<RowData>({ databaseId, tableId: "items", queries: [Query.limit(1)], total: true }),
      services.tables.listRows<RowData>({ databaseId, tableId: "client_logs", queries: [Query.orderDesc("createdAt"), Query.limit(30)] }),
    ]);
    response.json({ venues: venues.rows.map(publicRow), counts: { venues: venues.total, categories: categories.total, items: items.total }, logs: logs.rows.map(publicRow) });
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
        backgroundColor: "#F7F4EE", accentColor: "#9C3D24", pageDurationSeconds: 10,
        displayScalePercent: 100, staffVersion: 1, displayVersion: 1, active: true,
        updatedAt: now, updatedBy: "backend-hub",
      },
    });
    response.status(201).json({ venue: publicRow(row) });
  }));

  router.post("/auth/staff", asyncRoute(async (request, response) => {
    const code = String(request.body?.venueCode ?? "").trim().toLowerCase();
    const pin = String(request.body?.pin ?? "");
    if (!VENUE_CODE.test(code) || !PIN.test(pin)) throw new ApiError(400, "invalid_argument", "Проверьте код точки и шестизначный PIN.");
    const venue = await venueByCode(services, config, code);
    if (!venue || venue.active === false || !(await verifySecret(pin, String(venue.pinHash ?? "")))) {
      throw new ApiError(401, "unauthenticated", "Неверный код точки или PIN.");
    }
    response.json({ token: signSession({ role: "staff", venueId: venue.$id }, config.sessionSecret), venueId: venue.$id });
  }));

  router.post("/auth/display", asyncRoute(async (request, response) => {
    const tokenId = String(request.body?.tokenId ?? "");
    const secret = String(request.body?.secret ?? "");
    const token = await services.tables.getRow<RowData>({ databaseId, tableId: "display_tokens", rowId: tokenId }).catch(() => null);
    if (!token || token.active !== true || !(await verifySecret(secret, String(token.tokenHash ?? "")))) {
      throw new ApiError(401, "unauthenticated", "Ссылка экрана недействительна.");
    }
    response.json({ token: signSession({ role: "display", venueId: String(token.venueId) }, config.sessionSecret, "30d"), venueId: token.venueId });
  }));

  router.get("/menu", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff", "display"]);
    if (!claims.venueId) throw new ApiError(403, "forbidden", "Сессия не привязана к точке.");
    const [venue, categories, items] = await Promise.all([
      services.tables.getRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId }),
      services.tables.listRows<RowData>({ databaseId, tableId: "categories", queries: [Query.equal("venueId", [claims.venueId]), Query.orderAsc("sortOrder"), Query.limit(500)] }),
      services.tables.listRows<RowData>({ databaseId, tableId: "items", queries: [Query.equal("venueId", [claims.venueId]), Query.limit(5000)] }),
    ]);
    response.json({ venue: publicRow(venue), categories: categories.rows.map(publicRow), items: items.rows.map(publicRow) });
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
    data.updatedAt = new Date().toISOString();
    data.updatedBy = "staff-api";
    const row = await services.tables.updateRow<RowData>({ databaseId, tableId: "venues", rowId: claims.venueId!, data });
    response.json({ venue: publicRow(row) });
  }));

  router.post("/categories", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const row = await services.tables.createRow<RowData>({
      databaseId, tableId: "categories", rowId: ID.unique(),
      data: { venueId: claims.venueId, name: text(request.body?.name, 160), sortOrder: integer(request.body?.sortOrder ?? 0, 0, 100000), updatedAt: new Date().toISOString(), updatedBy: "staff-api" },
    });
    response.status(201).json({ category: publicRow(row) });
  }));

  router.delete("/categories/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await ownedRow(services, config, "categories", rowId, claims.venueId!);
    const children = await services.tables.listRows<RowData>({ databaseId, tableId: "items", queries: [Query.equal("categoryId", [rowId]), Query.limit(1)] });
    if (children.rows.length) throw new ApiError(409, "not_empty", "Сначала удалите позиции этой категории.");
    await services.tables.deleteRow({ databaseId, tableId: "categories", rowId });
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
    response.json({ item: publicRow(row) });
  }));

  router.delete("/items/:id", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const rowId = routeId(request.params.id);
    await ownedRow(services, config, "items", rowId, claims.venueId!);
    await services.tables.deleteRow({ databaseId, tableId: "items", rowId });
    response.status(204).end();
  }));

  router.post("/display/rotate", asyncRoute(async (request, response) => {
    const claims = requireRole(request, config, ["staff"]);
    const tokenId = ID.unique();
    const secret = opaqueToken();
    const existing = await services.tables.listRows<RowData>({ databaseId, tableId: "display_tokens", queries: [Query.equal("venueId", [claims.venueId!]), Query.equal("active", [true]), Query.limit(100)] });
    await Promise.all(existing.rows.map(row => services.tables.updateRow({ databaseId, tableId: "display_tokens", rowId: row.$id, data: { active: false, revokedAt: new Date().toISOString() } })));
    await services.tables.createRow({ databaseId, tableId: "display_tokens", rowId: tokenId, data: { venueId: claims.venueId, tokenHash: await hashSecret(secret), active: true, createdAt: new Date().toISOString() } });
    const displayUrl = `${config.displayBaseUrl}/display/${tokenId}.${secret}`;
    response.status(201).json({ displayUrl });
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
