import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { hash, verify } from "@node-rs/argon2";
import { AppwriteException, ID, Query, type Models } from "node-appwrite";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { opaqueToken, signSession, verifySession, type SessionClaims } from "./security.js";
import { recordStatisticsEvent } from "./statistics.js";

type Row = Models.Row & Record<string, unknown>;
const USERNAME = /^[a-z][a-z0-9._-]{2,39}$/;
const STAFF_COOKIE = "ifm_staff";
const HUB_COOKIE = "ifm_hub";
const INVITE = /^([A-Za-z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,80})$/;
const dummyHash = hash("invalid-account-placeholder");

export function authToken(request: Request): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.header("authorization") ?? "");
  if (bearer) return bearer[1];
  const name = request.originalUrl.split("?")[0].startsWith("/api/hub") ? HUB_COOKIE : STAFF_COOKIE;
  const cookie = (request.header("cookie") ?? "").split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1) ?? "";
}

function isCookieRequest(request: Request) { return !request.header("authorization") && Boolean(authToken(request)); }

export function setAccountCookie(request: Request, response: Response, value: string, seconds: number, role: "hub" | "staff") {
  const secure = request.secure || request.header("x-forwarded-proto") === "https";
  const name = role === "hub" ? HUB_COOKIE : STAFF_COOKIE;
  const path = role === "hub" ? "/api/hub" : "/api";
  response.append("Set-Cookie", `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? "; Secure" : ""}`);
  response.set("Cache-Control", "no-store");
}

export function accountSession(request: Request, config: BackendConfig): SessionClaims {
  try { return verifySession(authToken(request), config.sessionSecret); }
  catch { throw new AccountError(401, "Требуется вход."); }
}

class AccountError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(next);
}

function accountName(input: unknown) {
  const value = String(input ?? "").trim().toLowerCase();
  if (!USERNAME.test(value)) throw new AccountError(400, "Логин: 3–40 латинских символов, цифр, точки, дефиса или подчёркивания.");
  return value;
}

function password(input: unknown) {
  const value = String(input ?? "");
  if (value.length < 12 || value.length > 128 || Buffer.byteLength(value) > 256) throw new AccountError(400, "Пароль должен содержать от 12 до 128 символов.");
  return value;
}

async function findOne(services: AppwriteServices, databaseId: string, tableId: string, queries: string[]) {
  const result = await services.tables.listRows<Row>({ databaseId, tableId, queries: [...queries, Query.limit(1)] });
  return result.rows[0] ?? null;
}

function fingerprint(secret: string) { return createHash("sha256").update(secret).digest("hex"); }

async function checkPassword(input: string, stored: unknown) {
  const digest = typeof stored === "string" && stored.startsWith("$argon2id$") ? stored : await dummyHash;
  try { return await verify(digest, input); } catch { return false; }
}

async function createInvitation(services: AppwriteServices, config: BackendConfig, venueId: string, staffId?: string) {
  const place = await services.tables.getRow<Row>({ databaseId: config.appwriteDatabaseId, tableId: "venues", rowId: venueId });
  const id = ID.unique();
  const secret = opaqueToken();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  await services.tables.createRow({ databaseId: config.appwriteDatabaseId, tableId: "staff_invites", rowId: id,
    data: { venueId, ...(staffId ? { staffId } : {}), tokenHash: fingerprint(secret), expiresAt, createdAt: new Date().toISOString() } });
  return { url: `${config.displayBaseUrl}/staff?venue=${encodeURIComponent(String(place.code))}#invite=${id}.${secret}`, expiresAt };
}

export function accountGuard(services: AppwriteServices, config: BackendConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    void (async () => {
    if (["/auth/staff/password", "/auth/staff/activate", "/hub/login/password", "/hub/login", "/auth/logout"].includes(request.originalUrl.split("?")[0].replace(/^\/api/, ""))) return;
    const method = request.method;
    if (isCookieRequest(request) && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      const origin = request.header("origin") || (() => { try { return new URL(request.header("referer") ?? "").origin; } catch { return ""; } })();
      if (!origin || ![config.displayBaseUrl, config.publicUrl, ...config.corsOrigins].includes(origin)) throw new AccountError(403, "Источник запроса не разрешён.");
    }
    const raw = authToken(request);
    if (raw) {
      let claims: SessionClaims | null = null;
      try { claims = verifySession(raw, config.sessionSecret); } catch { /* the route returns its normal 401 */ }
      if (claims?.accountId) {
        const tableId = claims.role === "hub" ? "operators" : claims.role === "staff" ? "staff_accounts" : "";
        if (!tableId) throw new AccountError(401, "Сессия недействительна.");
        const account = await services.tables.getRow<Row>({ databaseId: config.appwriteDatabaseId, tableId, rowId: claims.accountId }).catch(() => null);
        if (!account || account.active !== true || Number(account.sessionVersion) !== claims.accountVersion ||
          (claims.role === "staff" && account.venueId !== claims.venueId)) throw new AccountError(401, "Сессия завершилась. Войдите снова.");
        response.locals.accountId = claims.accountId;
      }
    }
    })().then(() => next(), next);
  };
}

export function accountError(error: unknown, _request: Request, response: Response, next: NextFunction) {
  if (error instanceof AccountError) { response.status(error.status).json({ error: error.status === 401 ? "unauthenticated" : "invalid_argument", message: error.message }); return; }
  next(error);
}

export function createAccountRouter(services: AppwriteServices, config: BackendConfig) {
  const router = Router();
  const databaseId = config.appwriteDatabaseId;
  const audit = async (request: Request, action: string, venueId?: string, staffId?: string) => {
    const claims = accountSession(request, config);
    await services.tables.createRow({ databaseId, tableId: "admin_audit_logs", rowId: ID.unique(), data: {
      ...(venueId ? { venueId } : {}), action, actor: claims.accountId ? `operator:${claims.accountId}` : "emergency-key",
      detailsJson: JSON.stringify(staffId ? { staffId } : {}), createdAt: new Date().toISOString(),
    } });
  };
  const clearStaffInvites = async (staffId: string) => {
    for (;;) {
      const result = await services.tables.listRows<Row>({ databaseId, tableId: "staff_invites", queries: [Query.equal("staffId", [staffId]), Query.limit(100)] });
      if (!result.rows.length) return;
      await Promise.all(result.rows.map(row => services.tables.deleteRow({ databaseId, tableId: "staff_invites", rowId: row.$id })));
    }
  };
  const requireHub = (request: Request) => { const claims = accountSession(request, config); if (claims.role !== "hub") throw new AccountError(403, "Недостаточно прав."); return claims; };
  const staff = async (venueId: string, staffId: string) => {
    const row = await services.tables.getRow<Row>({ databaseId, tableId: "staff_accounts", rowId: staffId }).catch(() => null);
    if (!row || row.venueId !== venueId) throw new AccountError(404, "Сотрудник не найден.");
    return row;
  };
  const venue = async (venueId: string) => {
    const row = await services.tables.getRow<Row>({ databaseId, tableId: "venues", rowId: venueId }).catch(() => null);
    if (!row || row.active === false) throw new AccountError(404, "Точка не найдена.");
    return row;
  };

  router.post("/hub/login/password", route(async (request, response) => {
    const username = String(request.body?.username ?? "").trim().toLowerCase();
    const pass = String(request.body?.password ?? "");
    const row = USERNAME.test(username) ? await findOne(services, databaseId, "operators", [Query.equal("username", [username])]) : null;
    const valid = await checkPassword(pass, row?.passwordHash);
    if (!row || row.active !== true || !valid) throw new AccountError(401, "Неверный логин или пароль.");
    await services.tables.createRow({ databaseId, tableId: "admin_audit_logs", rowId: ID.unique(), data: {
      action: "hub_login_password", actor: `operator:${row.$id}`, detailsJson: "{}", createdAt: new Date().toISOString(),
    } });
    setAccountCookie(request, response, signSession({ role: "hub", accountId: row.$id, accountVersion: Number(row.sessionVersion), authType: "personal" }, config.sessionSecret, "4h"), 4 * 3600, "hub");
    response.json({ role: "hub", username });
  }));

  router.post("/auth/staff/password", route(async (request, response) => {
    const code = String(request.body?.venueCode ?? "").trim().toLowerCase();
    const username = String(request.body?.username ?? "").trim().toLowerCase();
    const pass = String(request.body?.password ?? "");
    const place = /^[a-z0-9][a-z0-9-]{2,31}$/.test(code) ? await findOne(services, databaseId, "venues", [Query.equal("code", [code])]) : null;
    const row = place && USERNAME.test(username) ? await findOne(services, databaseId, "staff_accounts", [Query.equal("venueId", [place.$id]), Query.equal("username", [username])]) : null;
    const valid = await checkPassword(pass, row?.passwordHash);
    if (!place || place.active === false || !row || row.active !== true || !valid) throw new AccountError(401, "Неверный логин или пароль.");
    setAccountCookie(request, response, signSession({ role: "staff", venueId: place.$id, version: Number(place.staffVersion ?? 1), accountId: row.$id, accountVersion: Number(row.sessionVersion), authType: "personal" }, config.sessionSecret, "12h"), 12 * 3600, "staff");
    await recordStatisticsEvent(services, databaseId, place.$id, "staff_login", "personal-staff", row.$id).catch(() => undefined);
    response.json({ role: "staff", venueId: place.$id, username });
  }));

  router.post("/auth/staff/activate", route(async (request, response) => {
    const token = INVITE.exec(String(request.body?.invitation ?? ""));
    if (!token) throw new AccountError(401, "Приглашение недействительно или истекло.");
    const invitation = await services.tables.getRow<Row>({ databaseId, tableId: "staff_invites", rowId: token[1] }).catch(() => null);
    const actual = fingerprint(token[2]);
    const expected = String(invitation?.tokenHash ?? "");
    if (!invitation || expected.length !== actual.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected)) || Date.parse(String(invitation.expiresAt)) < Date.now()) throw new AccountError(401, "Приглашение недействительно или истекло.");
    const place = await venue(String(invitation.venueId));
    const username = accountName(request.body?.username);
    const pass = password(request.body?.password);
    const current = invitation.staffId ? await staff(place.$id, String(invitation.staffId)) : null;
    if (current && current.username !== username) throw new AccountError(400, "При восстановлении сохраните прежний логин.");
    if (!current && await findOne(services, databaseId, "staff_accounts", [Query.equal("venueId", [place.$id]), Query.equal("username", [username])])) throw new AccountError(409, "Логин уже занят в этой точке.");
    const digest = await hash(pass);
    // Deletion is the single-use claim: a competing request can no longer consume the same invitation.
    try { await services.tables.deleteRow({ databaseId, tableId: "staff_invites", rowId: invitation.$id }); }
    catch { throw new AccountError(401, "Приглашение уже использовано."); }
    let account: Row;
    try {
      account = current
        ? await services.tables.updateRow<Row>({ databaseId, tableId: "staff_accounts", rowId: current.$id, data: { passwordHash: digest, active: true, sessionVersion: Number(current.sessionVersion) + 1 } })
        : await services.tables.createRow<Row>({ databaseId, tableId: "staff_accounts", rowId: ID.unique(), data: { venueId: place.$id, username, passwordHash: digest, active: true, sessionVersion: 1, createdAt: new Date().toISOString() } });
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 409) throw new AccountError(409, "Логин уже занят в этой точке.");
      throw error;
    }
    setAccountCookie(request, response, signSession({ role: "staff", venueId: place.$id, version: Number(place.staffVersion ?? 1), accountId: account.$id, accountVersion: Number(account.sessionVersion), authType: "personal" }, config.sessionSecret, "12h"), 12 * 3600, "staff");
    await services.tables.createRow({ databaseId, tableId: "admin_audit_logs", rowId: ID.unique(), data: {
      venueId: place.$id, action: current ? "staff_password_activated" : "staff_account_activated",
      actor: `staff:${account.$id}`, detailsJson: "{}", createdAt: new Date().toISOString(),
    } }).catch(() => undefined);
    await recordStatisticsEvent(services, databaseId, place.$id, "staff_login", "personal-staff", account.$id).catch(() => undefined);
    response.json({ role: "staff", venueId: place.$id, username });
  }));

  router.get("/auth/session", route(async (request, response) => {
    const claims = accountSession(request, config);
    if (!claims.accountId) throw new AccountError(401, "Требуется личный вход.");
    response.json({ role: claims.role, venueId: claims.venueId ?? null });
  }));
  router.post("/auth/logout", route(async (request, response) => {
    const origin = request.header("origin") || (() => { try { return new URL(request.header("referer") ?? "").origin; } catch { return ""; } })();
    if (!origin || ![config.displayBaseUrl, config.publicUrl, ...config.corsOrigins].includes(origin)) throw new AccountError(403, "Источник запроса не разрешён.");
    const role = request.body?.role;
    if (role !== "hub" && role !== "staff") throw new AccountError(400, "Укажите тип кабинета.");
    setAccountCookie(request, response, "", 0, role);
    response.status(204).end();
  }));

  router.get("/hub/venues/:id/staff", route(async (request, response) => {
    requireHub(request); const venueId = String(request.params.id); await venue(venueId);
    const result = await services.tables.listRows<Row>({ databaseId, tableId: "staff_accounts", queries: [Query.equal("venueId", [venueId]), Query.limit(1000)] });
    response.json({ staff: result.rows.map(row => ({ id: row.$id, username: row.username, active: row.active, createdAt: row.createdAt })) });
  }));
  router.post("/hub/venues/:id/staff/invitations", route(async (request, response) => {
    requireHub(request); const venueId = String(request.params.id); await venue(venueId);
    const invitation = await createInvitation(services, config, venueId);
    await audit(request, "staff_invited", venueId);
    response.status(201).json(invitation);
  }));
  router.post("/hub/venues/:id/staff/:staffId/reset", route(async (request, response) => {
    requireHub(request); const venueId = String(request.params.id); const row = await staff(venueId, String(request.params.staffId));
    await clearStaffInvites(row.$id);
    await services.tables.updateRow({ databaseId, tableId: "staff_accounts", rowId: row.$id, data: { active: false, sessionVersion: Number(row.sessionVersion) + 1 } });
    const invitation = await createInvitation(services, config, venueId, row.$id);
    await audit(request, "staff_password_reset", venueId, row.$id);
    response.status(201).json(invitation);
  }));
  router.post("/hub/venues/:id/staff/:staffId/disable", route(async (request, response) => {
    requireHub(request); const venueId = String(request.params.id); const row = await staff(venueId, String(request.params.staffId));
    await services.tables.updateRow({ databaseId, tableId: "staff_accounts", rowId: row.$id, data: { active: false, sessionVersion: Number(row.sessionVersion) + 1 } });
    await clearStaffInvites(row.$id);
    await audit(request, "staff_disabled", venueId, row.$id);
    response.json({ disabled: true });
  }));
  router.use(accountError);
  return router;
}
