import { getApp } from "firebase-admin/app";

function isHttpUrl(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:";
}

/** Normalizes an externally reachable display origin supplied by a client. */
export function normalizeDisplayBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Адрес экрана должен быть корректным URL.");
  }
  if (!isHttpUrl(url) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Адрес экрана должен содержать только http(s)-адрес без пути.");
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
    throw new Error("127.0.0.1 и localhost нельзя использовать для QR-кода: укажите адрес локальной сети.");
  }
  return url.origin;
}

function configuredProjectId(): string | undefined {
  const configured = getApp().options.projectId ?? process.env.GCLOUD_PROJECT;
  if (configured) return configured;
  const firebaseConfig = process.env.FIREBASE_CONFIG;
  if (!firebaseConfig) return undefined;
  return JSON.parse(firebaseConfig).projectId as string | undefined;
}

/**
 * Returns the public URL opened by TVs and phones. Never use a localhost
 * fallback: it would point at the TV itself, not Hosting.
 */
export function displayBaseUrl(): string {
  const configured = process.env.DISPLAY_BASE_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (!isHttpUrl(url)) throw new Error("DISPLAY_BASE_URL должен начинаться с http:// или https://.");
    return url.origin;
  }
  const projectId = configuredProjectId();
  if (!projectId) throw new Error("Не удалось определить Firebase project ID. Задайте DISPLAY_BASE_URL.");
  return `https://${projectId}.web.app`;
}

export function displayUrl(tokenId: string, secret: string, baseUrl = displayBaseUrl()): string {
  if (process.env.DISPLAY_RENDERER?.trim().toLowerCase() === "server") {
    return `${baseUrl}/display/${tokenId}.${secret}`;
  }
  return `${baseUrl}/#${tokenId}.${secret}`;
}
