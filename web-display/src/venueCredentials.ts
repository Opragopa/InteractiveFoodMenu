export type VenueCredentials = { code: string; pin: string };

const codeKey = "interactive-food-menu.venue-code";
const pinKey = "interactive-food-menu.venue-pin";

function read(storage: Storage, key: string): string {
  try { return storage.getItem(key) ?? ""; } catch { return ""; }
}

export function savedVenueCredentials(): VenueCredentials {
  return { code: read(localStorage, codeKey), pin: read(sessionStorage, pinKey) };
}

/** The PIN intentionally survives reloads but not closing the browser. */
export function saveVenueCredentials(code: string, pin: string) {
  try { localStorage.setItem(codeKey, code.trim().toLowerCase()); } catch { /* storage can be disabled on TV browsers */ }
  try { sessionStorage.setItem(pinKey, pin); } catch { /* storage can be disabled on TV browsers */ }
}

export function forgetVenueCredentials() {
  try { localStorage.removeItem(codeKey); } catch { /* ignore unavailable storage */ }
  try { sessionStorage.removeItem(pinKey); } catch { /* ignore unavailable storage */ }
}
