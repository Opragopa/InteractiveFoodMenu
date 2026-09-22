import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createAppwriteServices } from "./appwrite.js";
import { loadConfig } from "./config.js";
import { ApiError, createApiRouter } from "./routes.js";
import { TABLES } from "./schema.js";

const config = loadConfig();
const services = createAppwriteServices(config);
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
    else callback(new ApiError(403, "origin_not_allowed", "Источник запроса не разрешён."));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "interactive-food-menu-api" });
});

app.get("/ready", async (_request, response) => {
  try {
    await Promise.all([
      services.tables.get({ databaseId: config.appwriteDatabaseId }),
      ...TABLES.map(table => services.tables.getTable({ databaseId: config.appwriteDatabaseId, tableId: table.id })),
      services.storage.getBucket({ bucketId: config.appwriteBucketId }),
    ]);
    response.json({ status: "ready", datastore: "appwrite" });
  } catch (error) {
    console.error("Appwrite readiness check failed", error);
    response.status(503).json({ status: "not-ready", datastore: "appwrite" });
  }
});

app.use("/api", createApiRouter(services, config));

app.use((_request, response) => {
  response.status(404).json({ error: "not_found" });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  console.error("Unhandled API error", error);
  response.status(500).json({ error: "internal_error" });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Backend API listening on port ${config.port}`);
});
