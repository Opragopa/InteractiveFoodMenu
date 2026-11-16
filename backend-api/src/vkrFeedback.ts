import { Router, type Request } from "express";
import { ID, Query } from "node-appwrite";
import type { AppwriteServices } from "./appwrite.js";
import type { BackendConfig } from "./config.js";
import { transaction } from "./vkrTransaction.js";
import {
  access,
  clean,
  get,
  log,
  permit,
  route,
  rows,
  text,
  VkrError,
  type Row,
} from "./vkrAccess.js";

export const CATEGORIES = [
  "food_quality",
  "service",
  "availability",
  "information",
  "other",
];
export const STATUSES = ["new", "in_progress", "closed"];
function category(value: unknown) {
  const v = text(value, 24);
  if (!CATEGORIES.includes(v))
    throw new VkrError(400, "Неизвестная причина обращения.");
  return v;
}
function period(q: Request) {
  const valid = (s: unknown) =>
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
  const to = q.query.to ?? new Date().toISOString().slice(0, 10);
  const from =
    q.query.from ??
    new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
  if (!valid(from) || !valid(to))
    throw new VkrError(400, "Период задаётся датами ГГГГ-ММ-ДД.");
  const start = Date.parse(`${from}T00:00:00+03:00`),
    end = Date.parse(`${to}T00:00:00+03:00`) + 86400_000;
  if (end <= start || end - start > 366 * 86400_000)
    throw new VkrError(400, "Период от 1 до 366 дней.");
  return { from, to, start, end };
}
async function list(s: AppwriteServices, c: BackendConfig, q: Request) {
  const a = await access(s, c, q);
  let venues = a.venues;
  if (q.query.venueId) {
    await permit(s, c, q, String(q.query.venueId));
    venues = venues.filter((v) => v.$id === q.query.venueId);
  }
  const p = period(q);
  const records: Row[] = [];
  for (const v of venues)
    records.push(
      ...(await rows(s, c, "reviews", [
        Query.equal("venueId", [v.$id]),
        Query.greaterThanEqual("createdAt", new Date(p.start).toISOString()),
        Query.lessThan("createdAt", new Date(p.end).toISOString()),
        Query.orderDesc("createdAt"),
      ])),
    );
  records.sort(
    (x, y) =>
      String(y.createdAt).localeCompare(String(x.createdAt)) ||
      x.$id.localeCompare(y.$id),
  );
  return { records, venues, period: p };
}
export function createFeedbackRouter(s: AppwriteServices, c: BackendConfig) {
  const router = Router();
  const databaseId = c.appwriteDatabaseId;
  router.get(
    "/public/venues/:code",
    route(async (q, r) => {
      const v = (
        await rows(s, c, "venues", [
          Query.equal("code", [String(q.params.code)]),
        ])
      )[0];
      if (!v || !v.active) throw new VkrError(404, "Точка не найдена.");
      r.json({ id: v.$id, name: v.name, code: v.code, categories: CATEGORIES });
    }),
  );
  router.post(
    "/public/venues/:code/reviews",
    route(async (q, r) => {
      const v = (
        await rows(s, c, "venues", [
          Query.equal("code", [String(q.params.code)]),
        ])
      )[0];
      if (!v || !v.active) throw new VkrError(404, "Точка не найдена.");
      const message = text(q.body?.message, 2000);
      const reason = category(q.body?.category);
      const id = ID.unique();
      const now = new Date().toISOString();
      await transaction(s, id, async (tx) => {
        await tx.tables.createRow({
          databaseId,
          tableId: "reviews",
          rowId: id,
          data: {
            venueId: v.$id,
            message,
            category: reason,
            status: "new",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        });
        await log(tx, c, "review_created", "visitor", v.$id, {
          id,
          category: reason,
        });
      });
      r.status(201).json({ id, status: "new" });
    }),
  );
  for (const prefix of ["/hub", "/staff"]) {
    router.get(
      `${prefix}/reviews`,
      route(async (q, r) => {
        const result = await list(s, c, q);
        r.json({
          reviews: result.records.map(clean),
          from: result.period.from,
          to: result.period.to,
        });
      }),
    );
    router.get(
      `${prefix}/reviews/:id/actions`,
      route(async (q, r) => {
        const review = await get(s, c, "reviews", String(q.params.id));
        await permit(s, c, q, review.venueId);
        const history = await rows(s, c, "review_actions", [
          Query.equal("reviewId", [review.$id]),
          Query.orderAsc("createdAt"),
        ]);
        const names = new Map<string, string>();
        for (const action of history) {
          if (!names.has(action.actor)) {
            const match = /^(operator|staff):(.+)$/.exec(action.actor);
            const account = match
              ? await get(
                  s,
                  c,
                  match[1] === "operator" ? "operators" : "staff_accounts",
                  match[2],
                ).catch(() => null)
              : null;
            names.set(action.actor, account?.username ?? "Сотрудник");
          }
        }
        r.json({
          actions: history.map((action) => ({
            ...clean(action),
            actorName: names.get(action.actor),
          })),
        });
      }),
    );
    router.patch(
      `${prefix}/reviews/:id`,
      route(async (q, r) => {
        const id = String(q.params.id);
        const initial = await get(s, c, "reviews", id);
        const a = await permit(s, c, q, initial.venueId, true);
        const expected = q.body?.version;
        if (!Number.isInteger(expected))
          throw new VkrError(400, "Укажите версию обращения.");
        const nextStatus = text(q.body?.status, 20);
        if (!STATUSES.includes(nextStatus))
          throw new VkrError(400, "Неизвестный статус.");
        const reason = category(q.body?.category);
        const comment = text(q.body?.comment, 2000);
        const assignedTo = q.body?.assignedTo
          ? text(q.body.assignedTo, 80)
          : a.actor;
        if (assignedTo !== a.actor) {
          const m = /^(operator|staff):(.+)$/.exec(assignedTo);
          if (!m)
            throw new VkrError(400, "Выберите учётную запись ответственного.");
          const account = await get(
            s,
            c,
            m[1] === "operator" ? "operators" : "staff_accounts",
            m[2],
          );
          const venue = await get(s, c, "venues", initial.venueId);
          const grants =
            m[1] === "operator"
              ? await rows(s, c, "role_assignments", [
                  Query.equal("operatorId", [m[2]]),
                ])
              : [];
          if (
            !account.active ||
            (m[1] === "staff"
              ? account.venueId !== venue.$id
              : account.platformAdmin !== true &&
                !grants.some(
                  (g) =>
                    g.role === "manager" &&
                    g.organizationId === venue.organizationId &&
                    (!g.venueId || g.venueId === venue.$id),
                ))
          )
            throw new VkrError(400, "Ответственный не имеет прав на точку.");
        }
        const result = await transaction(s, id, async (tx) => {
          const current = await get(tx, c, "reviews", id);
          if (current.version !== expected)
            throw new VkrError(409, "Обращение уже изменено. Обновите список.");
          if (current.status === "new" && nextStatus === "closed")
            throw new VkrError(400, "Сначала примите обращение в работу.");
          const now = new Date().toISOString();
          const before = {
            status: current.status,
            category: current.category,
            assignedTo: current.assignedTo ?? null,
            version: current.version,
          };
          const after = {
            status: nextStatus,
            category: reason,
            assignedTo,
            version: expected + 1,
            updatedAt: now,
          };
          const row = await tx.tables.updateRow<Row>({
            databaseId,
            tableId: "reviews",
            rowId: id,
            data: after,
          });
          await tx.tables.createRow({
            databaseId,
            tableId: "review_actions",
            rowId: ID.unique(),
            data: {
              reviewId: id,
              venueId: current.venueId,
              actor: a.actor,
              beforeJson: JSON.stringify(before),
              afterJson: JSON.stringify(after),
              comment,
              createdAt: now,
            },
          });
          await log(tx, c, "review_updated", a.actor, current.venueId, {
            id,
            before,
            after,
          });
          return row;
        });
        r.json(clean(result));
      }),
    );
  }
  router.get(
    ["/hub/reports/feedback", "/hub/reports/feedback.csv"],
    route(async (q, r) => {
      const a = await access(s, c, q);
      if (a.claims.role !== "hub")
        throw new VkrError(403, "Требуется вход в хаб.");
      const { records, venues, period: p } = await list(s, c, q);
      const generatedAt = new Date().toISOString();
      const groups = venues.flatMap((v) =>
        CATEGORIES.flatMap((category) => {
          const subset = records.filter(
            (x) => x.venueId === v.$id && x.category === category,
          );
          if (!subset.length) return [];
          return [
            {
              venueId: v.$id,
              venueName: v.name,
              category,
              total: subset.length,
              new: subset.filter((x) => x.status === "new").length,
              inProgress: subset.filter((x) => x.status === "in_progress")
                .length,
              closed: subset.filter((x) => x.status === "closed").length,
            },
          ];
        }),
      );
      if (q.path.endsWith(".csv")) {
        const csv = (value: unknown) =>
          '"' +
          String(value ?? "")
            .replace(/^[=+@\-\t\r]/, "'$&")
            .replace(/"/g, '""') +
          '"';
        const lines = [
          [
            "from",
            "to",
            "generatedAt",
            "venueId",
            "venueName",
            "category",
            "total",
            "new",
            "inProgress",
            "closed",
          ],
          ...groups.map((g) => [
            p.from,
            p.to,
            generatedAt,
            g.venueId,
            g.venueName,
            g.category,
            g.total,
            g.new,
            g.inProgress,
            g.closed,
          ]),
        ];
        await log(s, c, "feedback_report_export", a.actor, undefined, {
          from: p.from,
          to: p.to,
          venueIds: venues.map((v) => v.$id),
          total: records.length,
        });
        r.set({
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="feedback-report.csv"',
          "Cache-Control": "no-store",
        }).send(
          "\uFEFF" + lines.map((row) => row.map(csv).join(";")).join("\r\n"),
        );
      } else
        r.json({
          from: p.from,
          to: p.to,
          generatedAt,
          total: records.length,
          venueIds: venues.map((v) => v.$id),
          groups,
        });
    }),
  );
  return router;
}
