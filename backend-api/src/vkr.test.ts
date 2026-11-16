import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { hash } from "@node-rs/argon2";
import { createPostgresServices, ensurePostgresSchema } from "./postgres.js";
import { createApp } from "./server.js";
import { bootstrapVkr } from "./vkrAccess.js";
import { signSession } from "./security.js";
import type { BackendConfig } from "./config.js";

test(
  "VKR PostgreSQL acceptance: scopes, feedback, audit, CSV, conflicts and rollback",
  { skip: !process.env.TEST_POSTGRES_URL, timeout: 60000 },
  async (t) => {
    const admin = new Pool({ connectionString: process.env.TEST_POSTGRES_URL });
    const database = `ifm_vkr_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.TEST_POSTGRES_URL!);
    url.pathname = `/${database}`;
    const config: BackendConfig = {
      databaseProvider: "postgres",
      databaseUrl: url.toString(),
      databasePoolSize: 8,
      port: 0,
      publicUrl: "http://localhost",
      displayBaseUrl: "http://localhost",
      appwriteEndpoint: "",
      appwriteProjectId: "",
      appwriteApiKey: "",
      appwriteSelfSigned: false,
      appwriteDatabaseId: "test",
      appwriteBucketId: "assets",
      sessionSecret: "s".repeat(40),
      hubAccessKey: "h".repeat(40),
      corsOrigins: [],
    };
    const initial = new Pool({ connectionString: url.toString() });
    await ensurePostgresSchema(initial);
    await initial.end();
    const s = await createPostgresServices(config);
    await bootstrapVkr(s, config);
    await bootstrapVkr(s, config);
    await s.tables.createRow({
      databaseId: "test",
      tableId: "operators",
      rowId: "owner",
      data: {
        username: "owner",
        passwordHash: await hash("test-owner-password"),
        platformAdmin: true,
        active: true,
        sessionVersion: 1,
        createdAt: new Date().toISOString(),
      },
    });
    const server = createServer(createApp(config, s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api`;
    const token = (id: string) =>
      signSession(
        { role: "hub", accountId: id, accountVersion: 1, authType: "personal" },
        config.sessionSecret,
      );
    const call = (
      path: string,
      method = "GET",
      body?: unknown,
      auth = token("owner"),
    ) =>
      fetch(base + path, {
        method,
        headers: {
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const create = async (path: string, body: object) => {
      const r = await call(path, "POST", body);
      assert.equal(r.status, 201, await r.clone().text());
      return r.json() as Promise<any>;
    };
    let orgA: string,
      orgB: string,
      venueA: string,
      venueB: string,
      manager: string,
      auditor: string,
      grant: string,
      review: string;
    try {
      await t.test(
        "two organizations, explicit roles and legacy bootstrap are idempotent",
        async () => {
          orgA = (await create("/hub/organizations", { name: "Оператор А" }))
            .id;
          orgB = (await create("/hub/organizations", { name: "Оператор Б" }))
            .id;
          venueA = (
            await create("/hub/venues", {
              name: "=Тестовая точка А",
              code: "stand-a",
              pin: "123456",
              organizationId: orgA,
            })
          ).venueId;
          venueB = (
            await create("/hub/venues", {
              name: "Точка Б",
              code: "stand-b",
              pin: "123456",
              organizationId: orgB,
            })
          ).venueId;
          manager = (
            await create("/hub/accounts", {
              username: "manager",
              password: "manager-test-password",
            })
          ).id;
          auditor = (
            await create("/hub/accounts", {
              username: "auditor",
              password: "auditor-test-password",
            })
          ).id;
          grant = (
            await create("/hub/grants", {
              operatorId: manager,
              organizationId: orgA,
              role: "manager",
            })
          ).id;
          await create("/hub/grants", {
            operatorId: auditor,
            organizationId: orgA,
            venueId: venueA,
            role: "auditor",
          });
          assert.equal(
            (
              await call("/hub/grants", "POST", {
                operatorId: manager,
                organizationId: orgA,
                venueId: venueB,
                role: "manager",
              })
            ).status,
            400,
          );
        },
      );
      await t.test(
        "overview and all legacy hub venue endpoints enforce scope",
        async () => {
          assert.equal(
            (await call("/hub/overview", "GET", undefined, "")).status,
            401,
          );
          assert.equal(
            (await call("/hub/reports/feedback", "GET", undefined, "")).status,
            401,
          );
          const r = await call(
            "/hub/overview",
            "GET",
            undefined,
            token(manager),
          );
          assert.equal(r.status, 200);
          const data = (await r.json()) as any;
          assert.deepEqual(
            data.venues.map((v: any) => v.id),
            [venueA],
          );
          assert.equal(data.totals.venues, 1);
          assert.ok(!JSON.stringify(data).includes(venueB));
          for (const suffix of ["statistics", "staff", "displays"])
            assert.equal(
              (
                await call(
                  `/hub/venues/${venueB}/${suffix}`,
                  "GET",
                  undefined,
                  token(manager),
                )
              ).status,
              403,
            );
          assert.equal(
            (
              await call(
                `/hub/venues/${venueA}/revoke`,
                "POST",
                {},
                token(auditor),
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await call(
                "/hub/organizations",
                "POST",
                { name: "Denied" },
                token(manager),
              )
            ).status,
            403,
          );
          const staff = signSession(
            { role: "staff", venueId: venueA, version: 1 },
            config.sessionSecret,
          );
          assert.equal(
            (await call(`/hub/venues/${venueA}/revoke`, "POST", {}, staff))
              .status,
            403,
          );
          assert.equal(
            (
              await call(
                "/hub/reports/feedback",
                "GET",
                undefined,
                signSession(
                  { role: "display", venueId: venueA },
                  config.sessionSecret,
                ),
              )
            ).status,
            403,
          );
        },
      );
      await t.test(
        "anonymous intake validates data without exposing internal fields",
        async () => {
          const publicInfo = await (
            await call("/public/venues/stand-a", "GET", undefined, "")
          ).json();
          assert.ok(!JSON.stringify(publicInfo).includes("pinHash"));
          assert.equal(
            (
              await call(
                "/public/venues/stand-a/reviews",
                "POST",
                { category: "other", message: "   " },
                "",
              )
            ).status,
            400,
          );
          const first = await call(
            "/public/venues/stand-a/reviews",
            "POST",
            {
              category: "service",
              message: "<script>alert(1)</script> Не хватило информации",
            },
            "",
          );
          assert.equal(first.status, 201);
          review = ((await first.json()) as any).id;
          const second = await call(
            "/public/venues/stand-b/reviews",
            "POST",
            { category: "food_quality", message: "Синтетическое обращение Б" },
            "",
          );
          assert.equal(second.status, 201);
          assert.equal(
            (
              await call(
                `/hub/reviews/${review}`,
                "PATCH",
                {
                  version: 1,
                  status: "closed",
                  category: "service",
                  comment: "Нельзя закрыть без работы",
                },
                token(manager),
              )
            ).status,
            400,
          );
        },
      );
      await t.test(
        "venue deletion preserves audit and refuses to remove feedback history",
        async () => {
          assert.equal(
            (await call(`/hub/venues/${venueA}`, "DELETE")).status,
            409,
          );
          const disposable = await create("/hub/venues", {
            name: "Временная точка",
            code: "temporary-stand",
            pin: "123456",
            organizationId: orgA,
          });
          const before = await s.pool!.query(
            'SELECT count(*) FROM ifm.admin_audit_logs WHERE "venueId"=$1',
            [disposable.venueId],
          );
          assert.equal(
            (await call(`/hub/venues/${disposable.venueId}`, "DELETE")).status,
            204,
          );
          const after = await s.pool!.query(
            'SELECT count(*) FROM ifm.admin_audit_logs WHERE "venueId"=$1',
            [disposable.venueId],
          );
          assert.ok(Number(after.rows[0].count) > Number(before.rows[0].count));
        },
      );
      await t.test(
        "state change, optimistic conflict and immutable history",
        async () => {
          let result = await call(
            `/hub/reviews/${review}`,
            "PATCH",
            {
              version: 1,
              status: "in_progress",
              category: "information",
              comment: "Уточнение информации",
            },
            token(manager),
          );
          assert.equal(result.status, 200);
          const concurrent = await Promise.all(
            ["Исправление А", "Исправление Б"].map((comment) =>
              call(
                `/hub/reviews/${review}`,
                "PATCH",
                {
                  version: 2,
                  status: "closed",
                  category: "information",
                  comment,
                },
                token(manager),
              ),
            ),
          );
          assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
          const actions = (await (
            await call(
              `/hub/reviews/${review}/actions`,
              "GET",
              undefined,
              token(manager),
            )
          ).json()) as any;
          assert.equal(actions.actions.length, 2);
          assert.equal(JSON.parse(actions.actions[0].beforeJson).status, "new");
          assert.equal(
            (
              await call(
                `/hub/reviews/${review}`,
                "PATCH",
                {
                  version: 3,
                  status: "in_progress",
                  category: "service",
                  comment: "Denied",
                },
                token(auditor),
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await call(
                `/hub/reviews/${review}/actions`,
                "DELETE",
                {},
                token(manager),
              )
            ).status,
            404,
          );
        },
      );
      await t.test(
        "history write failure rolls back state and audit",
        async () => {
          await s.pool!.query(
            "CREATE FUNCTION ifm.reject_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected history fault'; END $$",
          );
          await s.pool!.query(
            "CREATE TRIGGER reject_history BEFORE INSERT ON ifm.review_actions FOR EACH ROW EXECUTE FUNCTION ifm.reject_history()",
          );
          const before = await s.pool!.query(
            "SELECT count(*) FROM ifm.admin_audit_logs",
          );
          assert.equal(
            (
              await call(
                `/hub/reviews/${review}`,
                "PATCH",
                {
                  version: 3,
                  status: "in_progress",
                  category: "service",
                  comment: "Инъекция отказа",
                },
                token(manager),
              )
            ).status,
            500,
          );
          const state = await s.tables.getRow({
            databaseId: "test",
            tableId: "reviews",
            rowId: review,
          });
          assert.equal(state.version, 3);
          assert.equal(state.status, "closed");
          assert.equal(
            (await s.pool!.query("SELECT count(*) FROM ifm.admin_audit_logs"))
              .rows[0].count,
            before.rows[0].count,
          );
          await s.pool!.query(
            "DROP TRIGGER reject_history ON ifm.review_actions",
          );
        },
      );
      await t.test(
        "reports paginate, sum correctly, exclude private text and protect CSV formulas",
        async () => {
          const now = new Date().toISOString();
          for (let i = 0; i < 105; i++)
            await s.tables.createRow({
              databaseId: "test",
              tableId: "reviews",
              rowId: `page-${i.toString().padStart(4, "0")}`,
              data: {
                venueId: venueA,
                category: "other",
                status: "new",
                message: "Синтетический текст",
                version: 1,
                createdAt: now,
                updatedAt: now,
              },
            });
          const result = (await (
            await call(
              "/hub/reports/feedback",
              "GET",
              undefined,
              token(manager),
            )
          ).json()) as any;
          assert.equal(result.total, 106);
          assert.equal(
            result.groups.reduce((n: number, g: any) => n + g.total, 0),
            106,
          );
          assert.ok(!JSON.stringify(result).includes(venueB));
          const csv = await call(
            "/hub/reports/feedback.csv",
            "GET",
            undefined,
            token(manager),
          );
          assert.equal(csv.status, 200);
          const content = await csv.text();
          assert.match(content, /"'=Тестовая точка А"/);
          assert.ok(!content.includes("Синтетический текст"));
          assert.equal(
            (
              await call(
                `/hub/reports/feedback?venueId=${venueB}`,
                "GET",
                undefined,
                token(manager),
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await call(
                "/hub/reports/feedback?from=2026-99-99",
                "GET",
                undefined,
                token(manager),
              )
            ).status,
            400,
          );
        },
      );
      await t.test(
        "grant removal takes effect for existing session and denies creation outside scope",
        async () => {
          assert.equal(
            (
              await call(
                "/hub/venues",
                "POST",
                {
                  name: "Запрещено",
                  code: "denied",
                  pin: "123456",
                  organizationId: orgB,
                },
                token(manager),
              )
            ).status,
            403,
          );
          assert.equal(
            (await call(`/hub/grants/${grant}`, "DELETE")).status,
            204,
          );
          assert.equal(
            (
              await call(
                `/hub/venues/${venueA}/statistics`,
                "GET",
                undefined,
                token(manager),
              )
            ).status,
            403,
          );
          const report = (await (
            await call(
              "/hub/reports/feedback",
              "GET",
              undefined,
              token(manager),
            )
          ).json()) as any;
          assert.equal(report.total, 0);
        },
      );
      await t.test(
        "public feedback applies per-IP rate limit with Retry-After",
        async () => {
          let limited = false;
          for (let i = 0; i < 15; i++) {
            const r = await call(
              "/public/venues/stand-a/reviews",
              "POST",
              { category: "other", message: "Проверка ограничения" },
              "",
            );
            if (r.status === 429) {
              limited = true;
              assert.ok(Number(r.headers.get("retry-after")) > 0);
              break;
            }
            assert.equal(r.status, 201);
          }
          assert.equal(limited, true);
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await s.close?.();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
