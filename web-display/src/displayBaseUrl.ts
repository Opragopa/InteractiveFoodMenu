type DisplayLocation = Pick<Location, "hostname" | "origin" | "port" | "protocol">;

export type DisplayUrlConfig = {
  configuredBaseUrl?: string;
  location: DisplayLocation;
};

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function asOrigin(value: string): string {
  const url = new URL(value.trim());
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("VITE_DISPLAY_BASE_URL должен быть http(s)-адресом без пути.");
  }
  if (isLoopback(url.hostname)) throw new Error("Для QR-кода укажите адрес локальной сети вместо 127.0.0.1.");
  return url.origin;
}

/**
 * Chooses the address that a second device can open.
 */
export function resolveDisplayBaseUrl(config: DisplayUrlConfig): string {
  if (config.configuredBaseUrl?.trim()) return asOrigin(config.configuredBaseUrl);
  if (isLoopback(config.location.hostname)) {
    throw new Error("Откройте экран по адресу локальной сети или задайте VITE_DISPLAY_BASE_URL.");
  }
  return config.location.origin;
}

export function currentDisplayBaseUrl(): string {
  return resolveDisplayBaseUrl({
    configuredBaseUrl: import.meta.env.VITE_DISPLAY_BASE_URL,
    location: window.location,
  });
}
