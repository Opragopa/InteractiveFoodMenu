export type BackendConfig = {
  port: number;
  publicUrl: string;
  displayBaseUrl: string;
  appwriteEndpoint: string;
  appwriteProjectId: string;
  appwriteApiKey: string;
  appwriteDatabaseId: string;
  appwriteBucketId: string;
  sessionSecret: string;
  hubAccessKey: string;
  corsOrigins: string[];
};

function required(name: string, minimumLength = 1) {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < minimumLength) throw new Error(`${name} is required${minimumLength > 1 ? ` and must contain at least ${minimumLength} characters` : ""}.`);
  return value;
}

export function loadConfig(): BackendConfig {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  return {
    port,
    publicUrl: required("PUBLIC_URL").replace(/\/$/, ""),
    displayBaseUrl: required("DISPLAY_BASE_URL").replace(/\/$/, ""),
    appwriteEndpoint: required("APPWRITE_ENDPOINT").replace(/\/$/, ""),
    appwriteProjectId: required("APPWRITE_PROJECT_ID"),
    appwriteApiKey: required("APPWRITE_API_KEY", 20),
    appwriteDatabaseId: process.env.APPWRITE_DATABASE_ID?.trim() || "interactive-food-menu",
    appwriteBucketId: process.env.APPWRITE_BUCKET_ID?.trim() || "venue-assets",
    sessionSecret: required("BACKEND_SESSION_SECRET", 32),
    hubAccessKey: required("BACKEND_HUB_ACCESS_KEY", 24),
    corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean),
  };
}
