import type { MenuItem } from "./types";

const baseUrl = (import.meta.env.VITE_BACKEND_API_URL ?? `${window.location.origin}/api`).replace(/\/$/, "");

export type ApiSession = { token: string; venueId: string };
export type BulkAvailabilityResponse = { updatedCount: number; items: MenuItem[]; menuVersion: number };

export class ApiRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

function requestWithXhr<T>(url: string, options: RequestInit): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? "GET", url, true);
    const headers = options.headers as Record<string, string> | undefined;
    Object.keys(headers ?? {}).forEach((name) => xhr.setRequestHeader(name, headers?.[name] ?? ""));
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 204) {
        resolve(undefined as T);
        return;
      }
      let data: { message?: string } & T = {} as { message?: string } & T;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : data; } catch { /* keep the generic error */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiRequestError(data.message ?? "Сервер не выполнил запрос.", xhr.status));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new ApiRequestError("Не удалось подключиться к серверу.", 0));
    xhr.send(typeof options.body === "string" ? options.body : null);
  });
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const requestOptions: RequestInit = {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  };
  const url = `${baseUrl}${path}`;
  // Older NetCast/Tizen browsers expose XMLHttpRequest but not fetch.
  // Keeping the fallback here makes every route (including the display hash)
  // usable instead of relying only on the connect-page redirect.
  if (typeof fetch !== "function") return requestWithXhr<T>(url, requestOptions);
  const response = await fetch(url, requestOptions);
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({})) as { message?: string } & T;
  if (!response.ok) throw new ApiRequestError(data.message ?? "Сервер не выполнил запрос.", response.status);
  return data;
}

function logoContentBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл логотипа."));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const contentBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      contentBase64 ? resolve(contentBase64) : reject(new Error("Не удалось прочитать файл логотипа."));
    };
    reader.readAsDataURL(file);
  });
}

export const api = {
  staffLogin: (venueCode: string, pin: string) => request<ApiSession>("/auth/staff", { method: "POST", body: JSON.stringify({ venueCode, pin }) }),
  displayLogin: (tokenId: string, secret: string) => request<ApiSession>("/auth/display", { method: "POST", body: JSON.stringify({ tokenId, secret }) }),
  menu: (token: string) => request<{ venue: any; categories: any[]; items: any[] }>(`/menu?ts=${Date.now()}`, {}, token),
  menuVersion: (token: string) => request<{ version: number; refreshSeconds: number }>(`/menu/version?ts=${Date.now()}`, {}, token),
  startBreak: (token: string, durationMinutes: number) => request<{ venue: any }>("/venue/break/start", { method: "POST", body: JSON.stringify({ durationMinutes }) }, token),
  stopBreak: (token: string) => request<{ venue: any }>("/venue/break/stop", { method: "POST" }, token),
  updateVenue: (token: string, data: unknown) => request<{ venue: any }>("/venue", { method: "PATCH", body: JSON.stringify(data) }, token),
  createCategory: (token: string, data: unknown) => request<{ category: any }>("/categories", { method: "POST", body: JSON.stringify(data) }, token),
  deleteCategory: (token: string, id: string) => request<void>(`/categories/${id}`, { method: "DELETE" }, token),
  createItem: (token: string, data: unknown) => request<{ item: any }>("/items", { method: "POST", body: JSON.stringify(data) }, token),
  updateItem: (token: string, id: string, data: unknown) => request<{ item: any }>(`/items/${id}`, { method: "PATCH", body: JSON.stringify(data) }, token),
  updateItemsAvailability: (token: string, itemIds: string[], isAvailable: boolean) => request<BulkAvailabilityResponse>("/items/bulk-availability", { method: "PATCH", body: JSON.stringify({ itemIds, isAvailable }) }, token),
  deleteItem: (token: string, id: string) => request<void>(`/items/${id}`, { method: "DELETE" }, token),
  createPairing: () => request<{ pairingToken: string; displayBaseUrl: string; expiresInSeconds: number }>("/display/pairings", { method: "POST" }),
  completePairing: (pairingToken: string, venueCode: string, pin: string) => request<{ displayUrl: string }>("/display/pairings/complete", { method: "POST", body: JSON.stringify({ pairingToken, venueCode, pin }) }),
  pairingStatus: (pairingToken: string) => {
    const [id, secret] = pairingToken.split(".");
    return request<{ status: string; displayUrl?: string | null }>(`/display/pairings/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret ?? "")}`);
  },
  clientLog: (token: string, level: string, message: string, details: unknown) => request<void>("/client-logs", { method: "POST", body: JSON.stringify({ level, message, details }) }, token),
  hubLogin: (accessKey: string) => request<{ token: string }>("/hub/login", { method: "POST", body: JSON.stringify({ accessKey }) }),
  hubOverview: (token: string) => request<any>("/hub/overview", {}, token),
  hubCreateVenue: (token: string, data: { name: string; venueCode: string; pin: string }) => request<any>("/hub/venues", { method: "POST", body: JSON.stringify({ name: data.name, code: data.venueCode, pin: data.pin }) }, token),
  hubUpdateVenue: (token: string, id: string, data: unknown) => request<{ venue: any }>(`/hub/venues/${id}`, { method: "PATCH", body: JSON.stringify(data) }, token),
  hubUploadVenueLogo: async (token: string, id: string, file: File) => request<{ venue: any }>(`/hub/venues/${id}/logo`, { method: "POST", body: JSON.stringify({ name: file.name, mimeType: file.type, contentBase64: await logoContentBase64(file) }) }, token),
  venueAssetUrl: (fileId: string) => `${baseUrl}/venue-assets/${encodeURIComponent(fileId)}`,
  hubRotatePin: (token: string, id: string, venueCode: string, pin: string) => request<any>(`/hub/venues/${id}/access`, { method: "PATCH", body: JSON.stringify({ venueCode, pin }) }, token),
  hubCreateDisplayLink: (token: string, id: string) => request<{ displayUrl: string }>(`/hub/venues/${id}/display`, { method: "POST" }, token),
  hubRevoke: (token: string, id: string) => request<any>(`/hub/venues/${id}/revoke`, { method: "POST" }, token),
  hubDisplays: (token: string, id: string) => request<{ displays: any[] }>(`/hub/venues/${id}/displays`, {}, token),
  hubUpdateDisplay: (token: string, id: string, tokenId: string, label: string) => request<any>(`/hub/venues/${id}/displays/${tokenId}`, { method: "PATCH", body: JSON.stringify({ label }) }, token),
  hubRevokeDisplay: (token: string, id: string, tokenId: string) => request<any>(`/hub/venues/${id}/displays/${tokenId}/revoke`, { method: "POST" }, token),
  hubRevokeAllDisplays: (token: string, id: string) => request<any>(`/hub/venues/${id}/displays/revoke-all`, { method: "POST" }, token),
  hubDeleteVenue: (token: string, id: string) => request<void>(`/hub/venues/${id}`, { method: "DELETE" }, token),
};
