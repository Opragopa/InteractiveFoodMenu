import cors from "cors";
import express from "express";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { createAppwriteServices, type AppwriteServices } from "./appwrite.js";
import { loadConfig, type BackendConfig } from "./config.js";
import { ApiError, createApiRouter } from "./routes.js";
import { consumeRateLimit, pruneRateLimitBuckets } from "./rateLimit.js";
import { TABLES } from "./schema.js";
import { randomUUID } from "node:crypto";
import { createTvRouter } from "./tvRoutes.js";
import { accountError, accountGuard, createAccountRouter } from "./accountRoutes.js";
import { createAuthLimiter } from "./sharedRateLimit.js";
import { instrumentAppwrite, requestMetrics } from "./requestMetrics.js";

export function createApp(config: BackendConfig, services: AppwriteServices) {
  const app = express();
  services = instrumentAppwrite(services);
  const authLimiter = createAuthLimiter(config.redisUrl);

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new ApiError(403, "origin_not_allowed", "Источник запроса не разрешён."));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }));
  app.use(express.json({ limit: "8mb" }));
  app.use((request, response, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    response.setHeader("X-Request-Id", requestId);
    requestMetrics.run({ appwriteCalls: 0, appwriteDurationMs: 0 }, () => {
      response.on("finish", () => {
        if (request.path === "/health" || request.path === "/ready") return;
        const metrics = requestMetrics.getStore();
        console.log(JSON.stringify({ event: "http_request", requestId, method: request.method,
          route: request.route?.path ? `${request.baseUrl}${request.route.path}` : (response.statusCode === 404 ? "unmatched" : "middleware"),
          status: response.statusCode, durationMs: Math.round(performance.now() - started),
          appwriteCalls: metrics?.appwriteCalls ?? 0, appwriteDurationMs: Math.round(metrics?.appwriteDurationMs ?? 0) }));
      });
      next();
    });
  });
  const limitAuthAttempts = (scope: string) => (request: express.Request, response: express.Response, next: express.NextFunction) => {
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    const canonical = (value: unknown) => String(value ?? "").trim().toLowerCase();
    // Match the normalization used by the login handlers. PIN login has no
    // username; an arbitrary extra field must not create a new limit bucket.
    const personalStaffLogin = request.route?.path === "/api/auth/staff/password";
    const identity = scope === "staff"
      ? `${canonical(request.body?.venueCode)}:${personalStaffLogin ? canonical(request.body?.username) : ""}`
      : scope === "hub" ? canonical(request.body?.username) : undefined;
    void authLimiter.check(scope, ip, identity).then(result => {
      if (!result.allowed) { response.setHeader("Retry-After", String(result.retryAfterSeconds)); next(new ApiError(429, "rate_limited", "Слишком много попыток. Повторите позже.")); }
      else next();
    }, () => next(new ApiError(503, "auth_unavailable", "Вход временно недоступен.")));
  };
  app.post("/api/auth/staff", limitAuthAttempts("staff"));
  app.post("/api/auth/staff/password", limitAuthAttempts("staff"));
  app.post("/api/auth/staff/activate", limitAuthAttempts("staff-activate"));
  app.post("/api/hub/login", limitAuthAttempts("hub"));
  app.post("/api/hub/login/password", limitAuthAttempts("hub"));
  app.post("/api/display/pairings", limitAuthAttempts("display-pairing-create"));
  app.post("/api/display/pairings/complete", limitAuthAttempts("display-pairing"));
  app.post("/tv/session", limitAuthAttempts("tv-session"));
  app.get("/tv/connect", limitAuthAttempts("tv-pairing-create"));

  app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "interactive-food-menu-api" });
  });

  app.get("/ready", async (_request, response) => {
  try {
    if (!(await authLimiter.healthy())) throw new Error("auth_limiter_unavailable");
    await Promise.all([
      services.tables.get({ databaseId: config.appwriteDatabaseId }),
      ...TABLES.map(table => services.tables.getTable({ databaseId: config.appwriteDatabaseId, tableId: table.id })),
      services.storage.getBucket({ bucketId: config.appwriteBucketId }),
    ]);
    response.json({ status: "ready", datastore: "appwrite" });
  } catch (error) {
    console.error(JSON.stringify({ event: "readiness_failed", kind: error instanceof Error ? error.name : "unknown" }));
    response.status(503).json({ status: "not-ready", datastore: "appwrite" });
  }
  });

  app.use("/api", accountGuard(services, config));
  app.use("/api", accountError);
  app.use("/api", createAccountRouter(services, config));
  app.use("/api", createApiRouter(services, config));
  app.use("/tv", createTvRouter(services, config));

  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error(JSON.stringify({ event: "api_error", kind: error instanceof Error ? error.name : "unknown" }));
    response.status(500).json({ error: "internal_error" });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const services = createAppwriteServices(config);
  createApp(config, services).listen(config.port, "0.0.0.0", () => {
    console.log(`Backend API listening on port ${config.port}`);
  });
}
