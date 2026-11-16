import { Pool } from "pg";
import { createAppwriteServices, createServices } from "./appwrite.js";
import { bootstrapVkr } from "./vkrAccess.js";
import { loadConfig } from "./config.js";
import { ensureSchema } from "./schema.js";
import { ensurePostgresSchema } from "./postgres.js";
const config = loadConfig();
if (config.databaseProvider === "postgres") {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try { await ensurePostgresSchema(pool); console.log("PostgreSQL schema ready"); } finally { await pool.end(); }
} else console.log(JSON.stringify(await ensureSchema(createAppwriteServices(config), config), null, 2));
const services = await createServices(config);
try { await bootstrapVkr(services, config); } finally { await services.close?.(); }
