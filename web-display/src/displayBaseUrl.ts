type DisplayLocation = Pick<Location, "hostname" | "origin" | "port" | "protocol">;

export type DisplayUrlConfig = {
  configuredBaseUrl?: string;
  useEmulators: boolean;
  emulatorHost?: string;
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
 * Chooses the address that a second device can open. In emulator mode the
 * configured LAN host replaces a local browser hostname while keeping the
 * actual hosting/Vite port.
 */
export function resolveDisplayBaseUrl(config: DisplayUrlConfig): string {
  if (config.configuredBaseUrl?.trim()) return asOrigin(config.configuredBaseUrl);
  const host = config.emulatorHost?.trim();
  if (config.useEmulators && host && !isLoopback(host)) {
    const port = config.location.port ? `:${config.location.port}` : "";
    return `${config.location.protocol}//${host}${port}`;
  }
  if (isLoopback(config.location.hostname)) {
    throw new Error("Откройте экран по адресу локальной сети или задайте VITE_DISPLAY_BASE_URL.");
  }
  return config.location.origin;
}

export function currentDisplayBaseUrl(): string {
  return resolveDisplayBaseUrl({
    configuredBaseUrl: import.meta.env.VITE_DISPLAY_BASE_URL,
    useEmulators: import.meta.env.VITE_USE_EMULATORS === "true",
    emulatorHost: import.meta.env.VITE_FIREBASE_EMULATOR_HOST,
    location: window.location,
  });
}
