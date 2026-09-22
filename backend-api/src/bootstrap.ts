import { createAppwriteServices } from "./appwrite.js";
import { loadConfig } from "./config.js";
import { ensureSchema } from "./schema.js";

const config = loadConfig();
const result = await ensureSchema(createAppwriteServices(config), config);
console.log(JSON.stringify(result, null, 2));
