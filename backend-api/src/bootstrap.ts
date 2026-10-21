import { Pool } from "pg";
import { createAppwriteServices } from "./appwrite.js";
import { loadConfig } from "./config.js";
import { ensureSchema } from "./schema.js";
import { ensurePostgresSchema } from "./postgres.js";
const config = loadConfig();
if (config.databaseProvider === "postgres") {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try { await ensurePostgresSchema(pool); console.log("PostgreSQL schema ready"); } finally { await pool.end(); }
} else console.log(JSON.stringify(await ensureSchema(createAppwriteServices(config), config), null, 2));
