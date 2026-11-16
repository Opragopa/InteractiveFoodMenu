// Local synthetic acceptance experiment. Never reads deployment configuration.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import {
  createPostgresServices,
  ensurePostgresSchema,
} from "../../backend-api/dist/postgres.js";
import { bootstrapVkr } from "../../backend-api/dist/vkrAccess.js";
import { createApp } from "../../backend-api/dist/server.js";
import { signSession, hashSecret } from "../../backend-api/dist/security.js";
import { TABLES } from "../../backend-api/dist/schema.js";
const require = createRequire(
  new URL("../../backend-api/package.json", import.meta.url),
);
const { Pool } = require("pg");
const { hash } = require("@node-rs/argon2");
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = path.join(root, "docs/stand-results/2026-11-16");
await mkdir(out, { recursive: true });
const port = 55436;
const database = `ifm_vkr_stand_${Date.now()}`;
const restore = `${database}_restore`;
const admin = new Pool({
  connectionString: `postgresql://ifm_stand@127.0.0.1:${port}/postgres`,
});
const pgBin = process.env.IFM_PG_BIN || "/Library/PostgreSQL/18/bin";
const duration = Number(process.env.IFM_STAND_SECONDS || 120);
if (!Number.isInteger(duration) || duration < 10 || duration > 600)
  throw new Error("IFM_STAND_SECONDS must be 10..600");
await admin.query(`CREATE DATABASE "${database}"`);
await admin.query(`CREATE DATABASE "${restore}"`);
const url = `postgresql://ifm_stand@127.0.0.1:${port}/${database}`;
const config = {
  databaseProvider: "postgres",
  databaseUrl: url,
  databasePoolSize: 10,
  port: 0,
  publicUrl: "http://127.0.0.1:5196",
  displayBaseUrl: "http://127.0.0.1:5196",
  appwriteEndpoint: "",
  appwriteProjectId: "",
  appwriteApiKey: "",
  appwriteSelfSigned: false,
  appwriteDatabaseId: "stand",
  appwriteBucketId: "assets",
  sessionSecret: randomBytes(40).toString("hex"),
  hubAccessKey: randomBytes(40).toString("hex"),
  corsOrigins: ["http://127.0.0.1:5196"],
};
const schema = new Pool({ connectionString: url });
await ensurePostgresSchema(schema);
await schema.end();
const s = await createPostgresServices(config);
await bootstrapVkr(s, config);
const server = createServer(createApp(config, s));
await new Promise((r) => server.listen(8096, "127.0.0.1", r));
const base = "http://127.0.0.1:8096/api";
const now = new Date().toISOString(),
  databaseId = "stand";
const put = (tableId, rowId, data) =>
  s.tables.createRow({ databaseId, tableId, rowId, data });
const ownerPassword = "stand-owner-test-password";
await put("operators", "owner", {
  username: "owner",
  passwordHash: await hash(ownerPassword),
  platformAdmin: true,
  active: true,
  sessionVersion: 1,
  createdAt: now,
});
for (const id of ["org-a", "org-b"])
  await put("organizations", id, {
    name: id === "org-a" ? "Оператор А" : "Оператор Б",
    createdAt: now,
  });
for (const [id, org, code] of [
  ["venue-a", "org-a", "stand-a"],
  ["venue-b", "org-b", "stand-b"],
]) {
  await put("venues", id, {
    organizationId: org,
    name: id === "venue-a" ? "Стендовая столовая А" : "Стендовая кофейня Б",
    code,
    pinHash: await hashSecret("123456"),
    currency: "RUB",
    backgroundColor: "#56965B",
    accentColor: "#FFFFFF",
    pageDurationSeconds: 10,
    displayScalePercent: 100,
    staffVersion: 1,
    displayVersion: 1,
    menuVersion: 1,
    active: true,
    updatedAt: now,
    updatedBy: "stand",
  });
  await put("categories", `${id}-cat`, {
    venueId: id,
    name: "Синтетическое меню",
    sortOrder: 0,
    updatedAt: now,
    updatedBy: "stand",
  });
  for (let i = 0; i < 50; i++)
    await put("items", `${id}-item-${i}`, {
      venueId: id,
      categoryId: `${id}-cat`,
      name: `Блюдо ${i + 1}`,
      priceMinor: 10000 + i * 100,
      stockQuantity: 100,
      isAvailable: true,
      sortOrder: i,
      updatedAt: now,
      updatedBy: "stand",
    });
}
const auth = signSession(
  { role: "hub", accountId: "owner", accountVersion: 1, authType: "personal" },
  config.sessionSecret,
);
const staff = signSession(
  { role: "staff", venueId: "venue-a", version: 1 },
  config.sessionSecret,
);
await put("display_tokens", "stand-display", {
  venueId: "venue-a",
  tokenHash: await hashSecret("stand-display-secret"),
  active: true,
  createdAt: now,
});
const screen = signSession(
  {
    role: "display",
    venueId: "venue-a",
    version: 1,
    displayTokenId: "stand-display",
  },
  config.sessionSecret,
);
const api = (p, options = {}, token = auth) =>
  fetch(base + p, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
const sourceHash = createHash("sha256");
for (const dir of ["backend-api/src", "web-display/src"]) {
  for (const file of (await readdir(path.join(root, dir)))
    .filter((f) => /\.(ts|tsx|css)$/.test(f))
    .sort()) {
    sourceHash.update(dir + "/" + file);
    sourceHash.update(await readFile(path.join(root, dir, file)));
  }
}
const result = {
  softwareFingerprint: sourceHash.digest("hex"),
  date: new Date().toISOString(),
  software: "local working tree",
  node: process.version,
  postgres: (await s.pool.query("SHOW server_version")).rows[0].server_version,
  host: {
    os: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    ramBytes: os.totalmem(),
  },
  scope:
    "Local synthetic stand; PostgreSQL; one API process; HTTP loopback; not a real pilot",
  configuration: {
    organizations: 2,
    venues: 2,
    menuItems: 100,
    concurrency: 20,
    durationSeconds: duration,
    limits: { readP95Ms: 2000, errors: 0, deliveryP95Ms: 10000 },
  },
  checks: {},
};
try {
  // A modest operation sample provides a reproducible baseline without real shift claims.
  const operationTimes = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    const r = await api(
      "/items/venue-a-item-0/stock/adjust",
      { method: "POST", body: JSON.stringify({ delta: i % 2 ? -1 : 1 }) },
      staff,
    );
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    operationTimes.push(performance.now() - start);
  }
  const streamController = new AbortController();
  const stream = await fetch(base + "/menu/events", {
    headers: { authorization: `Bearer ${screen}` },
    signal: streamController.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  let buffer = "";
  const nextEvent = async () => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (line) return JSON.parse(line.slice(6));
      } else {
        const part = await reader.read();
        if (part.done) throw new Error("SSE ended");
        buffer += new TextDecoder().decode(part.value);
      }
    }
  };
  await nextEvent();
  const delivery = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const r = await api(
      "/items/venue-a-item-0/stock/adjust",
      { method: "POST", body: JSON.stringify({ delta: i % 2 ? -1 : 1 }) },
      staff,
    );
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    await Promise.race([
      nextEvent(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("SSE timeout")), 10000);
        timer.unref();
      }),
    ]);
    delivery.push(performance.now() - start);
  }
  streamController.abort();
  await reader.cancel().catch(() => undefined);
  const feedbackStart = performance.now();
  const created = await api(
    "/public/venues/stand-a/reviews",
    {
      method: "POST",
      body: JSON.stringify({
        category: "service",
        message: "Синтетический отзыв для протокола",
      }),
    },
    "",
  );
  assert.equal(created.status, 201);
  const feedback = await created.json();
  const inProgress = await api(`/hub/reviews/${feedback.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      version: 1,
      status: "in_progress",
      category: "information",
      comment: "Информация уточнена на стенде",
    }),
  });
  assert.equal(inProgress.status, 200);
  const closed = await api(`/hub/reviews/${feedback.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      version: 2,
      status: "closed",
      category: "information",
      comment: "Результат проверен на синтетическом сценарии",
    }),
  });
  assert.equal(closed.status, 200);
  const csv = await api("/hub/reports/feedback.csv");
  assert.equal(csv.status, 200);
  await writeFile(path.join(out, "feedback-report.csv"), await csv.text());
  const quantile = (a, p) =>
    [...a].sort((a, b) => a - b)[Math.max(0, Math.ceil(a.length * p) - 1)] || 0;
  result.checks.operations = {
    sample: 30,
    p50Ms: quantile(operationTimes, 0.5),
    p95Ms: quantile(operationTimes, 0.95),
  };
  result.checks.sse = {
    sample: 10,
    p95Ms: quantile(delivery, 0.95),
    passed: quantile(delivery, 0.95) < 10000,
  };
  result.checks.feedback = {
    created: true,
    classified: true,
    closed: true,
    exported: true,
    workflowMs: performance.now() - feedbackStart,
  };
  console.log("STAND: load started");
  const timings = [],
    errors = [];
  let count = 0;
  const started = performance.now(),
    cpu = process.cpuUsage();
  const rss = [];
  const stopAt = started + duration * 1000;
  await Promise.all(
    Array.from({ length: 20 }, (_, client) =>
      (async () => {
        while (performance.now() < stopAt) {
          const start = performance.now();
          try {
            const path = client < 16 ? "/menu" : "/hub/reports/feedback";
            const r = await api(path, {}, client < 16 ? screen : auth);
            await r.arrayBuffer();
            if (r.status !== 200) errors.push({ status: r.status, path });
          } catch (e) {
            errors.push({ message: e.message });
          }
          timings.push(performance.now() - start);
          count++;
          if (count % 100 === 0) rss.push(process.memoryUsage().rss);
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
    ),
  );
  const elapsed = performance.now() - started;
  result.checks.load = {
    requests: count,
    errors: errors.length,
    errorExamples: errors.slice(0, 10),
    elapsedMs: elapsed,
    rps: count / (elapsed / 1000),
    p50Ms: quantile(timings, 0.5),
    p95Ms: quantile(timings, 0.95),
    p99Ms: quantile(timings, 0.99),
    apiMaxRssBytes: Math.max(...rss),
    apiCpuMicroseconds: process.cpuUsage(cpu),
    passed: !errors.length && quantile(timings, 0.95) < 2000,
  };
  // Quiesce writes, restore into a separate empty DB, compare all tables and files.
  console.log("STAND: backup and restore started");
  const dump = path.join(os.tmpdir(), `${database}.dump`);
  const backupStart = performance.now();
  execFileSync(path.join(pgBin, "pg_dump"), ["-Fc", "-f", dump, url]);
  const backupMs = performance.now() - backupStart;
  const restoreStart = performance.now();
  execFileSync(path.join(pgBin, "pg_restore"), [
    "--exit-on-error",
    "-d",
    `postgresql://ifm_stand@127.0.0.1:${port}/${restore}`,
    dump,
  ]);
  const restoreMs = performance.now() - restoreStart;
  const restoredPool = new Pool({
    connectionString: `postgresql://ifm_stand@127.0.0.1:${port}/${restore}`,
  });
  const checks = [];
  for (const table of [...TABLES.map((t) => t.id), "assets"]) {
    const order = table === "assets" ? "id" : '"$id"';
    const sql = `SELECT * FROM ifm."${table}" ORDER BY ${order}`;
    const before = (await s.pool.query(sql)).rows,
      after = (await restoredPool.query(sql)).rows;
    const digest = (rows) =>
      createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    checks.push({
      table,
      rows: before.length,
      sourceSha256: digest(before),
      restoredSha256: digest(after),
      equal: digest(before) === digest(after),
    });
  }
  await restoredPool.end();
  const restoredService = await createPostgresServices({
    ...config,
    databaseUrl: `postgresql://ifm_stand@127.0.0.1:${port}/${restore}`,
  });
  const restoredServer = createServer(createApp(config, restoredService));
  await new Promise((r) => restoredServer.listen(0, "127.0.0.1", r));
  const restoredPort = restoredServer.address().port;
  const ready = await fetch(`http://127.0.0.1:${restoredPort}/ready`);
  const menu = await fetch(`http://127.0.0.1:${restoredPort}/api/menu`, {
    headers: { authorization: `Bearer ${screen}` },
  });
  const account = await fetch(
    `http://127.0.0.1:${restoredPort}/api/hub/login/password`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: ownerPassword }),
    },
  );
  const recovered =
    ready.status === 200 && menu.status === 200 && account.status === 200;
  await ready.arrayBuffer();
  await menu.arrayBuffer();
  await account.arrayBuffer();
  await new Promise((r) => restoredServer.close(r));
  await restoredService.close();
  result.checks.restore = {
    backupMs,
    restoreMs,
    rtoMeasuredMs: performance.now() - restoreStart,
    rpo: "0 writes lost in quiesced synthetic fixture",
    tables: checks,
    application: {
      ready: ready.status,
      menu: menu.status,
      passwordLogin: account.status,
    },
    passed: recovered && checks.every((c) => c.equal),
  };
  result.passed =
    result.checks.load.passed &&
    result.checks.sse.passed &&
    result.checks.restore.passed;
  await writeFile(
    path.join(out, "results.json"),
    JSON.stringify(result, null, 2),
  );
  await writeFile(
    path.join(out, "latencies.csv"),
    "request,durationMs\n" +
      timings.map((ms, i) => `${i + 1},${ms.toFixed(3)}`).join("\n"),
  );
  console.log(
    JSON.stringify({
      passed: result.passed,
      requests: count,
      p95Ms: result.checks.load.p95Ms,
      restorePassed: result.checks.restore.passed,
      output: out,
    }),
  );
  if (process.argv.includes("--serve")) {
    console.log(
      "STAND: browser review available at API 8096; synthetic login owner / stand-owner-test-password",
    );
    await new Promise((r) => {
      process.once("SIGINT", r);
      process.once("SIGTERM", r);
    });
  }
  if (!result.passed) process.exitCode = 1;
} finally {
  await new Promise((r) => server.close(r));
  await s.close();
  await admin.query(`DROP DATABASE "${restore}" WITH (FORCE)`);
  await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
}
