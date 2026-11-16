import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { Query, ID, AppwriteException, type Models } from "node-appwrite";
import { hash } from "@node-rs/argon2";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { accountSession } from "./accountRoutes.js";
import { transaction } from "./vkrTransaction.js";

export type Row = Models.Row & Record<string, any>;
export class VkrError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const route =
  (fn: (q: Request, s: Response) => Promise<void>) =>
  (q: Request, s: Response, n: NextFunction) => {
    void fn(q, s).catch(n);
  };
export const clean = (r: Row) =>
  Object.fromEntries(
    Object.entries(r)
      .filter(([key]) => !key.startsWith("$"))
      .concat([["id", r.$id]]),
  );
export function text(v: unknown, max = 160) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new VkrError(400, "Проверьте обязательные поля и длину текста.");
  return v.trim();
}
export async function rows(
  s: AppwriteServices,
  c: BackendConfig,
  tableId: string,
  queries: string[] = [],
) {
  const result: Row[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await s.tables.listRows<Row>({
      databaseId: c.appwriteDatabaseId,
      tableId,
      queries: [
        ...queries,
        Query.limit(100),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
    });
    result.push(...page.rows);
    if (page.rows.length < 100) return result;
    cursor = page.rows.at(-1)!.$id;
  }
}
export async function get(
  s: AppwriteServices,
  c: BackendConfig,
  tableId: string,
  rowId: string,
) {
  try {
    return await s.tables.getRow<Row>({
      databaseId: c.appwriteDatabaseId,
      tableId,
      rowId,
    });
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 404)
      throw new VkrError(404, "Запись не найдена.");
    throw e;
  }
}
export async function log(
  s: AppwriteServices,
  c: BackendConfig,
  action: string,
  actor: string,
  venueId: string | undefined,
  details: object,
) {
  return s.tables.createRow<Row>({
    databaseId: c.appwriteDatabaseId,
    tableId: "admin_audit_logs",
    rowId: ID.unique(),
    data: {
      action,
      actor,
      ...(venueId ? { venueId } : {}),
      detailsJson: JSON.stringify(details),
      createdAt: new Date().toISOString(),
    },
  });
}
export async function access(
  s: AppwriteServices,
  c: BackendConfig,
  q: Request,
) {
  const claims = accountSession(q, c);
  if (claims.role === "staff" && claims.venueId)
    return {
      admin: false,
      actor: `staff:${claims.accountId ?? "legacy"}`,
      claims,
      grants: [] as Row[],
      venues: [await get(s, c, "venues", claims.venueId)],
    };
  if (claims.role !== "hub") throw new VkrError(403, "Недостаточно прав.");
  const account = claims.accountId
    ? await get(s, c, "operators", claims.accountId)
    : null;
  const admin = account?.platformAdmin === true || !claims.accountId;
  const grants = claims.accountId
    ? await rows(s, c, "role_assignments", [
        Query.equal("operatorId", [claims.accountId]),
      ])
    : [];
  const venues = (await rows(s, c, "venues")).filter(
    (v) =>
      admin ||
      grants.some(
        (g) =>
          g.organizationId === v.organizationId &&
          (!g.venueId || g.venueId === v.$id),
      ),
  );
  return {
    admin,
    actor: claims.accountId ? `operator:${claims.accountId}` : "emergency-key",
    claims,
    grants,
    venues,
  };
}
export async function permit(
  s: AppwriteServices,
  c: BackendConfig,
  q: Request,
  venueId: string,
  write = false,
) {
  const a = await access(s, c, q);
  const v = a.venues.find((v) => v.$id === venueId);
  if (
    !v ||
    (!a.admin &&
      a.claims.role !== "staff" &&
      write &&
      !a.grants.some(
        (g) =>
          g.role === "manager" &&
          g.organizationId === v.organizationId &&
          (!g.venueId || g.venueId === venueId),
      ))
  )
    throw new VkrError(403, "Нет доступа к этой точке.");
  return a;
}
export async function bootstrapVkr(s: AppwriteServices, c: BackendConfig) {
  if (
    !(await rows(s, c, "organizations")).some(
      (r) => r.$id === "legacy-organization",
    )
  )
    await s.tables.createRow({
      databaseId: c.appwriteDatabaseId,
      tableId: "organizations",
      rowId: "legacy-organization",
      data: {
        name: "Основная организация",
        createdAt: new Date().toISOString(),
      },
    });
  for (const v of await rows(s, c, "venues"))
    if (!v.organizationId)
      await s.tables.updateRow({
        databaseId: c.appwriteDatabaseId,
        tableId: "venues",
        rowId: v.$id,
        data: { organizationId: "legacy-organization" },
      });
  // Previously all hub accounts had platform-wide access. Preserve it explicitly once.
  for (const u of await rows(s, c, "operators"))
    if (u.platformAdmin == null)
      await s.tables.updateRow({
        databaseId: c.appwriteDatabaseId,
        tableId: "operators",
        rowId: u.$id,
        data: { platformAdmin: true },
      });
}
export function scopeHub(s: AppwriteServices, c: BackendConfig) {
  return (q: Request, r: Response, n: NextFunction) => {
    void (async () => {
      const path = q.path;
      if (!path.startsWith("/hub/") || path.startsWith("/hub/login"))
        return false;
      const a = await access(s, c, q);
      r.locals.vkrAccess = a;
      if (a.claims.role !== "hub")
        throw new VkrError(403, "Требуется вход в хаб.");
      if (a.admin) return false;
      if (path === "/hub/overview" && q.method === "GET") {
        const allowed = a.venues.map((v) => v.$id);
        const scoped = async (table: string) =>
          allowed.length
            ? rows(s, c, table, [Query.equal("venueId", allowed)])
            : [];
        const [categories, items, displays, logs, audits] = await Promise.all([
          scoped("categories"),
          scoped("items"),
          scoped("display_tokens"),
          scoped("client_logs"),
          scoped("admin_audit_logs"),
        ]);
        const organizations = (await rows(s, c, "organizations")).filter((o) =>
          a.grants.some((g) => g.organizationId === o.$id),
        );
        r.json({
          generatedAt: new Date().toISOString(),
          totals: {
            venues: allowed.length,
            categories: categories.length,
            items: items.length,
            activeDisplays: displays.filter((d) => d.active).length,
          },
          venues: a.venues.map(clean),
          organizations: organizations.map(clean),
          functions: [],
          clientLogs: logs.slice(-30).map(clean),
          auditLogs: audits.slice(-20).map(clean),
        });
        return true;
      }
      if (
        [
          "/hub/vkr/access",
          "/hub/reviews",
          "/hub/reports/feedback",
          "/hub/reports/feedback.csv",
        ].includes(path) ||
        /^\/hub\/reviews\/[^/]+(?:\/actions)?$/.test(path)
      )
        return false;
      const match = /^\/hub\/venues\/([^/]+)(?:\/|$)/.exec(path);
      if (match) {
        await permit(
          s,
          c,
          q,
          decodeURIComponent(match[1]),
          !["GET", "HEAD"].includes(q.method),
        );
        return false;
      }
      if (path === "/hub/venues" && q.method === "POST") {
        const id = q.body?.organizationId;
        if (
          !id ||
          !a.grants.some(
            (g) =>
              g.organizationId === id && !g.venueId && g.role === "manager",
          )
        )
          throw new VkrError(403, "Выберите доступную организацию.");
        return false;
      }
      throw new VkrError(403, "Требуются права администратора платформы.");
    })().then((done) => {
      if (!done) n();
    }, n);
  };
}
export function createVkrAccessRouter(s: AppwriteServices, c: BackendConfig) {
  const router = Router();
  const databaseId = c.appwriteDatabaseId;
  router.get(
    "/hub/vkr/access",
    route(async (q, r) => {
      const a = await access(s, c, q);
      const organizations = (await rows(s, c, "organizations")).filter(
        (o) => a.admin || a.grants.some((g) => g.organizationId === o.$id),
      );
      r.json({
        admin: a.admin,
        actor: a.actor,
        organizations: organizations.map(clean),
        grants: a.grants.map(clean),
        venues: a.venues.map(clean),
      });
    }),
  );
  router.get(
    "/hub/venues/:id/assignees",
    route(async (q, r) => {
      const id = String(q.params.id);
      await permit(s, c, q, id);
      const venue = await get(s, c, "venues", id);
      const grants = await rows(s, c, "role_assignments");
      const operators = (await rows(s, c, "operators")).filter(
        (u) =>
          u.active &&
          (u.platformAdmin === true ||
            grants.some(
              (g) =>
                g.operatorId === u.$id &&
                g.role === "manager" &&
                g.organizationId === venue.organizationId &&
                (!g.venueId || g.venueId === id),
            )),
      );
      const staff = await rows(s, c, "staff_accounts", [
        Query.equal("venueId", [id]),
      ]);
      r.json({
        accounts: [
          ...operators.map((u) => ({
            id: `operator:${u.$id}`,
            name: u.username,
          })),
          ...staff
            .filter((u) => u.active)
            .map((u) => ({ id: `staff:${u.$id}`, name: u.username })),
        ],
      });
    }),
  );
  const admin = async (q: Request) => {
    const a = await access(s, c, q);
    if (!a.admin) throw new VkrError(403, "Требуются права администратора.");
    return a;
  };
  router.post(
    "/hub/organizations",
    route(async (q, r) => {
      const a = await admin(q);
      const name = text(q.body?.name);
      const id = ID.unique();
      const row = await transaction(s, id, async (tx) => {
        const created = await tx.tables.createRow<Row>({
          databaseId,
          tableId: "organizations",
          rowId: id,
          data: { name, createdAt: new Date().toISOString() },
        });
        await log(tx, c, "organization_create", a.actor, undefined, {
          id,
          name,
        });
        return created;
      });
      r.status(201).json(clean(row));
    }),
  );
  router.get(
    "/hub/accounts",
    route(async (q, r) => {
      await admin(q);
      r.json({
        accounts: (await rows(s, c, "operators")).map((u) => ({
          id: u.$id,
          username: u.username,
          active: u.active,
          platformAdmin: u.platformAdmin === true,
        })),
        grants: (await rows(s, c, "role_assignments")).map(clean),
      });
    }),
  );
  router.post(
    "/hub/accounts",
    route(async (q, r) => {
      const a = await admin(q);
      const username = text(q.body?.username, 40).toLowerCase();
      const password = text(q.body?.password, 128);
      if (!/^[a-z][a-z0-9._-]{2,39}$/.test(username) || password.length < 12)
        throw new VkrError(400, "Логин 3–40 символов; пароль от 12 символов.");
      const id = ID.unique();
      const passwordHash = await hash(password);
      await transaction(s, id, async (tx) => {
        await tx.tables.createRow({
          databaseId,
          tableId: "operators",
          rowId: id,
          data: {
            username,
            passwordHash,
            active: true,
            platformAdmin: false,
            sessionVersion: 1,
            createdAt: new Date().toISOString(),
          },
        });
        await log(tx, c, "account_create", a.actor, undefined, {
          id,
          username,
        });
      });
      r.status(201).json({ id, username });
    }),
  );
  router.post(
    "/hub/grants",
    route(async (q, r) => {
      const a = await admin(q);
      const operatorId = text(q.body?.operatorId, 36),
        organizationId = text(q.body?.organizationId, 36);
      const venueId = q.body?.venueId ? text(q.body.venueId, 36) : undefined;
      const role = text(q.body?.role, 16);
      if (!["manager", "auditor"].includes(role))
        throw new VkrError(400, "Неизвестная роль.");
      await get(s, c, "operators", operatorId);
      await get(s, c, "organizations", organizationId);
      if (
        venueId &&
        (await get(s, c, "venues", venueId)).organizationId !== organizationId
      )
        throw new VkrError(400, "Точка другой организации.");
      const id = ID.unique();
      await transaction(s, id, async (tx) => {
        await tx.tables.createRow({
          databaseId,
          tableId: "role_assignments",
          rowId: id,
          data: {
            operatorId,
            organizationId,
            ...(venueId ? { venueId } : {}),
            role,
            createdAt: new Date().toISOString(),
          },
        });
        await log(tx, c, "role_grant", a.actor, venueId, {
          id,
          operatorId,
          organizationId,
          role,
        });
      });
      r.status(201).json({ id });
    }),
  );
  router.delete(
    "/hub/grants/:id",
    route(async (q, r) => {
      const a = await admin(q);
      const g = await get(s, c, "role_assignments", String(q.params.id));
      await transaction(s, g.$id, async (tx) => {
        await tx.tables.deleteRow({
          databaseId,
          tableId: "role_assignments",
          rowId: g.$id,
        });
        await log(tx, c, "role_revoke", a.actor, g.venueId, {
          id: g.$id,
          operatorId: g.operatorId,
          organizationId: g.organizationId,
        });
      });
      r.status(204).end();
    }),
  );
  return router;
}
export function vkrErrors(
  e: unknown,
  _q: Request,
  r: Response,
  n: NextFunction,
) {
  if (e instanceof AppwriteException && e.code === 409) {
    r.status(409).json({
      error: "conflict",
      message: "Запись уже существует или была изменена. Обновите данные.",
    });
    return;
  }
  if (e instanceof VkrError) {
    r.status(e.status).json({ error: "request_rejected", message: e.message });
    return;
  }
  n(e);
}
