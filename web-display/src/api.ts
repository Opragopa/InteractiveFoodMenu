const baseUrl = (import.meta.env.VITE_BACKEND_API_URL ?? `${window.location.origin}/api`).replace(/\/$/, "");

export type ApiSession = { token: string; venueId: string };

export class ApiRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
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
  menu: (token: string) => request<{ venue: any; categories: any[]; items: any[] }>("/menu", {}, token),
  updateVenue: (token: string, data: unknown) => request<{ venue: any }>("/venue", { method: "PATCH", body: JSON.stringify(data) }, token),
  createCategory: (token: string, data: unknown) => request<{ category: any }>("/categories", { method: "POST", body: JSON.stringify(data) }, token),
  deleteCategory: (token: string, id: string) => request<void>(`/categories/${id}`, { method: "DELETE" }, token),
  createItem: (token: string, data: unknown) => request<{ item: any }>("/items", { method: "POST", body: JSON.stringify(data) }, token),
  updateItem: (token: string, id: string, data: unknown) => request<{ item: any }>(`/items/${id}`, { method: "PATCH", body: JSON.stringify(data) }, token),
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
  hubRevoke: (token: string, id: string) => request<any>(`/hub/venues/${id}/revoke`, { method: "POST" }, token),
  hubDeleteVenue: (token: string, id: string) => request<void>(`/hub/venues/${id}`, { method: "DELETE" }, token),
};
