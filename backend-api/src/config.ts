export type BackendConfig = {
  databaseProvider?: "appwrite" | "postgres";
  databaseUrl?: string;
  databasePoolSize?: number;
  port: number;
  publicUrl: string;
  displayBaseUrl: string;
  appwriteEndpoint: string;
  appwriteSelfSigned: boolean;
  appwriteProjectId: string;
  appwriteApiKey: string;
  appwriteDatabaseId: string;
  appwriteBucketId: string;
  sessionSecret: string;
  hubAccessKey: string;
  corsOrigins: string[];
  redisUrl?: string;
  legacyStaffPinEnabled?: boolean;
};

function required(name: string, minimumLength = 1) {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < minimumLength) throw new Error(`${name} is required${minimumLength > 1 ? ` and must contain at least ${minimumLength} characters` : ""}.`);
  return value;
}

export function loadConfig(): BackendConfig {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  const databaseProvider = process.env.DATABASE_PROVIDER || "appwrite";
  if (!["appwrite", "postgres"].includes(databaseProvider)) throw new Error("Invalid DATABASE_PROVIDER");
  const databasePoolSize = Number(process.env.DATABASE_POOL_SIZE || 10);
  if (!Number.isInteger(databasePoolSize) || databasePoolSize < 2 || databasePoolSize > 100) throw new Error("Invalid DATABASE_POOL_SIZE");
  return {
    databaseProvider: databaseProvider as "appwrite" | "postgres",
    databaseUrl: databaseProvider === "postgres" ? required("DATABASE_URL") : undefined,
    databasePoolSize,
    port,
    publicUrl: required("PUBLIC_URL").replace(/\/$/, ""),
    displayBaseUrl: required("DISPLAY_BASE_URL").replace(/\/$/, ""),
    appwriteEndpoint: (databaseProvider === "appwrite" ? required("APPWRITE_ENDPOINT") : "").replace(/\/$/, ""),
    appwriteSelfSigned: process.env.APPWRITE_SELF_SIGNED === "true",
    appwriteProjectId: (databaseProvider === "appwrite" ? required("APPWRITE_PROJECT_ID") : ""),
    appwriteApiKey: (databaseProvider === "appwrite" ? required("APPWRITE_API_KEY", 20) : ""),
    appwriteDatabaseId: process.env.APPWRITE_DATABASE_ID?.trim() || "interactive-food-menu",
    appwriteBucketId: process.env.APPWRITE_BUCKET_ID?.trim() || "venue-assets",
    sessionSecret: required("BACKEND_SESSION_SECRET", 32),
    hubAccessKey: required("BACKEND_HUB_ACCESS_KEY", 24),
    corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean),
    redisUrl: required("REDIS_URL"),
    legacyStaffPinEnabled: process.env.ALLOW_LEGACY_STAFF_PIN !== "false",
  };
}
